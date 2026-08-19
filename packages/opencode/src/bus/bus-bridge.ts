import { randomUUID } from "node:crypto"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { PgNotify } from "@/bus/pg-notify"

// Multi-pod bridge over PG LISTEN/NOTIFY. A pod publishes local GlobalBus
// events so SSE clients connected to other pods receive them, and listens for
// control-plane messages (auth/config reload) so instance caches are dropped
// on every pod, not just the one that handled the HTTP request.

const podId = randomUUID()

// PG NOTIFY payloads are capped at 8000 bytes; leave headroom for the envelope.
const NOTIFY_PAYLOAD_LIMIT = 7500

const log = {
  warn(msg: string, data?: Record<string, unknown>) { console.warn(`[bus-bridge] ${msg}`, data ?? "") },
}

type Envelope =
  | { type: "event"; origin: string; event: GlobalEvent }
  | { type: "dispose.all"; origin: string; reason: string }
  | { type: "session.abort"; origin: string; sessionID: string; directory: string; generation: number }
  | { type: "event.ref"; origin: string; eventID: string }
  | { type: "exec.kill"; origin: string; execID: string; sessionID: string }

let started = false
let users = 0
let warnedLargeEvent = false
let unsubscribeNotify: (() => void) | undefined
const disposeCallbacks = new Set<(reason: string) => void | Promise<void>>()
const abortCallbacks = new Set<(sessionID: string, directory: string) => void | Promise<void>>()
const execKillCallbacks = new Set<(execID: string, sessionID: string) => void | Promise<void>>()
const revisions = new Map<string, number>()
const abortGenerations = new Map<string, number>()
let revisionTimer: ReturnType<typeof setInterval> | undefined
let publishChain = Promise.resolve()

// Events re-emitted from a remote pod carry this marker so the local publish
// hook skips them — otherwise re-publishing would echo the event back to the
// originating pod and ping-pong forever.
const REMOTE_MARKER = "__fromPgBridge"

export function isRemoteEvent(event: GlobalEvent) {
  return (event as any)[REMOTE_MARKER] === true
}

export async function notifyDisposeAll(reason: string) {
  try {
    await PgNotify.publish({ type: "dispose.all", origin: podId, reason } satisfies Envelope)
  } catch (e) {
    // Durable cluster_state revision polling is the correctness path; NOTIFY
    // only lowers propagation latency.
    log.warn("dispose notification failed; revision poll will recover", {
      reason,
      error: e instanceof Error ? e.message : String(e),
    })
  }
  await refreshRevisions(false)
}

async function notifyDispose(reason: string) {
  await Promise.allSettled(Array.from(disposeCallbacks, (callback) => Promise.resolve(callback(reason))))
}

async function refreshRevisions(notify: boolean) {
  try {
    for (const row of await PgNotify.revisions()) {
      const previous = revisions.get(row.key)
      revisions.set(row.key, row.revision)
      if (notify && previous !== undefined && row.revision > previous) await notifyDispose(row.key)
    }
  } catch (e) {
    log.warn("cluster revision poll failed", { error: e instanceof Error ? e.message : String(e) })
  }
}

async function notifyAbort(sessionID: string, directory: string) {
  await Promise.allSettled(Array.from(abortCallbacks, (callback) => Promise.resolve(callback(sessionID, directory))))
}

async function refreshAborts(notify: boolean) {
  try {
    for (const row of await PgNotify.abortGenerations()) {
      const previous = abortGenerations.get(row.sessionID)
      abortGenerations.set(row.sessionID, row.generation)
      if (notify && previous !== undefined && row.generation > previous) await notifyAbort(row.sessionID, row.directory)
    }
  } catch (e) {
    log.warn("session abort poll failed", { error: e instanceof Error ? e.message : String(e) })
  }
}

