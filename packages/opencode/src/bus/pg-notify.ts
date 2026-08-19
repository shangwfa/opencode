import { Flag } from "@opencode-ai/core/flag/flag"
import postgres from "postgres"

const log = {
  info(msg: string, data?: Record<string, unknown>) { console.info(`[pg-notify] ${msg}`, data ?? "") },
  warn(msg: string, data?: Record<string, unknown>) { console.warn(`[pg-notify] ${msg}`, data ?? "") },
  error(msg: string, data?: Record<string, unknown>) { console.error(`[pg-notify] ${msg}`, data ?? "") },
}

const CHANNEL = "opencode_event"

export namespace PgNotify {
  const callbacks = new Set<(event: any) => void | Promise<void>>()
  let listener: any = null
  let started = false
  let abort: AbortController | null = null

  // Dedicated connection for LISTEN: the shared Database pool recycles idle
  // connections (idle_timeout 30s / max_lifetime 600s), which silently kills
  // the listener. This connection must never be recycled.
  let notifyClient: any = null
  function getClient() {
    if (!notifyClient) {
      notifyClient = postgres(Flag.OPENCODE_DATABASE_URL!, {
        max: 1,
        idle_timeout: null,
        max_lifetime: null,
        connect_timeout: 10,
      } as any)
    }
    return notifyClient
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve()
      const timer = setTimeout(resolve, ms)
      signal?.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
    })
  }

  function jitter(base: number) {
    return base + Math.floor(Math.random() * base * 0.2)
  }

  function handler(payload: string) {
    let event: any
    try {
      event = JSON.parse(payload)
    } catch (e) {
      log.error("failed to parse PG NOTIFY payload", { error: e instanceof Error ? e.message : String(e) })
      return
    }
    for (const cb of callbacks) {
      try {
        Promise.resolve(cb(event)).catch((e) =>
          log.error("PG NOTIFY subscriber rejected", { error: e instanceof Error ? e.message : String(e) }),
        )
      } catch (e) {
        log.error("PG NOTIFY subscriber threw", { error: e instanceof Error ? e.message : String(e) })
      }
    }
  }

  async function connect(signal: AbortSignal, retries = 0) {
    if (signal.aborted) return false
    try {
      const client = getClient()
      const l = await client.listen(CHANNEL, handler)
      if (signal.aborted) {
        try { await l.unlisten() } catch {}
        return false
      }
      listener = l
      log.info("PG LISTEN ready", { channel: CHANNEL })
      return true
    } catch (e) {
      if (signal.aborted) return false
      const delay = jitter(Math.min(1000 * 2 ** retries, 30_000))
      log.error("PG LISTEN failed, reconnecting", {
        error: e instanceof Error ? e.message : String(e),
        retryIn: delay,
      })
      await sleep(delay, signal)
      if (signal.aborted) return false
      return connect(signal, retries + 1)
    }
  }

  export async function publish(message: unknown) {
    try {
      const client = getClient()
      await client.notify(CHANNEL, JSON.stringify(message))
    } catch (e) {
      log.error("notify failed", { error: e instanceof Error ? e.message : String(e) })
      throw e
    }
  }

  export async function revisions() {
    const client = getClient()
    const rows = await client`SELECT key, revision FROM cluster_state WHERE key IN ('auth', 'config')`
    return rows.map((row: { key: string; revision: number | string }) => ({
      key: row.key,
      revision: Number(row.revision),
    }))
  }

  export async function requestSessionAbort(sessionID: string) {
    const client = getClient()
    const rows = await client`INSERT INTO session_abort (session_id, directory, generation, time_updated)
      SELECT id, directory, 1, ${Date.now()} FROM session WHERE id = ${sessionID}
      ON CONFLICT (session_id) DO UPDATE SET
        directory = EXCLUDED.directory,
        generation = session_abort.generation + 1,
        time_updated = EXCLUDED.time_updated
      RETURNING generation, directory`
    if (!rows[0]) return undefined
    return { generation: Number(rows[0].generation), directory: String(rows[0].directory) }
  }

  export async function abortGenerations() {
    const client = getClient()
    const rows = await client`SELECT session_id, directory, generation FROM session_abort`
    return rows.map((row: { session_id: string; directory: string; generation: number | string }) => ({
      sessionID: row.session_id,
      directory: row.directory,
      generation: Number(row.generation),
    }))
  }

  export async function storeLargeEvent(id: string, origin: string, event: unknown) {
    const client = getClient()
    const now = Date.now()
    await client.begin(async (sql: any) => {
      await sql`DELETE FROM cluster_bus_event WHERE time_created < ${now - 10 * 60_000}`
      await sql`INSERT INTO cluster_bus_event (id, origin, event, time_created)
        VALUES (${id}, ${origin}, ${JSON.stringify(event)}::jsonb, ${now})`
    })
    await publish({ type: "event.ref", origin, eventID: id })
  }

  export async function loadLargeEvent(id: string) {
    const client = getClient()
    const rows = await client`SELECT event FROM cluster_bus_event WHERE id = ${id}`
    const event = rows[0]?.event
    return typeof event === "string" ? JSON.parse(event) : event
  }

  export function start() {
    if (started || abort) return
    if (Flag.OPENCODE_DATABASE_URL === undefined) return

    const ac = new AbortController()
    abort = ac
    log.info("starting PG LISTEN", { channel: CHANNEL })
    void connect(ac.signal)
      .then((ok) => {
        if (ok && !ac.signal.aborted) started = true
      })
      .finally(() => {
        if (abort === ac && !started) abort = null
      })
  }

  export function isStarted() {
    return started
  }

  export async function stop() {
    started = false
    const ac = abort
    abort = null
    if (ac) ac.abort()
    if (listener) {
      const l = listener
      listener = null
      try {
        await l.unlisten()
      } catch (e) {
        log.error("PG unlisten failed", { error: e instanceof Error ? e.message : String(e) })
      }
      log.info("PG LISTEN stopped")
    }
    if (notifyClient) {
      const client = notifyClient
      notifyClient = null
      await client.end({ timeout: 1 }).catch((e: unknown) =>
        log.error("PG notify client close failed", { error: e instanceof Error ? e.message : String(e) }),
      )
    }
  }

  export function subscribe(callback: (event: any) => void | Promise<void>): () => void {
    callbacks.add(callback)
    return () => {
      callbacks.delete(callback)
    }
  }
}
