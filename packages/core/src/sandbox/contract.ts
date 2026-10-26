import { Context, Effect } from "effect"

export interface ExecutionResult {
  readonly exitCode: number | null
  readonly output: string
  readonly timedOut: boolean
  readonly truncated?: boolean
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
  /**
   * Runs on a dedicated command context that is NOT deleted afterwards: the
   * caller wraps the command with nohup/& (v1 runDetached parity), and the
   * sandbox-side deleteSession would kill those background processes. The
   * leaked context is reclaimed when the sandbox is destroyed.
   */
  readonly detached?: boolean
  /** Stable caller identity used for targeted cancellation and observability. */
  readonly operationID?: string
}

/**
 * Outcome of resolving a sandbox port address. Proxy/preview routes must never
 * create a sandbox, so "no-sandbox" is reported instead of blocking behind a
 * remote create; "resolve-failed" keeps a live sandbox distinct from a gone one.
 */
export type EndpointResolution =
  | { readonly _tag: "resolved"; readonly sandboxId: string; readonly endpoint: string; readonly headers?: Readonly<Record<string, string>> }
  | { readonly _tag: "no-sandbox" }
  | { readonly _tag: "resolve-failed" }

export interface Interface {
  /** False keeps every tool on its local path; the layer is always present. */
  readonly enabled: boolean
  readonly run: (input: RunInput) => Effect.Effect<ExecutionResult, Error>
  /** Interrupt one operation, or every active command in the Session when omitted. */
  readonly interrupt: (sessionID: string, operationID?: string) => Effect.Effect<void>
  readonly destroy: (sessionID: string) => Effect.Effect<void>
  /** Permanent workspace removal, distinct from releasing running compute. */
  readonly purge?: (sessionID: string) => Effect.Effect<void>
  readonly keepAlive: (sessionID: string) => Effect.Effect<void>
  /** Scoped activity without booting or permanently enabling keepalive. */
  readonly activity: (sessionID: string) => Effect.Effect<void, never, import("effect").Scope.Scope>
  readonly release: (sessionID: string) => Effect.Effect<void>
  readonly isKeepAlive: (sessionID: string) => Effect.Effect<boolean>
  readonly sandboxId: (sessionID: string) => Effect.Effect<string | null>
  /** PG lifecycle truth; a non-running instance is not necessarily destroyed. */
  readonly lifecycle: (sessionID: string) => Effect.Effect<{
    readonly sandboxID: string | null
    readonly state: import("./sql.js").State | null
    readonly persistMode: string
  }>
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
  readonly latestSnapshot: (sessionID: string) => Effect.Effect<
    {
      readonly id: string
      readonly state: string
      readonly reason: string | null
      readonly createdAt: number
      readonly restoredCount: number
    } | null,
    Error
  >
  /** Delete every snapshot recorded for the session (remote deletion gated by config). */
  readonly deleteSnapshots: (sessionID: string) => Effect.Effect<void>
  /** Session snapshot + operation aggregates for observability. */
  readonly snapshotStats: (sessionID: string) => Effect.Effect<
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