export async function notifySessionAbort(sessionID: string) {
  const request = await PgNotify.requestSessionAbort(sessionID)
  if (!request) return
  abortGenerations.set(sessionID, request.generation)
  try {
    await PgNotify.publish({
      type: "session.abort",
      origin: podId,
      sessionID,
      directory: request.directory,
      generation: request.generation,
    } satisfies Envelope)
  } catch (e) {
    log.warn("session abort notification failed; abort poll will recover", {
      sessionID,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

export async function notifyExecKill(execID: string, sessionID: string) {
  try {
    await PgNotify.publish({ type: "exec.kill", origin: podId, execID, sessionID } satisfies Envelope)
  } catch (e) {
    log.warn("exec kill notification failed", {
      execID,
      error: e instanceof Error ? e.message : String(e),
    })
  }
}

async function onNotify(message: unknown) {
  const env = message as Envelope
  if (env?.origin === podId) return
  if (env?.type === "dispose.all") {
    await notifyDispose(env.reason)
    await refreshRevisions(false)
    return
  }
  if (env?.type === "session.abort") {
    const previous = abortGenerations.get(env.sessionID) ?? 0
    abortGenerations.set(env.sessionID, Math.max(previous, env.generation))
    if (env.generation > previous) await notifyAbort(env.sessionID, env.directory)
    return
  }
  if (env?.type === "event.ref") {
    const event = await PgNotify.loadLargeEvent(env.eventID) as GlobalEvent | undefined
    if (!event?.payload) return
    ;(event as any)[REMOTE_MARKER] = true
    GlobalBus.emit("event", event)
    return
  }
  if (env?.type === "exec.kill") {
    await Promise.allSettled(
      Array.from(execKillCallbacks, (callback) => Promise.resolve(callback(env.execID, env.sessionID))),
    )
    return
  }
  if (env?.type === "event" && env.origin !== podId && env.event?.payload) {
    ;(env.event as any)[REMOTE_MARKER] = true
    GlobalBus.emit("event", env.event)
  }
}

function onLocalEvent(event: GlobalEvent) {
  if (isRemoteEvent(event)) return
  const envelope: Envelope = { type: "event", origin: podId, event }
  const payload = JSON.stringify(envelope)
  const bytes = Buffer.byteLength(payload, "utf8")
  if (bytes > NOTIFY_PAYLOAD_LIMIT) {
    if (!warnedLargeEvent) {
      log.warn("event exceeds PG NOTIFY payload limit, using PG reference fan-out (subsequent notices are silent)", {
        bytes,
        eventType: event.payload?.type,
      })
      warnedLargeEvent = true
    }
    publishChain = publishChain
      .then(() => PgNotify.storeLargeEvent(randomUUID(), podId, event))
      .catch((e) => log.warn("large event fan-out failed", { error: e instanceof Error ? e.message : String(e) }))
    return
  }
  publishChain = publishChain
    .then(() => PgNotify.publish(envelope))
    .catch((e) => log.warn("event fan-out failed", { error: e instanceof Error ? e.message : String(e) }))
}

export async function startBusBridge() {
  users++
  if (started) return
  unsubscribeNotify = PgNotify.subscribe(onNotify)
  GlobalBus.on("event", onLocalEvent)
  started = true
  PgNotify.start()
  await refreshRevisions(false)
  await refreshAborts(false)
  revisionTimer = setInterval(() => {
    void refreshRevisions(true)
    void refreshAborts(true)
  }, 5_000)
  console.info("[bus-bridge] cross-pod event bridge active", { podId })
}

export async function stopBusBridge() {
  users = Math.max(0, users - 1)
  if (users > 0 || !started) return
  started = false
  unsubscribeNotify?.()
  unsubscribeNotify = undefined
  GlobalBus.off("event", onLocalEvent)
  if (revisionTimer) clearInterval(revisionTimer)
  revisionTimer = undefined
  revisions.clear()
  abortGenerations.clear()
  publishChain = Promise.resolve()
  await PgNotify.stop()
}

export function subscribeDispose(callback: (reason: string) => void | Promise<void>) {
  disposeCallbacks.add(callback)
  return () => disposeCallbacks.delete(callback)
}

export function subscribeSessionAbort(callback: (sessionID: string, directory: string) => void | Promise<void>) {
  abortCallbacks.add(callback)
  return () => abortCallbacks.delete(callback)
}

export function subscribeExecKill(callback: (execID: string, sessionID: string) => void | Promise<void>) {
  execKillCallbacks.add(callback)
  return () => execKillCallbacks.delete(callback)
}

export function _podId() {
  return podId
}

export function _resetForTest() {
  started = false
  users = 0
  warnedLargeEvent = false
  unsubscribeNotify?.()
  unsubscribeNotify = undefined
  GlobalBus.off("event", onLocalEvent)
  disposeCallbacks.clear()
  abortCallbacks.clear()
  execKillCallbacks.clear()
  if (revisionTimer) clearInterval(revisionTimer)
  revisionTimer = undefined
  revisions.clear()
  abortGenerations.clear()
  publishChain = Promise.resolve()
}

export * as BusBridge from "./bus-bridge"
