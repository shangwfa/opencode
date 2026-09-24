export * as SandboxProvider from "./provider.js"

import { ConnectionConfig, Sandbox } from "@alibaba-group/opensandbox"
import { Context, Deferred, Duration, Effect, Layer, Ref, Semaphore } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SandboxConfig } from "./config.js"
import { SandboxPath } from "./path.js"
import { Database } from "../database/database.js"
import { SandboxTable } from "./sql.js"
import { SessionTable } from "../session/sql.js"
import { SessionSchema } from "../session/schema.js"
import { and, eq, lt, or } from "drizzle-orm"

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
}

export interface Interface {
  /** False keeps every tool on its local path; the layer is always present. */
  readonly enabled: boolean
  readonly run: (input: RunInput) => Effect.Effect<ExecutionResult, Error>
  readonly interrupt: (sessionID: string) => Effect.Effect<void>
  readonly destroy: (sessionID: string) => Effect.Effect<void>
  readonly keepAlive: (sessionID: string) => Effect.Effect<void>
  readonly release: (sessionID: string) => Effect.Effect<void>
  readonly isKeepAlive: (sessionID: string) => Effect.Effect<boolean>
  readonly sandboxId: (sessionID: string) => Effect.Effect<string | null>
  readonly boot: (sessionID: string) => Effect.Effect<string, Error>
  /** null result means the path does not exist inside the sandbox. */
  readonly fileStat: (
    sessionID: string,
    sandboxPath: string,
  ) => Effect.Effect<{ readonly isDirectory: boolean } | null, Error>
  /** null result means the path does not exist inside the sandbox. */
  readonly fileRead: (sessionID: string, sandboxPath: string) => Effect.Effect<string | null, Error>
  /** Binary reads for the session-scoped fs.read route; null when absent. */
  readonly fileReadBytes: (sessionID: string, sandboxPath: string) => Effect.Effect<Uint8Array | null, Error>
  readonly fileWrite: (sessionID: string, sandboxPath: string, data: string) => Effect.Effect<void, Error>
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxProvider") {}

type Entry = {
  sb: Sandbox
  commandSessionID: string
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
  getFileInfo(paths: string[]): Promise<Record<string, { mode?: number; type?: string }>>
  readFile(path: string, opts?: { encoding?: string }): Promise<string>
  readBytes(path: string, opts?: { range?: string }): Promise<Uint8Array>
  writeFiles(entries: { path: string; data: string }[]): Promise<void>
  createDirectories(entries: { path: string }[]): Promise<void>
  listDirectory(entry: { path: string }): Promise<Array<{ name?: string; mode?: number; type?: string }>>
  search(entry: { path: string; pattern?: string }): Promise<Array<{ name?: string; path?: string; mode?: number }>>
}

const commandsOf = (sb: Sandbox): ExecCommands => sb.commands as unknown as ExecCommands

/**
 * execd emits one stdout/stderr stream event per output line with the trailing
 * newline stripped (empty lines produce no event at all). Reassembling with
 * "" would fuse every line into one, so line-oriented consumers (rg --files,
 * rg --json, shell output) need the parts joined back with "\n".
 */
export const assembleStreamText = (parts: ReadonlyArray<string>): string => parts.join("\n")

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
        release: () => Effect.void,
        isKeepAlive: () => Effect.succeed(false),
        sandboxId: () => Effect.succeed(null),
        boot: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileStat: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileRead: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileReadBytes: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileWrite: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileList: () => Effect.die(new Error("Sandbox provider is disabled")),
        fileFind: () => Effect.die(new Error("Sandbox provider is disabled")),
        isReady: () => Effect.succeed(false),
      })

    const entries = yield* Ref.make(new Map<string, Entry>())
    const creates = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())
    // One bash session is shared per sandbox and its state is not
    // concurrency-safe: commands must run one at a time per session (v1
    // serialized the same way).
    const commandLocks = yield* Ref.make(new Map<string, Semaphore.Semaphore>())

    const connectionConfig = new ConnectionConfig({
      domain: config.domain,
      protocol: config.protocol,
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      useServerProxy: config.useServerProxy,
      requestTimeoutSeconds: 120,
    })

    const drop = (sessionID: string) =>
      Ref.modify(entries, (map) => {
        const found = map.get(sessionID) ?? null
        if (found) map.delete(sessionID)
        return [found, map] as const
      })

    const dbGet = (sessionID: string) =>
      db.select().from(SandboxTable).where(eq(SandboxTable.session_id, sessionID)).get().pipe(Effect.orDie)

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

    const destroySandbox = (sessionID: string) =>
      Effect.gen(function* () {
        const entry = yield* drop(sessionID)
        const row = yield* dbGet(sessionID)
        let destroyed = false
        if (entry) {
          if (entry.commandSessionID)
            yield* Effect.promise(() => commandsOf(entry.sb).deleteSession(entry.commandSessionID)).pipe(Effect.ignore)
          destroyed = yield* Effect.promise(() => entry.sb.kill()).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("Sandbox delete failed", { sessionID, sandboxID: entry.sb.id, cause }).pipe(
                Effect.as(false),
              ),
            ),
          )
          yield* Effect.promise(() => entry.sb.close()).pipe(Effect.ignore)
        } else if (row && (row.state === "running" || row.state === "killed") && !row.id.startsWith("pending-")) {
          const remote = yield* Effect.tryPromise({
            try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id, skipHealthCheck: true }),
            catch: (cause) => new Error(`Sandbox reconnect failed: ${String(cause)}`),
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Sandbox reconnect for delete failed", { sessionID, sandboxID: row.id, cause }).pipe(
                Effect.as(null),
              ),
            ),
          )
          if (!remote) return
          destroyed = yield* Effect.promise(() => remote.kill()).pipe(
            Effect.as(true),
            Effect.catchCause((cause) =>
              Effect.logWarning("Sandbox delete failed", { sessionID, sandboxID: row.id, cause }).pipe(
                Effect.as(false),
              ),
            ),
          )
          yield* Effect.promise(() => remote.close()).pipe(Effect.ignore)
        } else {
          destroyed = true
        }
        if (row && destroyed) yield* markDestroyed(sessionID)
      })

    const releaseSandbox = (sessionID: string) =>
      Effect.gen(function* () {
        yield* dbSetKeepAlive(sessionID, false)
        yield* destroySandbox(sessionID)
      })

    const isKeepAlive = (sessionID: string) => Effect.map(dbGet(sessionID), (row) => Boolean(row?.keep_alive))
    const sandboxId = (sessionID: string) =>
      Effect.map(dbGet(sessionID), (row) =>
        row?.state === "running" && !row.id.startsWith("pending-") ? row.id : null,
      )

    const createSandbox = (sessionID: string) =>
      Effect.gen(function* () {
        yield* Effect.logInfo("sandbox creating", { sessionID })
        const session = yield* db
          .select({ sandbox: SessionTable.sandbox })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionSchema.ID.make(sessionID)))
          .get()
          .pipe(Effect.orDie)
        // A timed-out or interrupted create cannot cancel the in-flight HTTP
        // request, so the created sandbox would leak. Track abandonment and
        // let the resolve path destroy what nobody is waiting for.
        const abandoned = yield* Ref.make(false)
        const timeoutSeconds = (yield* isKeepAlive(sessionID)) ? config.timeoutSeconds * 10 : config.timeoutSeconds
        const sb = yield* Effect.tryPromise({
          try: async () => {
            const created = await Sandbox.create({
              connectionConfig,
              image: config.image,
              timeoutSeconds,
              // The SDK's own readiness wait defaults to 60s; first pulls of
              // large images exceed that and fail client-side while the
              // remote sandbox is still converging.
              readyTimeoutSeconds: config.createTimeoutSeconds,
              resource: session?.sandbox ?? config.resource,
              // Ownership tag: cleanup tooling must only ever touch sandboxes
              // created by this service, never someone else's.
              metadata: { managedBy: "opencode-saas", session: sessionID },
            })
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
        // No volume is attached, so the workspace directory must exist before
        // the first command can cd into it.
        yield* Effect.promise(() => commandsOf(sb).run("mkdir -p /workspace")).pipe(Effect.ignore)
        yield* persistSandbox(sessionID, sb)
        yield* Effect.logInfo("sandbox created", { sessionID, sandboxID: sb.id })
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
        if (winner !== myToken) return yield* Deferred.await(winner).pipe(Effect.orDie)

        const sb = yield* Effect.gen(function* () {
          const entry = yield* Ref.modify(entries, (map) => [map.get(sessionID) ?? null, map] as const)
          if (!entry) {
            const row = yield* dbGet(sessionID)
            if (row?.state === "running" && !row.id.startsWith("pending-")) {
              const connected = yield* Effect.tryPromise({
                try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id }),
                catch: (cause) => new Error(`Sandbox reconnect failed: ${String(cause)}`),
              }).pipe(Effect.catch(() => Effect.succeed(null)))
              if (connected) {
                yield* Ref.update(entries, (map) =>
                  map.set(sessionID, {
                    sb: connected,
                    commandSessionID: row.command_session_id ?? "",
                  }),
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
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Ref.modify(creates, (map) => {
                map.delete(sessionID)
                return [undefined, map] as const
              })
              yield* Deferred.fail(myToken, new Error("Sandbox creation failed")).pipe(Effect.ignore)
              return yield* Effect.failCause(cause)
            }),
          ),
        )

        yield* Ref.modify(creates, (map) => {
          map.delete(sessionID)
          return [undefined, map] as const
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
        yield* Deferred.succeed(myToken, sb)
        yield* touchSandbox(sessionID)
        return sb
      }).pipe(Effect.orDie)

    const commandSession = (sessionID: string, sb: Sandbox) =>
      Effect.gen(function* () {
        const existing = yield* Ref.modify(entries, (map) => [map.get(sessionID)?.commandSessionID ?? "", map] as const)
        if (existing) return existing
        const id = yield* Effect.tryPromise({
          try: () => commandsOf(sb).createSession({ workingDirectory: SandboxPath.WORKDIR }),
          catch: (cause) => new Error(`Sandbox command session failed: ${String(cause)}`),
        })
        yield* Ref.modify(entries, (map) => {
          const current = map.get(sessionID)
          if (current && !current.commandSessionID) map.set(sessionID, { ...current, commandSessionID: id })
          return [undefined, map] as const
        })
        yield* db
          .update(SandboxTable)
          .set({ command_session_id: id, time_updated: Date.now() })
          .where(eq(SandboxTable.session_id, sessionID))
          .run()
          .pipe(Effect.orDie)
        return id
      })

    if (config.idleReapSeconds > 0) {
      const idleReap = Effect.gen(function* () {
        const cutoff = Date.now() - config.idleReapSeconds * 1000
        const candidates = yield* db
          .select({ session_id: SandboxTable.session_id, time_updated: SandboxTable.time_updated })
          .from(SandboxTable)
          .where(
            and(
              or(eq(SandboxTable.state, "running"), eq(SandboxTable.state, "killed")),
              lt(SandboxTable.time_updated, cutoff),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        for (const row of candidates) {
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
      })
      yield* idleReap.pipe(
        Effect.andThen(Effect.sleep(Duration.seconds(300))),
        Effect.forever,
        Effect.forkScoped({ startImmediately: true }),
      )
    }

    return Service.of({
      enabled: true,
      keepAlive: (sessionID) => dbSetKeepAlive(sessionID, true),
      release: releaseSandbox,
      isKeepAlive,
      sandboxId,
      boot: (sessionID) => Effect.map(getOrCreate(sessionID), (sb) => sb.id),
      destroy: destroySandbox,

      run: (input) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(input.sessionID)
          yield* db
            .update(SandboxTable)
            .set({ time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, input.sessionID))
            .run()
            .pipe(Effect.orDie)
          const commands = commandsOf(sb)
          const commandSessionID = yield* commandSession(input.sessionID, sb)
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

          const consume = Effect.promise(async () => {
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
          })

          let timedOut = false
          const guarded =
            timeoutSeconds > 0
              ? consume.pipe(
                  Effect.onInterrupt(() => Effect.sync(() => controller.abort())),
                  Effect.timeoutOrElse({
                    duration: Duration.seconds(timeoutSeconds + 15),
                    orElse: () =>
                      Effect.gen(function* () {
                        timedOut = true
                        yield* Effect.promise(() => commands.interrupt(commandSessionID)).pipe(Effect.ignore)
                      }),
                  }),
                )
              : consume.pipe(Effect.onInterrupt(() => Effect.sync(() => controller.abort())))
          const heartbeat = Effect.sleep(
            Duration.seconds(Math.max(5, Math.min(60, Math.floor(config.idleReapSeconds / 3)))),
          ).pipe(Effect.andThen(touchSandbox(input.sessionID)), Effect.forever)
          const lock = yield* Ref.modify(commandLocks, (map) => {
            const existing = map.get(commandSessionID)
            if (existing) return [existing, map] as const
            const created = Semaphore.makeUnsafe(1)
            map.set(commandSessionID, created)
            return [created, map] as const
          })
          yield* lock.withPermits(1)(Effect.raceFirst(guarded, heartbeat))

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
          if (errorValue !== undefined && /^-?\d+$/.test(errorValue.trim())) exitCode = Number(errorValue.trim())
          void completed
          return {
            exitCode,
            output: [assembleStreamText(stdout), assembleStreamText(stderr)]
              .filter((part) => part.length > 0)
              .join("\n"),
            timedOut: false,
          } satisfies ExecutionResult
        }).pipe(
          Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))),
          Effect.withSpan("SandboxProvider.run"),
        ),

      interrupt: (sessionID) =>
        Effect.gen(function* () {
          const entry = yield* Ref.modify(entries, (map) => [map.get(sessionID) ?? null, map] as const)
          if (!entry?.commandSessionID) return
          yield* Effect.promise(() => commandsOf(entry.sb).interrupt(entry.commandSessionID)).pipe(Effect.ignore)
        }),

      fileStat: (sessionID, sandboxPath) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          const info = yield* Effect.tryPromise({
            try: async () => {
              const result: Record<string, { mode?: number; type?: string }> = await filesOf(sb)
                .getFileInfo([sandboxPath])
                .catch((cause) => {
                  if (isNotFound(cause)) return {}
                  throw cause
                })
              return result[sandboxPath] ?? null
            },
            catch: (cause) =>
              new Error(
                `getFileInfo failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
              ),
          })
          if (!info) return null
          if (info.type === "directory" || isDirectoryMode(info.mode)) return { isDirectory: true }
          const hasModeType = typeof info.mode === "number" && (info.mode & 0o170000) !== 0
          if (info.type !== undefined || hasModeType) return { isDirectory: false }
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
          return { isDirectory: output === "1" }
        }).pipe(Effect.withSpan("SandboxProvider.fileStat")),

      fileRead: (sessionID, sandboxPath) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          return yield* Effect.tryPromise({
            try: async () =>
              filesOf(sb)
                .readFile(sandboxPath, { encoding: "utf-8" })
                .catch((cause) => {
                  if (isNotFound(cause)) return null
                  throw cause
                }),
            catch: (cause) =>
              new Error(`readFile failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`),
          })
        }).pipe(Effect.withSpan("SandboxProvider.fileRead")),

      fileReadBytes: (sessionID, sandboxPath) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          return yield* Effect.tryPromise({
            try: async () =>
              filesOf(sb)
                .readBytes(sandboxPath)
                .catch((cause) => {
                  if (isNotFound(cause)) return null
                  throw cause
                }),
            catch: (cause) =>
              new Error(`readBytes failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`),
          })
        }).pipe(Effect.withSpan("SandboxProvider.fileReadBytes")),

      fileWrite: (sessionID, sandboxPath, data) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          // The files API does not create parent directories; sandboxes here
          // run without a volume, so nested paths need them first.
          const parent = sandboxPath.slice(0, sandboxPath.lastIndexOf("/"))
          if (parent.length > 0)
            yield* Effect.promise(() => filesOf(sb).createDirectories([{ path: parent }])).pipe(Effect.ignore)
          yield* Effect.tryPromise({
            try: () => filesOf(sb).writeFiles([{ path: sandboxPath, data }]),
            catch: (cause) =>
              new Error(`writeFiles failed: ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`),
          })
        }).pipe(Effect.withSpan("SandboxProvider.fileWrite")),

      fileList: (sessionID, sandboxPath) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
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

      fileFind: (sessionID, sandboxPath, query) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
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

      isReady: (sessionID) => Effect.map(Ref.get(entries), (map) => map.has(sessionID)),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node] })
