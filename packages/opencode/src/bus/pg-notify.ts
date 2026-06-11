import * as Log from "@opencode-ai/core/util/log"
import { Flag } from "@opencode-ai/core/flag/flag"

const log = Log.create({ service: "pg-notify" })

const CHANNEL = "opencode_event"

export namespace PgNotify {
  const callbacks = new Set<(event: any) => void>()
  let listener: any = null
  let started = false
  let abort: AbortController | null = null

  function getClient() {
    // In PG mode, Database.Client() returns a PG drizzle instance
    // whose .$client is the postgres.js tagged-template client
    // which supports .listen() / .notify().
    const { Database } = require("../storage/db") as typeof import("../storage/db")
    return (Database.Client() as any).$client
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
        cb(event)
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

  export async function publish(event: { type: string; properties: any }) {
    try {
      const client = getClient()
      await client.notify(CHANNEL, JSON.stringify(event))
    } catch (e) {
      log.error("notify failed", { error: e instanceof Error ? e.message : String(e) })
    }
  }

  export async function start() {
    if (started || abort) return
    if (Flag.OPENCODE_DATABASE_URL === undefined) return

    const ac = new AbortController()
    abort = ac
    try {
      log.info("starting PG LISTEN", { channel: CHANNEL })
      const ok = await connect(ac.signal)
      if (ok && !ac.signal.aborted) started = true
    } finally {
      if (abort === ac && !started) abort = null
    }
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
  }

  export function subscribe(callback: (event: any) => void): () => void {
    if (!started) {
      log.warn("subscribe called before PG LISTEN started")
    }
    callbacks.add(callback)
    return () => {
      callbacks.delete(callback)
    }
  }
}
