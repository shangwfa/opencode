export * as SandboxProvider from "./provider.js"
import { SessionToolGate } from "../session/tool-gate.js"

import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { Cause, Context, Deferred, Duration, Effect, Fiber, Layer, Option, Ref, Schedule, Schema, Semaphore } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SandboxConfig } from "./config.js"
import { SandboxOomSample } from "./oom-sample.js"
import * as SandboxSnapshot from "./snapshot.js"
import * as SandboxSnapshotOperation from "./snapshot-operation.js"
import * as SandboxSnapshotReuse from "./snapshot-reuse.js"
import { SandboxPath } from "./path.js"
import { Database } from "../database/database.js"
import { SandboxTable } from "./sql.js"
import { SessionTable } from "../session/sql.js"
import { SandboxVolumes } from "./volumes.js"
import { SessionSchema } from "../session/schema.js"
import { Bus } from "../bus.js"
import { SessionEvent } from "../session/event.js"
import type { SessionID } from "@opencode/schema/session-id"
import { and, desc, eq, lt, or } from "drizzle-orm"

export interface ExecutionResult {
  readonly exitCode: number | null
  readonly output: string
  readonly timedOut: boolean
}

export interface RunInput {
  readonly sessionID: string
  readonly command: string
  /** Host working directory; mapped onto the sandbox `/workspace` mount. */
  readonly cwd?: string
  readonly hostWorkdir: string
  /** Milliseconds; 0 disables the timeout. */
  readonly timeoutMs?: number
  /**
   * Retry only operations known to be read-only and idempotent. General shell
   * commands must never be replayed after an ambiguous transport failure.
   */
  readonly retryPolicy?: "safe-read"
  /**
   * Creates a command context exclusively for this operation. It is required
   * for runners that can await nested sandbox tools; sharing the stateful
   * command context there would deadlock with the child tool's command.
   */
  readonly isolated?: boolean
  /** Stable caller identity used for targeted cancellation and observability. */
  readonly operationID?: string
}

/**
 * Sandbox SDK calls reject on transport failures. `Effect.promise` would turn that rejection
 * into a defect that bypasses typed error handling (including `Effect.ignore` and callers'
 * `mapError`/`catchTag`), so route them through the error channel instead.
 */
const attempt = <A>(evaluate: () => PromiseLike<A>) =>
  Effect.tryPromise({
    try: evaluate,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

/**
 * Outcome of resolving a sandbox port address. Proxy/preview routes must never
 * create a sandbox, so "no-sandbox" is reported instead of blocking behind a
 * remote create; "resolve-failed" keeps a live sandbox distinct from a gone one.
 */
export type EndpointResolution =
  | { readonly _tag: "resolved"; readonly sandboxId: string; readonly endpoint: string }
  | { readonly _tag: "no-sandbox" }
  | { readonly _tag: "resolve-failed" }

export interface Interface {
  /** False keeps every tool on its local path; the layer is always present. */
  readonly enabled: boolean
  readonly run: (input: RunInput) => Effect.Effect<ExecutionResult, Error>
  /** Interrupt one operation, or every active command in the Session when omitted. */
  readonly interrupt: (sessionID: string, operationID?: string) => Effect.Effect<void>
  readonly destroy: (sessionID: string) => Effect.Effect<void>
  readonly keepAlive: (sessionID: string) => Effect.Effect<void>
  /** Scoped activity without booting or permanently enabling keepalive. */
  readonly activity: (sessionID: string) => Effect.Effect<void, never, import("effect").Scope.Scope>
  readonly release: (sessionID: string) => Effect.Effect<void>
  readonly isKeepAlive: (sessionID: string) => Effect.Effect<boolean>
  readonly sandboxId: (sessionID: string) => Effect.Effect<string | null>
  readonly boot: (sessionID: string) => Effect.Effect<string, Error>
  /**
   * Start a snapshot of the session's sandbox. Resolves immediately with the
   * snapshot id while it settles to Ready in the background; requires the
   * snapshot capability and a session persisting via snapshots.
   */
  readonly snapshot: (
    sessionID: string,
  ) => Effect.Effect<{ readonly snapshotID: string; readonly state: string }, Error>
  /** Latest snapshot row for the session (any live state), or null. */
  readonly latestSnapshot: (
    sessionID: string,
  ) => Effect.Effect<
    | {
        readonly id: string
        readonly state: string
        readonly reason: string | null
        readonly createdAt: number
        readonly restoredCount: number
      }
    | null,
    Error
  >
  /** Delete every snapshot recorded for the session (remote deletion gated by config). */
  readonly deleteSnapshots: (sessionID: string) => Effect.Effect<void>
  /** Session snapshot + operation aggregates for observability. */
  readonly snapshotStats: (
    sessionID: string,
  ) => Effect.Effect<
    {
      readonly snapshots: Readonly<Record<string, number>>
      readonly total: number
      readonly restoredTotal: number
      readonly operations: {
        readonly destroy: { readonly byState: Readonly<Record<string, number>>; readonly total: number }
        readonly refresh: { readonly byState: Readonly<Record<string, number>>; readonly total: number }
      }
    },
    Error
  >
  /** null result means the path does not exist inside the sandbox. */
  readonly fileStat: (
    sessionID: string,
    sandboxPath: string,
  ) => Effect.Effect<{ readonly isDirectory: boolean; readonly size?: number } | null, Error>
  /** null result means the path does not exist inside the sandbox. */
  readonly fileRead: (sessionID: string, sandboxPath: string) => Effect.Effect<string | null, Error>
  /** Binary reads for the session-scoped fs.read route; null when absent. */
  readonly fileReadBytes: (
    sessionID: string,
    sandboxPath: string,
    opts?: { readonly range?: string },
  ) => Effect.Effect<Uint8Array | null, Error>
  readonly fileWrite: (sessionID: string, sandboxPath: string, data: string) => Effect.Effect<void, Error>
  readonly fileDelete: (sessionID: string, sandboxPath: string) => Effect.Effect<void, Error>
  readonly fileList: (
    sessionID: string,
    sandboxPath: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly isDirectory: boolean }>, Error>
  /** Recursive filename search, used by the session-scoped fs.find route. */
  readonly fileFind: (
    sessionID: string,
    sandboxPath: string,
    query: string,
  ) => Effect.Effect<ReadonlyArray<{ readonly path: string; readonly isDirectory: boolean }>, Error>
  /**
   * Whether the session sandbox already runs. Read-only browsing must fail
   * fast instead of blocking an HTTP request behind a remote create.
   */
  readonly isReady: (sessionID: string) => Effect.Effect<boolean>
  /**
   * Resolve the reachable address (host:port, no scheme) of one sandbox port
   * without ever creating a sandbox. Never fails; see {@link EndpointResolution}.
   */
  readonly endpoint: (
    sessionID: string,
    port: number,
    useServerProxy: boolean,
  ) => Effect.Effect<EndpointResolution, never>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxProvider") {}

type Entry = {
  sb: Sandbox
  commandSessionID: string
}

type ActiveCommand = {
  readonly operationID: string
  readonly commandSessionID: string
  readonly sandbox: Sandbox
}

// The 0.1.x SDK types `commands` with a promise-based run API; the SSE stream
// method exists at runtime with the same event protocol. Consuming the stream
// directly returns as soon as execution_complete arrives instead of waiting
// for intermediary proxies to close the held-open connection.
type StreamEvent = {
  type: string
  text?: string
  error?: { ename?: string; evalue?: string; name?: string; value?: string }
}

type ExecCommands = {
  run(command: string): Promise<unknown>
  createSession(options?: { workingDirectory?: string }): Promise<string>
  deleteSession(sessionId: string): Promise<void>
  interrupt(sessionId: string): Promise<void>
  runInSessionStream(
    sessionId: string,
    command: string,
    options?: { workingDirectory?: string; timeoutSeconds?: number },
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent>
}

// Same runtime-vs-types gap as the command stream: the files API is reachable
// on the sandbox instance and its JSON shapes are stable across 0.1.x.
type SandboxFilesApi = {
  getFileInfo(paths: string[]): Promise<Record<string, { mode?: number; type?: string; size?: number }>>
  readFile(path: string, opts?: { encoding?: string }): Promise<string>
  readBytes(path: string, opts?: { range?: string }): Promise<Uint8Array>
  writeFiles(entries: { path: string; data: string }[]): Promise<void>
  deleteFiles(paths: string[]): Promise<void>
  createDirectories(entries: { path: string }[]): Promise<void>
  listDirectory(entry: { path: string }): Promise<Array<{ name?: string; mode?: number; type?: string }>>
  search(entry: { path: string; pattern?: string }): Promise<Array<{ name?: string; path?: string; mode?: number }>>
}

const commandsOf = (sb: Sandbox): ExecCommands => sb.commands as unknown as ExecCommands

// The endpoint lookup mirrors the same runtime-vs-types gap: it lives on the
// sandbox's `sandboxes` namespace and returns a stable 0.1.x JSON shape.
type SandboxEndpointsApi = {
  getSandboxEndpoint(
    sandboxId: string,
    port: number,
    useServerProxy?: boolean,
  ): Promise<{ endpoint: string; headers?: Record<string, string> }>
}

const endpointsOf = (sb: Sandbox): SandboxEndpointsApi =>
  (sb as unknown as { sandboxes: SandboxEndpointsApi }).sandboxes

/**
 * execd emits one stdout/stderr stream event per output line with the trailing
 * newline stripped (empty lines produce no event at all). Reassembling with
 * "" would fuse every line into one, so line-oriented consumers (rg --files,
 * rg --json, shell output) need the parts joined back with "\n".
 */
export const assembleStreamText = (parts: ReadonlyArray<string>): string => parts.join("\n")

/**
 * Image for one sandbox: the session's own pin wins, otherwise the deployment
 * default. A blank or whitespace-only value counts as absent, so a session that
 * sends `"image": ""` still gets the default instead of a failed create. The
 * sandbox column is untyped JSON read through the PG bridge, so the value is
 * only trusted when it is actually a string.
 */
export const resolveSessionImage = (sandbox: unknown, fallback: string): string => {
  const image = (sandbox as { readonly image?: unknown } | undefined)?.image
  if (typeof image !== "string") return fallback
  return image.trim() || fallback
}

const filesOf = (sb: Sandbox): SandboxFilesApi => sb.files as unknown as SandboxFilesApi

const isDirectoryMode = (mode: number | undefined) => typeof mode === "number" && (mode & 0o170000) === 0o040000

const isNotFound = (cause: unknown) => {
  if (typeof cause !== "object" || cause === null) return false
  if ("statusCode" in cause && (cause as { statusCode?: number }).statusCode === 404) return true
  const message = [
    "message" in cause && typeof cause.message === "string" ? cause.message : "",
    "rawBody" in cause && typeof cause.rawBody === "string" ? cause.rawBody : "",
  ].join(" ")
  return /(?:file|path|directory) not found|no such file/i.test(message)
}

/**
 * Waiting for a sandbox create/reconnect must be bounded: a cached entry can be
 * stale and the remote control plane can hang, in which case an unbounded wait
 * pins the command Semaphore and starves every later command for the session.
 */
const GET_OR_CREATE_TIMEOUT_SECONDS = 90
/**
 * Outer budget for "wait for the command lock + run" = the caller's execution
 * timeout plus a backlog grace. The grace keeps a long queue wait from being
 * misreported as the command itself timing out.
 */
const COMMAND_QUEUE_GRACE_SECONDS = 5
const COMMAND_CLEANUP_TIMEOUT_SECONDS = 10
const COMMAND_PERMIT_UNAVAILABLE = new Error("command semaphore unavailable")

export class SandboxFilesTimeoutError extends Schema.TaggedError<SandboxFilesTimeoutError>()("Sandbox.FilesTimeout", {
  message: Schema.String,
  operation: Schema.String,
  path: Schema.String,
  timeoutSeconds: Schema.Number,
}) {}

/** Run one idempotent files API request with a transport-canceling timeout and bounded timeout retries. */
export const withSandboxFilesTimeout = <A>(input: {
  readonly operation: string
  readonly path: string
  readonly timeoutSeconds: number
  readonly retries: number
  readonly run: (signal: AbortSignal) => PromiseLike<A>
}) =>
  Effect.tryPromise({
    try: input.run,
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(input.timeoutSeconds),
      orElse: () =>
        Effect.fail(
          new SandboxFilesTimeoutError({
            message: `Sandbox files ${input.operation} timed out after ${input.timeoutSeconds}s: ${input.path}`,
            operation: input.operation,
            path: input.path,
            timeoutSeconds: input.timeoutSeconds,
          }),
        ),
    }),
    Effect.retry({
      times: input.retries,
      while: (error) => error instanceof SandboxFilesTimeoutError,
    }),
  )

export const sandboxFilesRequest = async (
  sb: Sandbox,
  apiPath: string,
  sandboxPath: string,
  signal: AbortSignal,
  range?: string,
) => {
  const endpoint = await endpointsOf(sb).getSandboxEndpoint(sb.id, 44772, sb.connectionConfig.useServerProxy)
  const base = `${sb.connectionConfig.protocol}://${endpoint.endpoint.replace(/\/+$/, "")}/`
  const url = new URL(`${base}${apiPath.replace(/^\/+/, "")}`)
  url.searchParams.set("path", sandboxPath)
  const headers = new Headers()
  for (const [name, value] of Object.entries(endpoint.headers ?? {})) headers.set(name, value)
  if (range) headers.set("Range", range)
  return sb.connectionConfig.fetch(url, { method: "GET", headers, signal })
}

const sandboxFilesResponseError = async (response: Response, operation: string, path: string) => {
  const rawBody = await response.text().catch(() => "")
  return Object.assign(
    new Error(`${operation} failed: ${path}: HTTP ${response.status}${rawBody ? `: ${rawBody}` : ""}`),
    { statusCode: response.status, rawBody },
  )
}

/**
 * A definitive "sandbox not found" verdict (HTTP 404 or an explicit not-found
 * message) from the sandbox runtime. Such a sandbox is already gone remotely,
 * so its durable row must not stay `running`; transport failures carry no
 * verdict and must keep the row for a later retry.
 */
export const remoteSandboxGone = (error: unknown) => {
  for (
    let cause: unknown = error, depth = 0;
    typeof cause === "object" && cause !== null && depth < 4;
    cause = (cause as { readonly cause?: unknown }).cause, depth++
  ) {
    if ((cause as { readonly statusCode?: unknown }).statusCode === 404) return true
    const message = (cause as { readonly message?: unknown }).message
    if (typeof message === "string" && /sandbox .+ not found/i.test(message)) return true
  }
  return false
}

/** Killing a sandbox the runtime already removed still counts as destroyed. */
const killResult = (sessionID: string, sandboxID: string, cause: Cause.Cause<unknown>) =>
  remoteSandboxGone(Cause.squash(cause))
    ? Effect.logWarning("Sandbox already gone at delete", { sessionID, sandboxID, cause }).pipe(Effect.as(true))
    : Effect.logWarning("Sandbox delete failed", { sessionID, sandboxID, cause }).pipe(Effect.as(false))


/** Fails an operation that exceeds its budget, naming the operation. */
export const withOperationTimeout = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  seconds: number,
  operation: string,
): Effect.Effect<A, E | Error, R> =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(seconds),
      orElse: () => Effect.fail(new Error(`${operation} timed out after ${seconds}s`)),
    }),
  )

