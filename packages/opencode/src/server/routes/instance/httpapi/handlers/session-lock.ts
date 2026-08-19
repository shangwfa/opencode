import { Effect } from "effect"
import postgres from "postgres"
import { SessionID } from "@/session/schema"
import { Flag } from "@/flag/flag"

// Cross-pod session mutex backed by PG advisory locks. Every pod shares the
// same PG instance, so pg_try_advisory_lock on a hash of the session ID gives
// cluster-wide mutual exclusion for session-processing requests (prompt,
// reload, …), replacing the former in-memory map that only worked for a
// single pod.

// Advisory locks are bound to the connection that took them, so they need a
// dedicated pool that never recycles connections (max_lifetime null) —
// recycling would silently drop locks held by long-running prompts. One
// reserved connection per held lock keeps different sessions from queueing
// behind each other.
let lockPool: postgres.Sql<any> | undefined
let lockAdminPool: postgres.Sql<any> | undefined
function getLockPool() {
  if (!lockPool) {
    // idle/max_lifetime null = never recycle: recycling a connection would
    // silently drop advisory locks held by long-running prompts
    lockPool = postgres(Flag.OPENCODE_DATABASE_URL!, {
      max: Flag.OPENCODE_SESSION_LOCK_POOL_SIZE,
      idle_timeout: null,
      max_lifetime: null,
      connect_timeout: 10,
    } as any)
  }
  return lockPool
}

function getLockAdminPool() {
  if (!lockAdminPool) {
    lockAdminPool = postgres(Flag.OPENCODE_DATABASE_URL!, {
      max: 1,
      idle_timeout: null,
      max_lifetime: null,
      connect_timeout: 10,
    } as any)
  }
  return lockAdminPool
}

// FNV-1a 64-bit, rendered as signed PG bigint text. Distinct session IDs map
// to distinct advisory lock keys with negligible collision probability.
export function advisoryKey(sessionID: string) {
  let hash = 0xcbf29ce484222325n
  for (let i = 0; i < sessionID.length; i++) {
    hash ^= BigInt(sessionID.charCodeAt(i))
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
  }
  if (hash >= 0x8000000000000000n) hash -= 0x10000000000000000n
  return hash.toString()
}

type Reserved = Awaited<ReturnType<postgres.Sql<any>["reserve"]>>
type LockHandle = { reserved: Reserved; backendPID: number }

async function terminate(handle: LockHandle) {
  const rows = await getLockAdminPool()<Array<{ terminated: boolean }>>`
    select pg_terminate_backend(${handle.backendPID}) as terminated
  `
  if (rows[0]?.terminated !== true) throw new Error(`Failed to terminate PG lock backend ${handle.backendPID}`)
  handle.reserved.release()
}

async function tryAcquire(key: string, signal: AbortSignal): Promise<LockHandle | undefined> {
  const reserved = await getLockPool().reserve()
  if (signal.aborted) {
    reserved.release()
    throw signal.reason
  }
  let backendPID: number | undefined
  let locked = false
  try {
    const backend = await reserved<Array<{ pid: number }>>`select pg_backend_pid() as pid`
    backendPID = backend[0]?.pid
    if (backendPID === undefined) throw new Error("PG lock connection did not return a backend PID")
    const rows = await reserved<Array<{ ok: boolean }>>`select pg_try_advisory_lock(${key}::bigint) as ok`
    locked = rows[0]?.ok === true
    if (locked && !signal.aborted) return { reserved, backendPID }
    if (locked) {
      const unlocked = await reserved<Array<{ unlocked: boolean }>>`select pg_advisory_unlock(${key}::bigint) as unlocked`
      if (unlocked[0]?.unlocked !== true) throw new Error(`Failed to release cancelled PG advisory lock ${key}`)
      locked = false
    }
    reserved.release()
    if (signal.aborted) throw signal.reason
    return undefined
  } catch (e) {
    if (backendPID !== undefined) {
      await terminate({ reserved, backendPID }).catch(() => {})
    }
    throw e
  }
}

async function releaseLock(handle: LockHandle, key: string) {
  try {
    const rows = await handle.reserved<Array<{ unlocked: boolean }>>`select pg_advisory_unlock(${key}::bigint) as unlocked`
    if (rows[0]?.unlocked !== true) throw new Error(`PG advisory lock ${key} was not held by its reserved connection`)
    handle.reserved.release()
  } catch (e) {
    await terminate(handle)
    throw e
  }
}

function monitorConnection(handle: LockHandle) {
  return Effect.gen(function* () {
    while (true) {
      yield* Effect.sleep("1 second")
      yield* Effect.tryPromise({
        try: () => handle.reserved`select 1`,
        catch: (cause) => cause,
      }).pipe(Effect.orDie)
    }
  })
}

export function withSessionLock<A, E, R>(sessionID: SessionID, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
  const key = advisoryKey(sessionID)
  const acquire = Effect.gen(function* () {
    while (true) {
      const reserved = yield* Effect.tryPromise({
        try: (signal) => tryAcquire(key, signal),
        catch: (cause) => cause,
      }).pipe(Effect.orDie)
      if (reserved) return reserved
      yield* Effect.sleep("100 millis")
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: `${Flag.OPENCODE_SESSION_LOCK_TIMEOUT_SEC} seconds`,
      orElse: () =>
        Effect.die(
          new Error(
            `Timed out acquiring session lock for ${sessionID} after ${Flag.OPENCODE_SESSION_LOCK_TIMEOUT_SEC}s — another pod is likely still processing this session`,
          ),
        ),
    }),
  )
  return Effect.acquireUseRelease(
    acquire,
    (handle) => Effect.raceFirst(effect, monitorConnection(handle)),
    (handle) => Effect.promise(() => releaseLock(handle, key)).pipe(Effect.orDie),
  )
}

// Waiting is handled inside withSessionLock's advisory-lock polling; kept as
// a no-op so call sites stay unchanged.
export function waitForSessionLock(_sessionID: SessionID): Effect.Effect<void> {
  return Effect.void
}