/**
 * Queues behind a Semaphore with a bounded wait. Availability is polled so the
 * outer budget (execution timeout + backlog grace) always exceeds the caller's
 * own exec timeout, keeping "queued too long" distinct from "ran too long".
 */
export const withSemaphoreWaitTimeout = <A, E, R>(
  semaphore: Semaphore.Semaphore,
  effect: Effect.Effect<A, E, R>,
  timeoutSeconds: number,
  operation: string,
): Effect.Effect<A, E | Error, R> =>
  withOperationTimeout(
    semaphore
      .withPermitsIfAvailable(1)(effect)
      .pipe(
        Effect.flatMap((result) =>
          Option.isSome(result) ? Effect.succeed(result.value) : Effect.fail(COMMAND_PERMIT_UNAVAILABLE),
        ),
        Effect.retry({
          while: (error) => error === COMMAND_PERMIT_UNAVAILABLE,
          schedule: Schedule.spaced(Duration.millis(10)),
        }),
      ),
    timeoutSeconds + COMMAND_QUEUE_GRACE_SECONDS,
    operation,
  )

/**
 * Sandbox-level disappearance (sandbox or command session reaped while a turn
 * waited on the user). Rebuilding and retrying once is safe because a gone
 * sandbox can never have executed the command. Deliberately narrow matching:
 * business-level "not found" must never trigger a retry.
 */
/**
 * Walks the immutable session parent chain to the root session id, bounded to
 * ten hops. Subagent child sessions resolve to their root so every sandbox
 * lookup shares one sandbox per conversation tree (v1 resolveSandboxOpts).
 */
export const rootSessionID = Effect.fn("SandboxProvider.rootSessionID")(function* (
  sessionID: string,
  lookup: (id: string) => Effect.Effect<{ readonly parentID: string | null | undefined } | null | undefined>,
) {
  let current = sessionID
  for (let depth = 0; depth < 10; depth++) {
    const row = yield* lookup(current)
    if (!row?.parentID) break
    current = row.parentID
  }
  return current
})

export const isSandboxGone = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes("Sandbox is no longer running")) return true
  return (
    /^runInSession failed:|^runDetached failed:|^Failed to create (command|detached) session:/i.test(message) &&
    /not found|\b404\b/i.test(message)
  )
}

/** A command execution context disappeared while its owning sandbox may still live. */
export const isCommandSessionGone = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error)
  return /\bcontext not found\b/i.test(message) || /^runInSession failed: command session .+ not found/i.test(message)
}

/** Typed so a vanished command context can be repaired, and replayed only for safe reads. */
export class CommandSessionUnavailable extends Error {
  constructor(
    readonly commandSessionID: string,
    cause: Error,
  ) {
    super(cause.message, { cause })
    this.name = "CommandSessionUnavailable"
  }
}

export interface CommandSessionRecoveryHooks {
  /** Drops the stale command context so the next attempt builds a fresh one. */
  readonly repair: (error: CommandSessionUnavailable) => Effect.Effect<void>
  /** Sandbox-level last resort once two fresh command contexts have both failed. */
  readonly rebuild: (error: CommandSessionUnavailable) => Effect.Effect<void>
}

/**
 * Recovers a command whose *command context* disappeared. That is narrower than a missing sandbox,
 * so repair the context first. Only a caller that explicitly declares a read-only, idempotent
 * operation (`retryPolicy: "safe-read"`) may replay the command; every other command fails after
 * the repair, so a side-effecting command is never executed twice.
 *
 * Kept as a function over injected `repair`/`rebuild` effects so the replay policy — not just the
 * error classifier — is directly testable.
 */
export const withCommandSessionRecovery = <A, R>(
  retryPolicy: RunInput["retryPolicy"],
  hooks: CommandSessionRecoveryHooks,
  execute: () => Effect.Effect<A, Error, R>,
): Effect.Effect<A, Error, R> => {
  const { repair, rebuild } = hooks
  if (retryPolicy !== "safe-read")
    return execute().pipe(
      Effect.tapError((error) => (error instanceof CommandSessionUnavailable ? repair(error) : Effect.void)),
    )
  return execute().pipe(
    Effect.catchIf(
      (error): error is CommandSessionUnavailable => error instanceof CommandSessionUnavailable,
      (first) =>
        repair(first).pipe(
          Effect.andThen(execute),
          Effect.catchIf(
            (error): error is CommandSessionUnavailable => error instanceof CommandSessionUnavailable,
            (second) => rebuild(second).pipe(Effect.andThen(execute)),
          ),
        ),
    ),
  )
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = SandboxConfig.load()
    const db = (yield* Database.Service).db
    if (!config.enabled)
      return Service.of({
        enabled: false,
        run: () => Effect.die(new Error("Sandbox provider is disabled")),
        interrupt: () => Effect.void,
        destroy: () => Effect.void,
        keepAlive: () => Effect.void,
        activity: () => Effect.void,
        release: () => Effect.void,
        isKeepAlive: () => Effect.succeed(false),
        sandboxId: () => Effect.succeed(null),
        boot: () => Effect.die(new Error("Sandbox provider is disabled")),
        snapshot: () => Effect.die(new Error("Sandbox provider is disabled")),
        latestSnapshot: () => Effect.succeed(null),
        deleteSnapshots: () => Effect.void,
        snapshotStats: () =>
          Effect.succeed({
            snapshots: {},
            total: 0,
            restoredTotal: 0,
            operations: {
              destroy: { byState: {}, total: 0 },
              refresh: { byState: {}, total: 0 },
            },
          }),
        fileStat: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileRead: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileReadBytes: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileWrite: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileDelete: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileList: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileFind: () => Effect.die(new Error("Sandbox provider is disabled")),
        isReady: () => Effect.succeed(false),
        endpoint: () => Effect.succeed({ _tag: "no-sandbox" } as const),
      })

    const entries = yield* Ref.make(new Map<string, Entry>())
    const creates = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())
    // Command-session creation is deduplicated per session: concurrent first
    // commands all observe an empty commandSessionID, so without a claim the
    // sandbox would end up with several leaked bash sessions.
    const sessionCreates = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())
    // One bash session is shared per sandbox and its state is not
    // concurrency-safe: commands must run one at a time per session (v1
    // serialized the same way).
    const commandLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>())
    // Isolated contexts are not persisted: they belong to one concrete Tool
    // operation and can be interrupted without disturbing sibling commands.
    const activeCommands = yield* Ref.make(new Map<string, Map<string, ActiveCommand>>())
    const isolatedGlobalLock = Semaphore.makeUnsafe(config.maxConcurrentCommandsGlobal)
    const isolatedSessionLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>())
    const isolatedSessionLock = (sessionID: string) =>
      Ref.modify(isolatedSessionLocks, (locks) => {
        const existing = locks.get(sessionID)
        if (existing) return [existing, locks] as const
        const created = Semaphore.makeUnsafe(config.maxConcurrentCommandsPerSession)
        const next = new Map(locks)
        next.set(sessionID, created)
        return [created, next] as const
      })

    const addActiveCommand = (sessionID: string, command: ActiveCommand) =>
      Ref.update(activeCommands, (all) => {
        const next = new Map(all)
        const commands = new Map(next.get(sessionID))
        commands.set(command.operationID, command)
        next.set(sessionID, commands)
        return next
      })

    const removeActiveCommand = (sessionID: string, operationID: string) =>
      Ref.update(activeCommands, (all) => {
        const current = all.get(sessionID)
        if (!current) return all
        const next = new Map(all)
        const commands = new Map(current)
        commands.delete(operationID)
        if (commands.size === 0) next.delete(sessionID)
        else next.set(sessionID, commands)
        return next
      })

    const connectionConfig = new ConnectionConfig({
      domain: config.domain,
      protocol: config.protocol,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      useServerProxy: config.useServerProxy,
      requestTimeoutSeconds: 120,
    })

    const snapshots = SandboxSnapshot.create({
      db,
      connectionConfig,
      ttlMs: config.snapshot.ttlMs,
      waitMs: config.snapshot.waitMs,
      deleteEnabled: config.snapshot.deleteEnabled,
    })
    const destroyOperations = SandboxSnapshotOperation.create(db, "destroy")
    const refreshOperations = SandboxSnapshotOperation.create(db, "refresh")

    const bus = yield* Bus.Service

    const drop = (sessionID: string) =>
      Ref.modify(entries, (map) => {
        const found = map.get(sessionID) ?? null
        if (found) map.delete(sessionID)
        return [found, map] as const
      })

    const dbGet = (sessionID: string) =>
      db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).get().pipe(Effect.orDie)

    // Child sessions (subagents) must reuse the root session's sandbox: without
    // this mapping every child would provision its own empty /workspace and
    // lose sight of the parent's files (v1 resolveSandboxOpts semantics). All
    // sandbox state — in-memory entries, PG rows, command sessions — keys off
    // the resolved root sessionID. The parent chain is immutable once written,
    // so the mapping is cached without expiry.
    const sandboxKeys = yield* Ref.make(new Map<string, string>())
    const resolveSandboxKey = (sessionID: string) =>
      Effect.gen(function* () {
        const cached = yield* Ref.modify(sandboxKeys, (map) => [map.get(sessionID) ?? null, map] as const)
        if (cached) return cached
        const root = yield* rootSessionID(sessionID, (id) =>
          db
            .select({ parentID: SessionTable.parent_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionSchema.ID.make(id)))
            .get()
            .pipe(Effect.orDie),
        )
        yield* Ref.update(sandboxKeys, (map) => map.set(sessionID, root))
        return root
      }).pipe(Effect.withSpan("SandboxProvider.resolveSandboxKey"))

    const dbSetKeepAlive = (sessionID: string, keep_alive: boolean) =>
      Effect.gen(function* () {
        const current = yield* dbGet(sessionID)
        if (current) {
          yield* db
            .update(SandboxTable)
            .set({ keep_alive, time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, sessionID))
            .run()
            .pipe(Effect.orDie)
          return
        }
        yield* db
          .insert(SandboxTable)
          .values({
            id: `pending-${sessionID}`,
            session_id: sessionID,
            host: config.domain,
            state: "destroyed",
            keep_alive,
          })
          .onConflictDoUpdate({
            target: SandboxTable.session_id,
            set: { keep_alive, time_updated: Date.now() },
          })
          .run()
          .pipe(Effect.orDie)
      })

    const persistSandbox = (sessionID: string, sb: Sandbox) =>
      db
        .insert(SandboxTable)
        .values({
          id: sb.id,
          session_id: sessionID,
          host: config.domain,
          state: "running",
          keep_alive: false,
        })
        .onConflictDoUpdate({
          target: SandboxTable.session_id,
          set: { id: sb.id, host: config.domain, state: "running", time_updated: Date.now() },
        })
        .run()
        .pipe(Effect.orDie)

    const markDestroyed = (sessionID: string) =>
      db
        .update(SandboxTable)
        .set({ state: "destroyed", command_session_id: null, time_updated: Date.now() })
        .where(eq(SandboxTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

    const touchSandbox = (sessionID: string) =>
      db
        .update(SandboxTable)
        .set({ time_updated: Date.now() })
        .where(eq(SandboxTable.session_id, sessionID))
        .run()
        .pipe(Effect.orDie)

    const toolGate = SessionToolGate.make(db)

    // ---- Periodic OOM sampling (session.sandbox.oom / session.sandbox.pressure) ----
    // Baselines are process-local and keyed with the sandbox generation, so a
    // rebuilt sandbox's reset counter reads as a fresh baseline instead of a
    // negative delta. Sampling never touches the sandbox heartbeat: an idle
    // sandbox must still reap on schedule even while it is being sampled.
    const oomBaselines = new Map<string, SandboxOomSample.OomSample>()
    const oomPressureAt = new Map<string, number>()
    const OOM_PRESSURE_WINDOW_MS = 5 * 60_000
    const clearOomBaseline = (sessionID: string) => {
      for (const key of oomBaselines.keys()) if (key.startsWith(`${sessionID}:`)) oomBaselines.delete(key)
      for (const key of oomPressureAt.keys()) if (key.startsWith(`${sessionID}:`)) oomPressureAt.delete(key)
    }

    const destroySandbox = (sessionID: string) =>
      Effect.gen(function* () {
        clearOomBaseline(sessionID)
        yield* toolGate.close(sessionID, true).pipe(Effect.orDie)
        const active = yield* Ref.modify(activeCommands, (all) => {
          const found = all.get(sessionID) ?? new Map<string, ActiveCommand>()
          const next = new Map(all)
          next.delete(sessionID)
          return [Array.from(found.values()), next] as const
        })
        yield* Effect.forEach(
          active,
          (command) =>
            attempt(() => commandsOf(command.sandbox).interrupt(command.commandSessionID)).pipe(Effect.ignore),
          { discard: true },
        )
        const entry = yield* drop(sessionID)
        // Cancel any in-flight command-session claim so waiters fail fast
        // instead of hanging on a sandbox that is being torn down.
        const pendingSession = yield* Ref.modify(sessionCreates, (map) => {
          const found = map.get(sessionID) ?? null
          if (found) map.delete(sessionID)
          return [found, map] as const
        })
        if (pendingSession)
          yield* Deferred.fail(pendingSession, new Error(`Sandbox destroyed: ${sessionID}`)).pipe(Effect.ignore)
        const row = yield* dbGet(sessionID)
        let destroyed = false
        if (entry) {
          if (entry.commandSessionID)
            yield* attempt(() => commandsOf(entry.sb).deleteSession(entry.commandSessionID)).pipe(Effect.ignore)
          destroyed = yield* Effect.promise(() => entry.sb.kill()).pipe(
            Effect.as(true),
            Effect.catchCause((cause) => killResult(sessionID, entry.sb.id, cause)),
          )
          yield* attempt(() => entry.sb.close()).pipe(Effect.ignore)
        } else if (row && (row.state === "running" || row.state === "killed") && !row.id.startsWith("pending-")) {
          let gone = false
          const remote = yield* Effect.tryPromise({
            try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id, skipHealthCheck: true }),
            // Preserve the runtime exception as `cause`: a 404 (already gone)
            // must stay distinguishable from transport failures.
            catch: (cause) => new Error(`Sandbox reconnect failed: ${String(cause)}`, { cause }),
          }).pipe(
            Effect.catch((cause) => {
              gone = remoteSandboxGone(cause)
              return Effect.logWarning("Sandbox reconnect for delete failed", {
                sessionID,
                sandboxID: row.id,
                cause,
              }).pipe(Effect.as(null))
            }),
          )
          if (!remote) {
            // The runtime no longer knows this sandbox: the row must not
            // outlive it. Unknown failures keep the row for a later retry.
            if (!gone) return
            destroyed = true
          } else {
            destroyed = yield* Effect.promise(() => remote.kill()).pipe(
              Effect.as(true),
              Effect.catchCause((cause) => killResult(sessionID, row.id, cause)),
            )
            yield* attempt(() => remote.close()).pipe(Effect.ignore)
          }
        } else {
          destroyed = true
        }
        if (row && destroyed) yield* markDestroyed(sessionID)
        if (destroyed) yield* toolGate.destroyed(sessionID).pipe(Effect.orDie)
      })

    /** In-memory sandbox handle when connected, otherwise reconnect from the PG row. */
    const sandboxFor = (sessionID: string) =>
      Effect.gen(function* () {
        const entry = yield* Ref.modify(entries, (map) => [map.get(sessionID) ?? null, map] as const)
        if (entry) return entry.sb
        const row = yield* dbGet(sessionID)
        if (!row || row.state !== "running" || row.id.startsWith("pending-")) return null
        const connected = yield* Effect.tryPromise({
          try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id }),
          catch: (cause) => new Error(`Sandbox reconnect failed: ${String(cause)}`),
        }).pipe(Effect.catch(() => Effect.succeed(null)))
        return connected
      })

    /** Runs `work` while renewing the operation lease; a lost lease interrupts the work. */
    const withLease = <A, E, R>(
      operations: SandboxSnapshotOperation.SnapshotOperations,
      operation: { id: string; fencing_token: number },
      work: Effect.Effect<A, E, R>,
    ) =>
      Effect.gen(function* () {
        const heartbeat = yield* Effect.forever(
          Effect.gen(function* () {
            yield* Effect.sleep(Duration.seconds(60))
            const held = yield* operations.heartbeat(operation.id, operation.fencing_token)
            if (!held) return yield* Effect.interrupt
          }),
        ).pipe(Effect.forkChild)
        return yield* work.pipe(Effect.ensuring(Fiber.interrupt(heartbeat)))
      })

    /**
     * Take one snapshot with the lease held: marker (+ optional prune) before the
     * commit, then the await. Returns the settle result plus marker telemetry.
     */
    const snapshotWithMarker = (
      operations: SandboxSnapshotOperation.SnapshotOperations,
      operation: { id: string; fencing_token: number },
      sessionID: string,
      sandbox: Sandbox,
    ): Effect.Effect<{
      settled: "ready" | "failed" | "timeout"
      marker: { workspaceKb: number | null; arch: string | null }
      snapshotID: string
    }, Error> =>
      withLease(operations, operation, Effect.gen(function* () {
        const marker = yield* SandboxSnapshotReuse.touchSnapshotMarker(sandbox, { prune: config.snapshot.prune })
        const snapshotID = yield* snapshots.startSnapshot(sandbox.id, sessionID, { arch: marker.arch })
        const settled = yield* snapshots.awaitSnapshot(sessionID, snapshotID)
        return { settled, marker, snapshotID }
      }))

    const publishSnapshotReady = (sessionID: string, snapshotID: string, sourceSandboxID: string, marker: {
      workspaceKb: number | null
      arch: string | null
    }) =>
      bus
        .publish(SessionEvent.SandboxSnapshot.Ready, {
          sessionID: sessionID as SessionID,
          snapshotID,
          sourceSandboxID,
          ...(marker.workspaceKb !== null ? { workspaceKb: marker.workspaceKb } : {}),
          ...(config.snapshot.prune ? { pruned: true } : {}),
        })
        .pipe(Effect.catch(() => Effect.void))

    const drainSnapshotDestroyOperations = Effect.gen(function* () {
      for (let index = 0; index < 20; index++) {
        const operation = yield* destroyOperations.claim()
        if (!operation) break
        const result = yield* Effect.gen(function* () {
          if (!config.snapshot.enabled) return
          const sandboxRow = yield* dbGet(operation.session_id)
          if (sandboxRow && sandboxRow.state === "snapshotting" && !sandboxRow.id.startsWith("pending-")) {
            // The sandbox is claimed for destroy: reuse the last snapshot when
            // the workspace is provably unchanged, else take a final snapshot.
            const sb = yield* sandboxFor(operation.session_id)
            if (sb) {
              const restorableRows = yield* snapshots
                .restorable(operation.session_id)
                .pipe(Effect.catch(() => Effect.succeed([] as SandboxSnapshot.Row[])))
              const restorable = restorableRows[0] ?? null
              const unchanged =
                restorable !== null ? yield* SandboxSnapshotReuse.workspaceUnchangedSinceSnapshot(sb) : false
              if (restorable && unchanged) {
                yield* Effect.logInfo("snapshot reused (workspace unchanged)", {
                  sessionID: operation.session_id,
                  snapshotID: restorable.id,
                })
              } else {
                const outcome = yield* snapshotWithMarker(destroyOperations, operation, operation.session_id, sb).pipe(
                  Effect.result,
                )
                if (outcome._tag === "Failure") return yield* Effect.fail(outcome.failure)
                const { settled, marker, snapshotID } = outcome.success
                if (settled === "timeout")
                  return yield* Effect.fail(new Error("snapshot still creating; lease renewed, retry later"))
                if (settled === "failed") {
                  // T25.4b safety promise: a failed snapshot never destroys the source.
                  yield* db
                    .update(SandboxTable)
                    .set({ state: "running", time_updated: Date.now() })
                    .where(
                      and(eq(SandboxTable.session_id, operation.session_id), eq(SandboxTable.state, "snapshotting")),
                    )
                    .run()
                    .pipe(Effect.orDie)
                  return yield* Effect.fail(new Error("snapshot failed; source sandbox retained"))
                }
                yield* publishSnapshotReady(operation.session_id, snapshotID, sb.id, marker)
              }
            } else {
              // The row says snapshotting but the sandbox is gone (platform
              // hard recycle): converge the row; restore falls back to the
              // last ready snapshot (T25.35).
              yield* Effect.logWarning("sandbox gone before snapshot; converging row", {
                sessionID: operation.session_id,
              })
              yield* markDestroyed(operation.session_id)
              return
            }
          }
          yield* destroySandbox(operation.session_id)
        }).pipe(Effect.result)
        if (result._tag === "Success") {
          yield* destroyOperations.complete(operation.id, operation.fencing_token)
        } else {
          yield* destroyOperations.fail(operation.id, operation.fencing_token, String(result.failure), operation.attempts)
        }
      }
      yield* destroyOperations.retention().pipe(Effect.ignore)
    })

    /**
     * Periodic snapshot refresh (T25.33): renews the snapshot of an idle but
     * running sandbox without destroying it. Skips when the latest snapshot
     * already covers the last activity (T25.34).
     */
    const drainSnapshotRefreshOperations = Effect.gen(function* () {
      for (let index = 0; index < 20; index++) {
        const operation = yield* refreshOperations.claim()
        if (!operation) break
        const result = yield* Effect.gen(function* () {
          const sandboxRow = yield* dbGet(operation.session_id)
          if (!sandboxRow || sandboxRow.state !== "running" || sandboxRow.id.startsWith("pending-")) return
          const sb = yield* sandboxFor(operation.session_id)
          if (!sb) return
          const restorableRows = yield* snapshots
            .restorable(operation.session_id)
            .pipe(Effect.catch(() => Effect.succeed([] as SandboxSnapshot.Row[])))
          const restorable = restorableRows[0] ?? null
          if (restorable && (yield* SandboxSnapshotReuse.workspaceUnchangedSinceSnapshot(sb))) {
            yield* Effect.logInfo("snapshot refresh skipped (workspace unchanged)", {
              sessionID: operation.session_id,
              snapshotID: restorable.id,
            })
            return
          }
          const outcome = yield* snapshotWithMarker(refreshOperations, operation, operation.session_id, sb).pipe(
            Effect.result,
          )
          if (outcome._tag === "Failure") return yield* Effect.fail(outcome.failure)
          const { settled, marker, snapshotID } = outcome.success
          if (settled === "timeout") return yield* Effect.fail(new Error("refresh snapshot still creating"))
          if (settled === "failed") return yield* Effect.fail(new Error("refresh snapshot failed"))
          yield* publishSnapshotReady(operation.session_id, snapshotID, sb.id, marker)
        }).pipe(Effect.result)
        if (result._tag === "Success") {
          yield* refreshOperations.complete(operation.id, operation.fencing_token)
        } else {
          yield* refreshOperations.fail(operation.id, operation.fencing_token, String(result.failure), operation.attempts)
        }
      }
      yield* refreshOperations.retention().pipe(Effect.ignore)
    })

    /** Enqueue refresh work for snapshot sandboxes idle past the refresh window. */
    const enqueueSnapshotRefreshes = Effect.gen(function* () {
      if (config.snapshot.refreshSeconds <= 0) return
      const cutoff = Date.now() - config.snapshot.refreshSeconds * 1000
      const rows = yield* db
        .select({ session_id: SandboxTable.session_id, id: SandboxTable.id, time_updated: SandboxTable.time_updated })
        .from(SandboxTable)
        .where(and(eq(SandboxTable.state, "running"), lt(SandboxTable.time_updated, cutoff)))
        .limit(20)
        .all()
        .pipe(Effect.orDie)
      for (const row of rows) {
        const session = yield* db
          .select({ sandbox: SessionTable.sandbox })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(row.session_id)))
          .get()
          .pipe(Effect.orDie)
        const persistMode = session?.sandbox?.persistMode ?? config.volumeType
        if (persistMode !== "snapshot") continue
        // Covered-skip fast path (T25.34): a snapshot newer than the last
        // activity already reflects the workspace; no operation row needed.
        const latest = yield* snapshots.getLatest(row.session_id).pipe(Effect.catch(() => Effect.succeed([] as SandboxSnapshot.Row[])))
        const latestRow = latest[0]
        if (latestRow && latestRow.state === "ready" && latestRow.time_created >= row.time_updated) continue
        yield* refreshOperations
          .enqueue({ sessionID: row.session_id, sandboxID: row.id, kind: "snapshot_refresh" })
          .pipe(Effect.ignore)
      }
      yield* drainSnapshotRefreshOperations
    })

    /**
     * Explicit destroy (kill-sandbox API, keepalive release) for snapshot
     * sessions goes through the durable queue so the final snapshot happens
     * before the kill even when this instance dies mid-flight; every other
     * session destroys inline as before.
     */
    const destroyViaQueue = (sessionID: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (!config.snapshot.enabled) return yield* destroySandbox(sessionID)
        const session = yield* db
          .select({ sandbox: SessionTable.sandbox })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
          .get()
          .pipe(Effect.orDie)
        const persistMode = session?.sandbox?.persistMode ?? config.volumeType
        if (persistMode !== "snapshot") return yield* destroySandbox(sessionID)
        const row = yield* dbGet(sessionID)
        if (row && !row.id.startsWith("pending-") && row.state !== "destroyed") {
          yield* db
            .update(SandboxTable)
            .set({ state: "snapshotting", time_updated: Date.now() })
            .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.state, "running")))
            .run()
            .pipe(Effect.orDie)
          yield* destroyOperations
            .enqueue({ sessionID, sandboxID: row.id, kind: "snapshot_destroy" })
            .pipe(Effect.ignore)
          yield* drainSnapshotDestroyOperations
          return
        }
        yield* destroySandbox(sessionID)
      })

    const releaseSandbox = (sessionID: string) =>
      Effect.gen(function* () {
        yield* dbSetKeepAlive(sessionID, false)
        yield* destroyViaQueue(sessionID)
      })

    const isKeepAlive = (sessionID: string) => Effect.map(dbGet(sessionID), (row) => Boolean(row?.keep_alive))
    const sandboxId = (sessionID: string) =>
      Effect.map(dbGet(sessionID), (row) =>
        row?.state === "running" && !row.id.startsWith("pending-") ? row.id : null,
      )

    const createSandbox = (sessionID: string) =>
      Effect.gen(function* () {
        const session = yield* db
          .select({ sandbox: SessionTable.sandbox, pvcMode: SessionTable.pvc_mode, appId: SessionTable.app_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
          .get()
          .pipe(Effect.orDie)
        const persistMode = session?.sandbox?.persistMode ?? config.volumeType
        const volumes = SandboxVolumes.buildVolumes(
          {
            sessionID,
            pvcMode: session?.pvcMode ?? undefined,
            appId: session?.appId ?? undefined,
            persistMode: session?.sandbox?.persistMode,
          },
          config,
        )
        yield* Effect.logInfo("sandbox creating", { sessionID, volumeType: persistMode, volumes: volumes.length })
        // Snapshot restore: with a restorable snapshot the sandbox boots from
        // it (image and snapshotId are mutually exclusive in the SDK). A failed
        // restore marks the snapshot failed and falls back to a cold image
        // start so the session is never blocked by a bad snapshot.
        let restorable =
          persistMode === "snapshot" && config.snapshot.enabled
            ? yield* snapshots.resolveForCreate(sessionID)
            : null
        if (restorable?.schemaVersion != null && restorable.schemaVersion !== SandboxSnapshot.SCHEMA_VERSION) {
          const reason = `incompatible: schema ${restorable.schemaVersion} != ${SandboxSnapshot.SCHEMA_VERSION}`
          yield* snapshots.markRestoreFailed(sessionID, restorable.id, reason).pipe(Effect.ignore)
          yield* Effect.logWarning("snapshot schema is incompatible; falling back to cold start", {
            sessionID,
            snapshotID: restorable.id,
            reason,
          })
          restorable = null
        }
        // A timed-out or interrupted create cannot cancel the in-flight HTTP
        // request, so the created sandbox would leak. Track abandonment and
        // let the resolve path destroy what nobody is waiting for.
        const abandoned = yield* Ref.make(false)
        const timeoutSeconds = (yield* isKeepAlive(sessionID)) ? config.timeoutSeconds * 10 : config.timeoutSeconds
        const startedAt = Date.now()
        const attemptCreate = (create: { snapshotId: string } | { image: string }) =>
          Effect.tryPromise({
            try: async () => {
              // A union spread defeats the SDK's create overloads; narrow once.
              const options = {
                connectionConfig,
                timeoutSeconds,
                // The SDK's own readiness wait defaults to 60s; first pulls of
                // large images exceed that and fail client-side while the
                // remote sandbox is still converging.
                readyTimeoutSeconds: config.createTimeoutSeconds,
                resource: session?.sandbox ?? config.resource,
                // Ownership tag: cleanup tooling must only ever touch sandboxes
                // created by this service, never someone else's.
                metadata: { managedBy: "opencode-saas", session: sessionID },
                ...(volumes.length > 0 ? { volumes } : {}),
                ...create,
              } as Parameters<typeof Sandbox.create>[0]
              const created = await Sandbox.create(options)
              if (await Effect.runPromise(Ref.get(abandoned))) {
                await created.kill().catch(() => {})
                await created.close().catch(() => {})
                throw new Error(`Sandbox creation abandoned: ${sessionID}`)
              }
              return created
            },
            catch: (cause) =>
              new Error(`Sandbox.create failed: ${cause instanceof Error ? cause.message : String(cause)}`),
          }).pipe(
            // Creation failures must surface in the server log, not only as a
            // failed command — silent `.catch(() => null)` paths hid outages.
            Effect.tapError((error) =>
              Effect.logError("sandbox create failed", { sessionID, ms: Date.now() - startedAt, error: error.message }),
            ),
            Effect.onInterrupt(() => Ref.set(abandoned, true)),
            Effect.timeoutOrElse({
              duration: Duration.seconds(config.createTimeoutSeconds),
              orElse: () =>
                Effect.gen(function* () {
                  yield* Ref.set(abandoned, true)
                  return yield* Effect.fail(
                    new Error(`Sandbox create timed out after ${config.createTimeoutSeconds}s: ${sessionID}`),
                  )
                }),
            }),
          )
        let sb: Sandbox | null = null
        if (restorable) {
          const restoredExit = yield* attemptCreate({ snapshotId: restorable.id }).pipe(Effect.result)
          const restored = restoredExit._tag === "Success" ? restoredExit.success : null
          if (restored) {
            sb = restored
            yield* snapshots.markConsumed(restorable.id).pipe(Effect.ignore)
            yield* bus
              .publish(SessionEvent.SandboxSnapshot.Restored, {
                sessionID: sessionID as SessionID,
                snapshotID: restorable.id,
              })
              .pipe(Effect.catch(() => Effect.void))
          } else {
            yield* Effect.logWarning("snapshot restore failed; falling back to cold start", {
              sessionID,
              snapshotID: restorable.id,
            })
            yield* snapshots.markRestoreFailed(sessionID, restorable.id, "restore failed: create failed").pipe(Effect.ignore)
          }
        }
        if (sb === null) sb = yield* attemptCreate({ image: resolveSessionImage(session?.sandbox, config.image) })
        if (volumes.length === 0) {
          // No volume is attached, so the workspace directory must exist before
          // the first command can cd into it. Volume mounts provide it already.
          yield* attempt(() => commandsOf(sb).run("mkdir -p /workspace")).pipe(Effect.ignore)
        }
        yield* persistSandbox(sessionID, sb)
        yield* Effect.logInfo("sandbox created", { sessionID, sandboxID: sb.id, ms: Date.now() - startedAt })
        return sb
      }).pipe(Effect.withSpan("SandboxProvider.createSandbox"))

    const getOrCreate = (sessionID: string) =>
      Effect.gen(function* () {
        const myToken = yield* Deferred.make<Sandbox, Error>()
        const winner = yield* Ref.modify(creates, (map) => {
          const existing = map.get(sessionID)
          if (existing) return [existing, map] as const
          return [myToken, map.set(sessionID, myToken)] as const
        })
        if (winner !== myToken) return yield* Deferred.await(winner)

        const resolve = Effect.gen(function* () {
          const entry = yield* Ref.modify(entries, (map) => [map.get(sessionID) ?? null, map] as const)
          const sb = yield* Effect.gen(function* () {
            if (!entry) {
              const row = yield* dbGet(sessionID)
              if (row?.state === "running" && !row.id.startsWith("pending-")) {
                const connected = yield* Effect.tryPromise({
                  try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id }),
                  catch: (cause) => new Error(`Sandbox reconnect failed: ${String(cause)}`),
                }).pipe(Effect.catch(() => Effect.succeed(null)))
                if (connected) {
                  yield* Ref.update(entries, (map) =>
                    map.set(sessionID, { sb: connected, commandSessionID: row.command_session_id ?? "" }),
                  )
                  return connected
                }
              }
              return yield* createSandbox(sessionID)
            }
            const healthy = yield* Effect.promise(() => entry.sb.isHealthy()).pipe(
              Effect.catchCause(() => Effect.succeed(false)),
            )
            if (healthy) return entry.sb
            yield* Effect.logWarning("sandbox unhealthy, rebuilding", { sessionID })
            yield* destroySandbox(sessionID)
            return yield* createSandbox(sessionID)
          })
          // Register every created sandbox here — file-only paths never touch
          // the command session, and readiness checks, health rebuilds, and
          // destroy all key off this entry.
          yield* Ref.modify(entries, (map) => {
            const previous = map.get(sessionID)
            if (previous?.sb === sb) return [undefined, map] as const
            map.set(sessionID, { sb, commandSessionID: "" })
            return [undefined, map] as const
          })
          yield* touchSandbox(sessionID)
          yield* Deferred.succeed(myToken, sb)
          return sb
        })

        // Creation runs in a detached fiber: if the waiting request gives up
        // (client disconnect, 90s budget) the create still runs to completion
        // and succeeds the token, so a retry joins the in-flight creation via
        // `creates` instead of starting a second sandbox. `ensuring` guarantees
        // the token is always reclaimed, even on interruption, so no later
        // command can wait on a Deferred that will never settle.
        const creation = resolve.pipe(
          Effect.catch((error) =>
            Deferred.fail(myToken, error).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              const removed = yield* Ref.modify(creates, (map) => {
                if (map.get(sessionID) !== myToken) return [false, map] as const
                map.delete(sessionID)
                return [true, map] as const
              })
              if (removed)
                yield* Deferred.fail(myToken, new Error(`Sandbox creation interrupted: ${sessionID}`)).pipe(
                  Effect.ignore,
                )
            }),
          ),
          Effect.withSpan("SandboxProvider.resolveSandbox"),
        )
        yield* Effect.forkDetach(creation)
        return yield* Deferred.await(myToken)
      })

    /**
     * Resolve the live sandbox for preview-style routes without ever creating
     * one: a cached unhealthy entry or a missing running row reports null so
     * the HTTP layer can answer 502 immediately instead of blocking behind a
     * remote create. A known running row is reconnected and cached read-only.
     */
    const resolveExisting = (sessionID: string) =>
      Effect.gen(function* () {
        const entry = yield* Ref.modify(entries, (map) => [map.get(sessionID) ?? null, map] as const)
        if (entry) {
          const healthy = yield* Effect.promise(() => entry.sb.isHealthy()).pipe(
            Effect.catchCause(() => Effect.succeed(false)),
          )
          return healthy ? entry.sb : null
        }
        const row = yield* dbGet(sessionID)
        if (!row || row.state !== "running" || row.id.startsWith("pending-")) return null
        const connected = yield* Effect.tryPromise({
          try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id, skipHealthCheck: true }),
          catch: (cause) => new Error(`Sandbox reconnect failed: ${String(cause)}`),
        }).pipe(Effect.catch(() => Effect.succeed(null)))
        if (!connected) return null
        yield* Ref.update(entries, (map) =>
          map.has(sessionID)
            ? map
            : map.set(sessionID, { sb: connected, commandSessionID: row.command_session_id ?? "" }),
        )
        return connected
      })

    /** Drop cached state after a sandbox-level disappearance so a retry rebuilds. */
    const invalidateSandbox = (sessionID: string) =>
      Effect.gen(function* () {
        clearOomBaseline(sessionID)
        yield* drop(sessionID)
        yield* Ref.modify(sessionCreates, (map) => {
          map.delete(sessionID)
          return [undefined, map] as const
        })
        yield* db
          .update(SandboxTable)
          .set({ command_session_id: null, time_updated: Date.now() })
          .where(eq(SandboxTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
      })

    const commandSession = (sessionID: string, sb: Sandbox) =>
      Effect.gen(function* () {
        const cached = yield* Ref.modify(entries, (map) => [map.get(sessionID)?.commandSessionID ?? "", map] as const)
        if (cached) return cached

        // Concurrent first commands all see an empty commandSessionID. Claim a
        // token so only one createSession runs; the rest await its result and
        // reuse it, otherwise the sandbox leaks duplicate bash sessions.
        const myToken = yield* Deferred.make<string, Error>()
        const winner = yield* Ref.modify(sessionCreates, (map) => {
          const existing = map.get(sessionID)
          if (existing) return [existing, map] as const
          return [myToken, map.set(sessionID, myToken)] as const
        })
        if (winner !== myToken) return yield* Deferred.await(winner)

        const creation = Effect.gen(function* () {
          // Re-check inside the claim: a previous winner may have populated it.
          const current = yield* Ref.modify(
            entries,
            (map) => [map.get(sessionID)?.commandSessionID ?? "", map] as const,
          )
          if (current) return current
          const id = yield* withOperationTimeout(
            Effect.tryPromise({
              try: () => commandsOf(sb).createSession({ workingDirectory: SandboxPath.WORKDIR }),
              catch: (cause) => new Error(`Failed to create command session: ${String(cause)}`),
            }),
            Math.max(1, Math.ceil(config.createTimeoutSeconds / 10)),
            "create command session",
          )
          yield* Ref.modify(entries, (map) => {
            const entry = map.get(sessionID)
            if (entry && !entry.commandSessionID) map.set(sessionID, { ...entry, commandSessionID: id })
            return [undefined, map] as const
          })
          yield* db
            .update(SandboxTable)
            .set({ command_session_id: id, time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, sessionID))
            .run()
            .pipe(Effect.orDie)
          yield* Deferred.succeed(myToken, id)
          return id
        }).pipe(
          Effect.catch((error) =>
            Deferred.fail(myToken, error).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              const removed = yield* Ref.modify(sessionCreates, (map) => {
                if (map.get(sessionID) !== myToken) return [false, map] as const
                map.delete(sessionID)
                return [true, map] as const
              })
              if (removed)
                yield* Deferred.fail(myToken, new Error(`Command session creation interrupted: ${sessionID}`)).pipe(
                  Effect.ignore,
                )
            }),
          ),
        )
        yield* Effect.forkDetach(creation)
        return yield* Deferred.await(myToken)
      })

    /**
     * Forget one poisoned persistent command context without tearing down its
     * sandbox. The compare-and-set guards prevent a late failure from clearing
     * a command session that a concurrent caller has already recreated.
     */
    const invalidateCommandSession = (sessionID: string, commandSessionID: string, sb?: Sandbox) =>
      Effect.gen(function* () {
        const invalidated = yield* Ref.modify(entries, (map) => {
          const entry = map.get(sessionID)
          if (!entry || entry.commandSessionID !== commandSessionID) return [null, map] as const
          map.set(sessionID, { ...entry, commandSessionID: "" })
          return [entry.sb, map] as const
        })
        if (!invalidated) return false
        yield* Ref.modify(commandLocks, (map) => {
          map.delete(commandSessionID)
          return [undefined, map] as const
        })
        yield* db
          .update(SandboxTable)
          .set({ command_session_id: null, time_updated: Date.now() })
          .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.command_session_id, commandSessionID)))
          .run()
          .pipe(Effect.orDie)
        // Cleanup cannot decide whether the context is reusable: it is already
        // invalid locally. Bound it so a broken control plane cannot block recovery.
        const cleanupSandbox = sb ?? invalidated
        if (cleanupSandbox)
          yield* withOperationTimeout(
            attempt(() => commandsOf(cleanupSandbox).deleteSession(commandSessionID)),
            5,
            "delete command session",
          ).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Failed to delete stale command session", { sessionID, commandSessionID, cause }),
            ),
            Effect.ignore,
          )
        return true
      })

    if (config.idleReapSeconds > 0) {
      const idleReap = Effect.gen(function* () {
        // Snapshot GC + reconciliation rides on the same 300s cadence.
        if (config.snapshot.enabled) yield* snapshots.gc().pipe(Effect.ignore)
        yield* drainSnapshotDestroyOperations
        yield* enqueueSnapshotRefreshes
        const cutoff = Date.now() - config.idleReapSeconds * 1000
        const candidates = yield* db
          .select({
            session_id: SandboxTable.session_id,
            time_updated: SandboxTable.time_updated,
            sandbox_state: SandboxTable.state,
          })
          .from(SandboxTable)
          .where(
            and(
              or(
                eq(SandboxTable.state, "running"),
                eq(SandboxTable.state, "killed"),
                eq(SandboxTable.state, "snapshotting"),
              ),
              lt(SandboxTable.time_updated, cutoff),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        for (const row of candidates) {
          if (row.sandbox_state === "snapshotting") {
            const sandbox = yield* dbGet(row.session_id)
            if (sandbox)
              yield* destroyOperations
                .enqueue({ sessionID: row.session_id, sandboxID: sandbox.id, kind: "snapshot_destroy" })
                .pipe(Effect.ignore)
            continue
          }
          // Snapshot-persisted sessions snapshot before the recycle destroys
          // the sandbox; killing mid-commit would fail the snapshot.
          const session = yield* db
            .select({ sandbox: SessionTable.sandbox })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionSchema.ID.make(row.session_id)))
            .get()
            .pipe(Effect.orDie)
          const persistMode = session?.sandbox?.persistMode ?? config.volumeType
          if (persistMode === "snapshot" && config.snapshot.enabled && row.sandbox_state === "running") {
            // Claim running→snapshotting with a CAS (safe across instances),
            // then hand the snapshot-then-destroy choreography to the durable
            // queue: any instance's worker picks it up and completes it.
            const claimedSnapshotting = yield* db
              .update(SandboxTable)
              .set({ state: "snapshotting", time_updated: Date.now() })
              .where(
                and(
                  eq(SandboxTable.session_id, row.session_id),
                  eq(SandboxTable.state, "running"),
                  eq(SandboxTable.time_updated, row.time_updated),
                ),
              )
              .returning({ id: SandboxTable.id })
              .all()
              .pipe(Effect.orDie)
            if (claimedSnapshotting.length === 0) continue
            yield* destroyOperations
              .enqueue({ sessionID: row.session_id, sandboxID: claimedSnapshotting[0].id, kind: "snapshot_destroy" })
              .pipe(Effect.ignore)
            continue
          }
          const claimed = yield* db
            .update(SandboxTable)
            .set({ state: "killed", time_updated: Date.now() })
            .where(
              and(
                eq(SandboxTable.session_id, row.session_id),
                or(eq(SandboxTable.state, "running"), eq(SandboxTable.state, "killed")),
                lt(SandboxTable.time_updated, cutoff),
                eq(SandboxTable.time_updated, row.time_updated),
              ),
            )
            .returning({ session_id: SandboxTable.session_id })
            .all()
            .pipe(Effect.orDie)
          if (claimed.length === 0) continue
          yield* destroySandbox(row.session_id).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Idle sandbox reap failed", { ...row, cause })),
          )
        }
        // Work enqueued by this scan drains immediately on this instance;
        // the other instances pick up whatever their lease window lets them.
        yield* drainSnapshotDestroyOperations
      })
      yield* idleReap.pipe(
        Effect.andThen(Effect.sleep(Duration.seconds(300))),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
    }

    if (config.oomScan.enabled) {
      const bus = yield* Bus.Service
      yield* Effect.logInfo("sandbox OOM scan task started", {
        intervalSeconds: config.oomScan.intervalSeconds,
        batch: config.oomScan.batch,
        pressureRatio: config.oomScan.pressureRatio,
      })
      const oomScan = Effect.gen(function* () {
        const rows = yield* db
          .select({ session_id: SandboxTable.session_id, id: SandboxTable.id })
          .from(SandboxTable)
          .where(eq(SandboxTable.state, "running"))
          .orderBy(desc(SandboxTable.time_updated))
          .limit(config.oomScan.batch)
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          // Only sample sandboxes this process owns; a stale row for a sandbox
          // connected elsewhere stays untouched instead of being recreated by
          // the sampler.
          const entry = yield* Ref.modify(entries, (map) => [map.get(row.session_id) ?? null, map] as const)
          if (!entry) continue
          const sampleExit = yield* SandboxOomSample.sampleSandbox(commandsOf(entry.sb)).pipe(Effect.result)
          const sample = sampleExit._tag === "Success" ? sampleExit.success : null
          if (sample === null) {
            yield* Effect.logWarning("sandbox OOM sample failed", {
              sessionID: row.session_id,
              error: sampleExit._tag === "Failure" ? String(sampleExit.failure) : "unknown",
            })
            clearOomBaseline(row.session_id)
            continue
          }
          const key = `${row.session_id}:${row.id}`
          const now = Date.now()
          const classification = SandboxOomSample.classifyOomSample({
            sessionID: row.session_id,
            sandboxID: row.id,
            prev: oomBaselines.get(key),
            sample,
            now,
            pressureRatio: config.oomScan.pressureRatio,
          })
          oomBaselines.set(key, sample)
          if (classification.kind === "oom") {
            yield* Effect.logWarning("sandbox OOM detected", {
              sessionID: row.session_id,
              sandboxID: row.id,
              delta: classification.oomKillDelta,
              total: classification.oomKillTotal,
            })
            yield* bus
              .publish(SessionEvent.SandboxOom.Oom, {
                sessionID: row.session_id as SessionID,
                sandboxID: row.id,
                oomKillDelta: classification.oomKillDelta,
                oomKillTotal: classification.oomKillTotal,
                ...(classification.usageBytes !== null ? { usageBytes: classification.usageBytes } : {}),
                ...(classification.limitBytes !== null ? { limitBytes: classification.limitBytes } : {}),
              })
              .pipe(Effect.catch(() => Effect.void))
          } else if (classification.kind === "pressure") {
            // One pressure event per sandbox per window: a sandbox sitting at
            // the threshold must not flood the durable session log.
            if (now - (oomPressureAt.get(key) ?? 0) < OOM_PRESSURE_WINDOW_MS) continue
            oomPressureAt.set(key, now)
            yield* bus
              .publish(SessionEvent.SandboxOom.Pressure, {
                sessionID: row.session_id as SessionID,
                sandboxID: row.id,
                pct: classification.pct,
                usageBytes: classification.usageBytes,
                limitBytes: classification.limitBytes,
              })
              .pipe(Effect.catch(() => Effect.void))
          }
        }
      })
      yield* oomScan.pipe(
        Effect.andThen(Effect.sleep(Duration.seconds(config.oomScan.intervalSeconds))),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
    }

    // A sandbox can be reaped (idle, OOM, pod restart) while a turn is paused
    // on the user. The first command after resuming then hits stale state.
    // Retrying once after invalidating the cache is safe: a gone sandbox can
    // never have executed the command. Command-session failures are handled
    // separately below because replay is not generally safe for them.
    const withRecreateRetry = <A, E, R>(sessionID: string, attempt: () => Effect.Effect<A, E, R>) =>
      attempt().pipe(
        Effect.catchIf(isSandboxGone, () =>
          Effect.gen(function* () {
            yield* Effect.logWarning("sandbox gone; recreating and retrying command once", { sessionID })
            yield* invalidateSandbox(sessionID)
            return yield* attempt()
          }),
        ),
      )

    /**
     * Binds the replay policy to this sandbox's repair/rebuild side effects. The policy itself
     * lives in `withCommandSessionRecovery` so it can be tested without a live sandbox.
     */
    const recoverCommandSession = <A, R>(
      sessionID: string,
      retryPolicy: RunInput["retryPolicy"],
      execute: () => Effect.Effect<A, Error, R>,
    ): Effect.Effect<A, Error, R> =>
      withCommandSessionRecovery(
        retryPolicy,
        {
          repair: (error) =>
            invalidateCommandSession(sessionID, error.commandSessionID).pipe(
              Effect.tap(() =>
                Effect.logWarning("command session missing; invalidated stale session", {
                  sessionID,
                  commandSessionID: error.commandSessionID,
                }),
              ),
            ),
          rebuild: (error) =>
            Effect.gen(function* () {
              // Two fresh command contexts failed. For this explicitly safe
              // read, treat the command service as sandbox-level unhealthy.
              yield* Effect.logWarning("command session recovery failed; rebuilding sandbox for safe read", {
                sessionID,
                commandSessionID: error.commandSessionID,
              })
              yield* invalidateSandbox(sessionID)
            }),
        },
        execute,
      )

    return Service.of({
      enabled: true,
      keepAlive: (sessionID) => Effect.flatMap(resolveSandboxKey(sessionID), (key) => dbSetKeepAlive(key, true)),
      activity: (sessionID) => Effect.gen(function* () {
        const key = yield* resolveSandboxKey(sessionID)
        yield* touchSandbox(key)
        yield* Effect.forkScoped(Effect.sleep("5 seconds").pipe(Effect.andThen(touchSandbox(key)), Effect.forever))
      }),
      release: (sessionID) => Effect.flatMap(resolveSandboxKey(sessionID), releaseSandbox),
      isKeepAlive: (sessionID) => Effect.flatMap(resolveSandboxKey(sessionID), isKeepAlive),
      sandboxId: (sessionID) => Effect.flatMap(resolveSandboxKey(sessionID), sandboxId),
      boot: (sessionID: string) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) => Effect.map(getOrCreate(key), (sb) => sb.id)),
      destroy: (sessionID: string) => Effect.flatMap(resolveSandboxKey(sessionID), destroyViaQueue),

      snapshot: (sessionID) =>
        Effect.gen(function* () {
          if (!config.snapshot.enabled)
            return yield* Effect.fail(new Error("Sandbox snapshots are disabled (OPENCODE_SANDBOX_SNAPSHOT_ENABLED)"))
          const key = yield* resolveSandboxKey(sessionID)
          const session = yield* db
            .select({ sandbox: SessionTable.sandbox })
            .from(SessionTable)
            .where(eq(SessionTable.id, SessionSchema.ID.make(key)))
            .get()
            .pipe(Effect.orDie)
          const persistMode = session?.sandbox?.persistMode ?? config.volumeType
          if (persistMode !== "snapshot")
            return yield* Effect.fail(
              new Error(`Session does not persist via snapshots (persist mode: ${persistMode})`),
            )
          const sb = yield* getOrCreate(key)
          // Explicit snapshots never reuse (the caller asked for "now"); the
          // marker + manifest are written first so the commit captures them.
          const marker = yield* SandboxSnapshotReuse.touchSnapshotMarker(sb, { prune: config.snapshot.prune })
          const snapshotID = yield* snapshots.startSnapshot(sb.id, key, {
            image: resolveSessionImage(session?.sandbox, config.image),
            arch: marker.arch,
          })
          // Settle in the background: the caller gets the id immediately and
          // follows the state via GET or the durable session events.
          yield* Effect.forkDetach(
            Effect.gen(function* () {
              const result = yield* snapshots.awaitSnapshot(key, snapshotID)
              if (result === "ready") {
                yield* publishSnapshotReady(key, snapshotID, sb.id, marker)
              } else if (result === "failed") {
                yield* bus
                  .publish(SessionEvent.SandboxSnapshot.Failed, {
                    sessionID: key as SessionID,
                    snapshotID,
                    reason: "snapshot failed",
                  })
                  .pipe(Effect.catch(() => Effect.void))
              }
            }),
          )
          return { snapshotID, state: "creating" }
        }),

      latestSnapshot: (sessionID) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.map(snapshots.getLatest(key), (rows) => {
            const row = rows[0]
            return row
              ? {
                  id: row.id,
                  state: row.state,
                  reason: row.reason ?? null,
                  createdAt: row.time_created,
                  restoredCount: row.restored_count,
                }
              : null
          }),
        ),

      deleteSnapshots: (sessionID) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) => snapshots.deleteAllForSession(key)),

      snapshotStats: (sessionID) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const session = yield* snapshots.stats(key)
            const destroy = yield* destroyOperations.stats(key)
            const refresh = yield* refreshOperations.stats(key)
            return { snapshots: session.snapshots, total: session.total, restoredTotal: session.restoredTotal,
              operations: { destroy, refresh } }
          }),
        ),

      run: (input) =>
        Effect.flatMap(resolveSandboxKey(input.sessionID), (key) => {
          const execute = withRecreateRetry(key, () =>
            recoverCommandSession(key, input.retryPolicy, () => {
              let ephemeralCommandSessionID: string | undefined
              let ephemeralSandbox: Sandbox | undefined
              let ephemeralOperationID: string | undefined
              return Effect.gen(function* () {
                // Bounded wait: a stale cache entry or a hanging control plane must
                // not pin the command Semaphore forever (v1 used 90s).
                const sb = yield* withOperationTimeout(
                  getOrCreate(key),
                  GET_OR_CREATE_TIMEOUT_SECONDS,
                  "get or create sandbox",
                )
                ephemeralSandbox = sb
                yield* touchSandbox(key)
                const commands = commandsOf(sb)
                const commandSessionID = input.isolated
                  ? yield* withOperationTimeout(
                      Effect.tryPromise({
                        try: () => commandsOf(sb).createSession({ workingDirectory: SandboxPath.WORKDIR }),
                        catch: (cause) => new Error(`Failed to create isolated command session: ${String(cause)}`),
                      }),
                      Math.max(1, Math.ceil(config.createTimeoutSeconds / 10)),
                      "create isolated command session",
                    )
                  : yield* commandSession(key, sb)
                if (input.isolated) ephemeralCommandSessionID = commandSessionID
                if (input.isolated) {
                  ephemeralOperationID = input.operationID ?? commandSessionID
                  yield* addActiveCommand(key, {
                    operationID: ephemeralOperationID,
                    commandSessionID,
                    sandbox: sb,
                  })
                }
                const workingDirectory = input.cwd
                  ? SandboxPath.toSandboxCwd(input.cwd, input.hostWorkdir)
                  : SandboxPath.WORKDIR
                const timeoutMs = input.timeoutMs ?? 0
                const timeoutSeconds = timeoutMs > 0 ? Math.ceil(timeoutMs / 1000) : 0

                const controller = new AbortController()
                const stdout: string[] = []
                const stderr: string[] = []
                let errorValue: string | undefined
                let exitCode: number | null = null
                let completed = false

                // `tryPromise` (not `promise`) so a transport throw such as "context not found"
                // becomes a typed failure the callers can degrade on, instead of a defect that
                // bypasses `mapError`/`catchTag` and kills the whole turn.
                const consume = Effect.tryPromise({
                  try: async () => {
                    for await (const event of commands.runInSessionStream(
                      commandSessionID,
                      input.command,
                      { workingDirectory, ...(timeoutSeconds > 0 ? { timeoutSeconds } : {}) },
                      controller.signal,
                    )) {
                      switch (event.type) {
                        case "stdout":
                          stdout.push(event.text ?? "")
                          break
                        case "stderr":
                          stderr.push(event.text ?? "")
                          break
                        case "error":
                          errorValue = String(event.error?.evalue ?? event.error?.value ?? "")
                          return
                        case "execution_complete":
                          if (errorValue === undefined) exitCode = 0
                          completed = true
                          return
                      }
                    }
                  },
                  catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
                }).pipe(
                  Effect.mapError((cause) =>
                    isCommandSessionGone(cause) ? new CommandSessionUnavailable(commandSessionID, cause) : cause,
                  ),
                )

                // A timed-out command keeps running in the sandbox, and the SDK
                // interrupt leaves the persistent session in an immediately-EOF
                // state. Recycle the command session so the next command rebuilds a
                // clean one instead of reading crossed-over output.
                const recycle = () => invalidateCommandSession(key, commandSessionID, sb)

                let timedOut = false
                const guarded =
                  timeoutSeconds > 0
                    ? consume.pipe(
                        Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
                        Effect.timeoutOrElse({
                          // The execution deadline must expire *before* the outer
                          // queue budget (timeout + grace) so timeouts are reported
                          // as command timeouts, not queue waits. The interrupt +
                          // recycle fallback in `orElse` absorbs slow stream
                          // teardown, replacing the previous +15s slack.
                          duration: Duration.seconds(timeoutSeconds),
                          orElse: () =>
                            Effect.gen(function* () {
                              timedOut = true
                              yield* attempt(() => commands.interrupt(commandSessionID)).pipe(Effect.ignore)
                              yield* recycle().pipe(Effect.catchCause(() => Effect.void))
                            }),
                        }),
                      )
                    : consume.pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
                const heartbeat = Effect.sleep(
                  Duration.seconds(Math.max(5, Math.min(60, Math.floor(config.idleReapSeconds / 3)))),
                ).pipe(Effect.andThen(touchSandbox(key)), Effect.forever)
                const lock = yield* Ref.modify(commandLocks, (map) => {
                  const existing = map.get(commandSessionID)
                  if (existing) return [existing, map] as const
                  const created = Semaphore.makeUnsafe(1)
                  map.set(commandSessionID, created)
                  return [created, map] as const
                })
                const execute = Effect.raceFirst(guarded, heartbeat)
                if (timeoutSeconds > 0)
                  yield* withSemaphoreWaitTimeout(lock, execute, timeoutSeconds, "command queue wait")
                else yield* lock.withPermits(1)(execute)

                if (timedOut) {
                  const partial = [assembleStreamText(stdout), assembleStreamText(stderr)]
                    .filter((part) => part.length > 0)
                    .join("\n")
                  return {
                    exitCode: null,
                    output: `${partial}\n\nCommand exceeded timeout of ${timeoutMs} ms.`,
                    timedOut: true,
                  } satisfies ExecutionResult
                }
                // No completion, no error and no exit code means the SDK silently
                // drained a dead command session. Surface the narrower typed error
                // so only an explicitly safe read can be replayed.
                if (!completed && errorValue === undefined && exitCode === null) {
                  return yield* Effect.fail(
                    new CommandSessionUnavailable(
                      commandSessionID,
                      new Error(
                        `runInSession failed: command session ${commandSessionID} not found (empty execution stream)`,
                      ),
                    ),
                  )
                }
                if (errorValue !== undefined && isCommandSessionGone(new Error(errorValue)))
                  return yield* Effect.fail(new CommandSessionUnavailable(commandSessionID, new Error(errorValue)))
                if (errorValue !== undefined && /^-?\d+$/.test(errorValue.trim())) exitCode = Number(errorValue.trim())
                if (exitCode === 137)
                  yield* Effect.logWarning("command killed by SIGKILL — likely sandbox memory OOM", {
                    sessionID: key,
                    sandboxID: sb.id,
                    command: input.command.slice(0, 80),
                  })
                return {
                  exitCode,
                  output: [assembleStreamText(stdout), assembleStreamText(stderr)]
                    .filter((part) => part.length > 0)
                    .join("\n"),
                  timedOut: false,
                } satisfies ExecutionResult
              }).pipe(
                Effect.ensuring(
                  Effect.suspend(() =>
                    ephemeralCommandSessionID === undefined
                      ? Effect.void
                      : Effect.andThen(
                          ephemeralOperationID === undefined
                            ? Effect.void
                            : removeActiveCommand(key, ephemeralOperationID),
                          withOperationTimeout(
                            attempt(() => commandsOf(ephemeralSandbox!).deleteSession(ephemeralCommandSessionID!)),
                            5,
                            "delete isolated command session",
                          ).pipe(Effect.ignore),
                        ),
                  ),
                ),
              )
            }),
          ).pipe(
            Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
            Effect.withSpan("SandboxProvider.run"),
          )
          if (!input.isolated) return execute
          return Effect.flatMap(isolatedSessionLock(key), (sessionLock) =>
            isolatedGlobalLock.withPermits(1)(sessionLock.withPermits(1)(execute)),
          )
        }),

      interrupt: (sessionID, operationID) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const active = yield* Ref.get(activeCommands)
            const isolated = active.get(key)
            const selected =
              operationID === undefined ? Array.from(isolated?.values() ?? []) : [isolated?.get(operationID)]
            yield* Effect.forEach(
              selected.filter((item): item is ActiveCommand => item !== undefined),
              (item) => attempt(() => commandsOf(item.sandbox).interrupt(item.commandSessionID)).pipe(Effect.ignore),
              { discard: true },
            )
            // Preserve legacy shared-session cancellation for existing callers.
            if (operationID !== undefined) return
            const entry = yield* Ref.modify(entries, (map) => [map.get(key) ?? null, map] as const)
            if (!entry?.commandSessionID) return
            yield* attempt(() => commandsOf(entry.sb).interrupt(entry.commandSessionID)).pipe(Effect.ignore)
          }),
        ),

      fileStat: (sessionID, sandboxPath) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* getOrCreate(key)
            const info = yield* withSandboxFilesTimeout({
              operation: "getFileInfo",
              path: sandboxPath,
              timeoutSeconds: config.filesTimeoutSeconds,
              retries: config.filesTimeoutRetries,
              run: async (signal) => {
                try {
                  const response = await sandboxFilesRequest(sb, "/files/info", sandboxPath, signal)
                  if (response.status === 404) return null
                  if (!response.ok) throw await sandboxFilesResponseError(response, "getFileInfo", sandboxPath)
                  const result = (await response.json()) as Record<string, { mode?: number; type?: string; size?: number }>
                  return result[sandboxPath] ?? null
                } catch (cause) {
                  if (isNotFound(cause)) return null
                  throw new Error(
                    `getFileInfo failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                  )
                }
              },
            })
            if (!info) return null
            if (info.type === "directory" || isDirectoryMode(info.mode)) return { isDirectory: true }
            const hasModeType = typeof info.mode === "number" && (info.mode & 0o170000) !== 0
            if (info.type !== undefined || hasModeType)
              return { isDirectory: false, ...(typeof info.size === "number" ? { size: info.size } : {}) }
            const quoted = `'${sandboxPath.replaceAll("'", `'\\''`)}'`
            const command = `python3 -c 'import os,sys; print("1" if os.path.isdir(sys.argv[1]) else "0")' ${quoted}`
            const output = yield* Effect.tryPromise({
              try: async () => {
                const result = (await commandsOf(sb).run(command)) as {
                  logs?: { stdout?: Array<{ text?: string }> }
                }
                return result.logs?.stdout
                  ?.map((line) => line.text ?? "")
                  .join("")
                  .trim()
              },
              catch: (cause) => new Error(`Could not determine file type for ${sandboxPath}: ${String(cause)}`),
            })
            return {
              isDirectory: output === "1",
              ...(typeof info.size === "number" ? { size: info.size } : {}),
            }
          }).pipe(Effect.withSpan("SandboxProvider.fileStat")),
        ),

      fileRead: (sessionID, sandboxPath) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* getOrCreate(key)
            return yield* withSandboxFilesTimeout({
              operation: "readFile",
              path: sandboxPath,
              timeoutSeconds: config.filesTimeoutSeconds,
              retries: config.filesTimeoutRetries,
              run: async (signal) => {
                try {
                  const response = await sandboxFilesRequest(sb, "/files/download", sandboxPath, signal)
                  if (response.status === 404) return null
                  if (!response.ok) throw await sandboxFilesResponseError(response, "readFile", sandboxPath)
                  return new TextDecoder("utf-8").decode(await response.arrayBuffer())
                } catch (cause) {
                  if (isNotFound(cause)) return null
                  throw new Error(
                    `readFile failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                  )
                }
              },
            })
          }).pipe(Effect.withSpan("SandboxProvider.fileRead")),
        ),

      fileReadBytes: (sessionID, sandboxPath, opts) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* getOrCreate(key)
            return yield* withSandboxFilesTimeout({
              operation: "readBytes",
              path: sandboxPath,
              timeoutSeconds: config.filesTimeoutSeconds,
              retries: config.filesTimeoutRetries,
              run: async (signal) => {
                try {
                  const response = await sandboxFilesRequest(sb, "/files/download", sandboxPath, signal, opts?.range)
                  if (response.status === 404) return null
                  if (!response.ok) throw await sandboxFilesResponseError(response, "readBytes", sandboxPath)
                  return new Uint8Array(await response.arrayBuffer())
                } catch (cause) {
                  if (isNotFound(cause)) return null
                  throw new Error(
                    `readBytes failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                  )
                }
              },
            })
          }).pipe(Effect.withSpan("SandboxProvider.fileReadBytes")),
        ),

      fileWrite: (sessionID, sandboxPath, data) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* getOrCreate(key)
            // The files API does not create parent directories; sandboxes here
            // run without a volume, so nested paths need them first.
            const parent = sandboxPath.slice(0, sandboxPath.lastIndexOf("/"))
            if (parent.length > 0)
              yield* attempt(() => filesOf(sb).createDirectories([{ path: parent }])).pipe(Effect.ignore)
            yield* Effect.tryPromise({
              try: () => filesOf(sb).writeFiles([{ path: sandboxPath, data }]),
              catch: (cause) =>
                new Error(
                  `writeFiles failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                ),
            })
          }).pipe(Effect.withSpan("SandboxProvider.fileWrite")),
        ),

      fileDelete: (sessionID, sandboxPath) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* getOrCreate(key)
            yield* Effect.tryPromise({
              try: () => filesOf(sb).deleteFiles([sandboxPath]),
              catch: (cause) =>
                new Error(
                  `deleteFiles failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                ),
            })
          }).pipe(Effect.withSpan("SandboxProvider.fileDelete")),
        ),

      fileList: (sessionID, sandboxPath) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* getOrCreate(key)
            const entries = yield* Effect.tryPromise({
              try: async () => {
                try {
                  return await filesOf(sb).listDirectory({ path: sandboxPath })
                } catch (cause) {
                  // Some OpenSandbox deployments expose file read/search APIs
                  // but fail the directory-list endpoint. Keep listing scoped
                  // to the same sandbox and fall back to its command runtime.
                  const quoted = `'${sandboxPath.replaceAll("'", `'\\''`)}'`
                  const command = `cd ${quoted} && python3 -c 'import json,os; p="."; print(json.dumps([{"name":n,"isDirectory":os.path.isdir(os.path.join(p,n))} for n in os.listdir(p)]))'`
                  try {
                    const value = await commandsOf(sb).run(command)
                    if (typeof value !== "object" || value === null) throw cause
                    const result = value as {
                      error?: unknown
                      exitCode?: number | null
                      logs?: { stdout?: Array<{ text?: string }> }
                    }
                    if (result.error || (result.exitCode !== undefined && result.exitCode !== 0)) throw cause
                    const output = result.logs?.stdout?.map((line) => line.text ?? "").join("") ?? ""
                    const listed = JSON.parse(output) as Array<{ name: string; isDirectory: boolean }>
                    return listed.map((entry) => ({
                      name: entry.name,
                      mode: entry.isDirectory ? 0o040000 : 0o100000,
                      type: entry.isDirectory ? "directory" : "file",
                    }))
                  } catch {
                    throw cause
                  }
                }
              },
              catch: (cause) =>
                new Error(
                  `listDirectory failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                ),
            })
            return entries.map((entry) => {
              const listedPath = "path" in entry && typeof entry.path === "string" ? entry.path : undefined
              return {
                name: entry.name ?? listedPath?.replace(/\/+$/, "").split("/").at(-1) ?? "",
                isDirectory: entry.type === "directory" || isDirectoryMode(entry.mode),
              }
            })
          }).pipe(Effect.withSpan("SandboxProvider.fileList")),
        ),

      fileFind: (sessionID, sandboxPath, query) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* getOrCreate(key)
            const entries = yield* Effect.tryPromise({
              try: () => filesOf(sb).search({ path: sandboxPath, pattern: query }),
              catch: (cause) =>
                new Error(`search failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`),
            })
            return entries.map((entry) => {
              const rawPath = entry.path ?? entry.name ?? ""
              return {
                path: rawPath.startsWith("/") ? rawPath : rawPath.length > 0 ? `${sandboxPath}/${rawPath}` : rawPath,
                isDirectory: isDirectoryMode(entry.mode),
              }
            })
          }).pipe(Effect.withSpan("SandboxProvider.fileFind")),
        ),

      isReady: (sessionID) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) => Effect.map(Ref.get(entries), (map) => map.has(key))),

      endpoint: (sessionID, port, useServerProxy) =>
        Effect.flatMap(resolveSandboxKey(sessionID), (key) =>
          Effect.gen(function* () {
            const sb = yield* resolveExisting(key)
            if (!sb) return { _tag: "no-sandbox" } as const
            const endpoint = yield* Effect.tryPromise({
              try: async () => (await endpointsOf(sb).getSandboxEndpoint(sb.id, port, useServerProxy)).endpoint,
              catch: (cause) => new Error(`getSandboxEndpoint failed: ${String(cause)}`),
            }).pipe(Effect.catch(() => Effect.succeed(null)))
            // Every preview hit refreshes the activity watermark so a watched
            // preview keeps its sandbox alive the same way commands do.
            yield* touchSandbox(key)
            if (!endpoint) return { _tag: "resolve-failed" } as const
            return { _tag: "resolved" as const, sandboxId: sb.id, endpoint }
          }),
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, Bus.node] })
