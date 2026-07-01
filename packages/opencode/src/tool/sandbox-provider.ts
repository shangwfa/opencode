import { Effect, Context, Layer, Cause, Deferred, Ref, Semaphore, Schedule, Duration } from "effect"
import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"
import type { CommandExecution, Volume } from "@alibaba-group/opensandbox"
import { and, eq, lt, sql } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@/flag/flag"
import type { SessionID } from "../session/schema"
import { Database } from "../storage/db"
import { SandboxTable } from "./sandbox.pg"

export namespace SandboxConfig {
  export interface Interface {
    readonly domain: string
    readonly protocol: "http" | "https"
    readonly apiKey: string
    readonly useServerProxy: boolean
    readonly image: string
    readonly timeoutSeconds: number
    readonly resourceLimits: Record<string, string>
    readonly volumeType: "none" | "pvc" | "host"
    readonly pvcClaimName: string
    readonly idleKillMs: number
    readonly maxTtlSeconds: number
    readonly packageCacheMount: string
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxConfig") {}

  export const defaultConfig: Interface = {
    domain: Flag.OPENCODE_SANDBOX_DOMAIN,
    protocol: "http" as const,
    apiKey: Flag.OPENCODE_SANDBOX_API_KEY,
    useServerProxy: Flag.OPENCODE_SANDBOX_USE_SERVER_PROXY,
    image: Flag.OPENCODE_SANDBOX_IMAGE,
    timeoutSeconds: Flag.OPENCODE_SANDBOX_TIMEOUT,
    resourceLimits: { cpu: "1", memory: "4Gi" },
    volumeType: Flag.OPENCODE_SANDBOX_VOLUME_TYPE,
    pvcClaimName: Flag.OPENCODE_SANDBOX_PVC_CLAIM,
    idleKillMs: Flag.OPENCODE_SANDBOX_IDLE_KILL_SEC * 1000,
    maxTtlSeconds: Flag.OPENCODE_SANDBOX_MAX_TTL_SEC,
    packageCacheMount: Flag.OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT,
  }

  export const layer = Layer.succeed(Service, Service.of(defaultConfig))
  export const defaultLayer = layer
}

type Entry =
  | { state: "running"; sb: Sandbox; sandboxID: string; lastActive: number }
  | { state: "killed"; sandboxID: string; lastActive: number }

export interface VolumeScope {
  readonly sessionID: string
  readonly pvcMode?: "session" | "app"
  readonly appId?: string
}

export function buildVolumes(scope: VolumeScope, config: SandboxConfig.Interface): Volume[] {
  if (config.volumeType === "none") return []

  // app 模式仅在 pvc 卷类型下生效，且必须有 appId，否则安全回退到 session 前缀
  const useApp = config.volumeType === "pvc" && scope.pvcMode === "app" && !!scope.appId?.trim()
  const prefix = useApp ? `apps/${scope.appId!.trim()}` : `sessions/${scope.sessionID}`
  const mounts = [
    { name: "workspace", mountPath: "/workspace", sub: `${prefix}/workspace` },
    { name: "home", mountPath: "/home/sandbox", sub: `${prefix}/home` },
    { name: "cache", mountPath: "/home/sandbox/.cache", sub: `${prefix}/cache` },
    { name: "config", mountPath: "/home/sandbox/.config", sub: `${prefix}/config` },
    { name: "local", mountPath: "/home/sandbox/.local", sub: `${prefix}/local` },
    { name: "tmp", mountPath: "/home/sandbox/tmp", sub: `${prefix}/tmp` },
  ]

  const result = mounts.map((m) => {
    const base: Volume = { name: m.name, mountPath: m.mountPath, subPath: m.sub }
    if (config.volumeType === "pvc") {
      base.pvc = { claimName: config.pvcClaimName }
    } else {
      base.host = { path: `/var/opencode/sessions/${scope.sessionID}/${m.name}` }
    }
    return base
  })

  if (config.volumeType === "pvc") {
    const packageCacheMount = requirePackageCacheMount(config.packageCacheMount, mounts.map((m) => m.mountPath))
    result.push({
      name: "package-cache",
      mountPath: packageCacheMount,
      subPath: "shared/package-cache",
      pvc: { claimName: config.pvcClaimName },
    })
  }

  return result
}

function requirePackageCacheMount(mountPath: string, reservedPaths: string[]) {
  const trimmed = mountPath.trim()
  const normalized = trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "")
  if (!normalized.startsWith("/") || normalized === "") {
    throw new Error(`OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT must be an absolute path, got ${JSON.stringify(mountPath)}`)
  }
  if (normalized === "/") {
    throw new Error("OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT cannot be /")
  }
  const conflict = reservedPaths.find(
    (reserved) => normalized === reserved || normalized.startsWith(`${reserved}/`) || reserved.startsWith(`${normalized}/`),
  )
  if (conflict) {
    throw new Error(`OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT conflicts with reserved mount path ${conflict}`)
  }
  return normalized
}

export function cleanupSessionVolume(
  sessionID: string,
  config: SandboxConfig.Interface,
  _connectionConfig: ConnectionConfig,
): Effect.Effect<void> {
  return Effect.logDebug("sandbox volume cleanup skipped", { sessionID, volumeType: config.volumeType }).pipe(
    Effect.withSpan("cleanupSessionVolume"),
  )
}

type CommandHandlers = {
  onStdout?: (msg: { text: string }) => void | Promise<void>
  onStderr?: (msg: { text: string }) => void | Promise<void>
  onEvent?: (ev: unknown) => void | Promise<void>
  onResult?: (res: unknown) => void | Promise<void>
  onExecutionComplete?: (c: unknown) => void | Promise<void>
  onError?: (err: unknown) => void | Promise<void>
  onInit?: (init: unknown) => void | Promise<void>
}

// SSE early-exit: consume runInSessionStream and return immediately on
// execution_complete/error instead of waiting for the HTTP connection to
// close. SDK's consumeExecutionStream keeps reader.read() blocked after
// execution_complete — multi-layer proxies (K8s ingress) can hold the
// connection open for 60-300s+, inflating every command's wall time.
async function runCommandEarlyExit(
  sb: Sandbox,
  sessionId: string,
  command: string,
  options: { workingDirectory?: string; timeoutSeconds?: number } | undefined,
  handlers: CommandHandlers | undefined,
  signal?: AbortSignal,
): Promise<CommandExecution> {
  const execution: CommandExecution = {
    logs: { stdout: [], stderr: [] },
    result: [],
  }
  let errorValue: string | undefined

  const commands = sb.commands as unknown as {
    runInSessionStream: (
      sessionId: string,
      command: string,
      opts?: { workingDirectory?: string; timeoutSeconds?: number },
      signal?: AbortSignal,
    ) => AsyncIterable<{
      type: string
      text?: string
      execution_time?: number
      error?: { ename?: string; evalue?: string; name?: string; value?: string; traceback?: unknown[] }
      results?: unknown[]
    }>
  }

  for await (const ev of commands.runInSessionStream(sessionId, command, options, signal)) {
    await handlers?.onEvent?.(ev)
    switch (ev.type) {
      case "init":
        execution.id = ev.text ?? ""
        await handlers?.onInit?.({ id: ev.text ?? "" })
        break
      case "stdout": {
        const msg = { text: ev.text ?? "", isError: false, timestamp: Date.now() }
        execution.logs.stdout.push(msg)
        await handlers?.onStdout?.(msg)
        break
      }
      case "stderr": {
        const msg = { text: ev.text ?? "", isError: true, timestamp: Date.now() }
        execution.logs.stderr.push(msg)
        await handlers?.onStderr?.(msg)
        break
      }
      case "execution_complete": {
        execution.complete = { executionTimeMs: ev.execution_time ?? 0, timestamp: Date.now() }
        await handlers?.onExecutionComplete?.(execution.complete)
        execution.exitCode = execution.error
          ? errorValue && /^-?\d+$/.test(errorValue.trim()) ? Number(errorValue.trim()) : null
          : 0
        return execution
      }
      case "error": {
        const e = ev.error
        if (e) {
          errorValue = String(e.evalue ?? e.value ?? "")
          execution.error = {
            name: String(e.ename ?? e.name ?? ""),
            value: errorValue,
            timestamp: Date.now(),
            traceback: Array.isArray(e.traceback) ? e.traceback.map(String) : [],
          }
          await handlers?.onError?.(execution.error)
        }
        execution.exitCode = errorValue && /^-?\d+$/.test(errorValue.trim()) ? Number(errorValue.trim()) : null
        return execution
      }
    }
  }
  return execution
}

export namespace SandboxProvider {
  const log = Log.create({ service: "sandbox-provider" })

  export interface Interface {
    readonly getOrCreate: (
      sessionID: SessionID,
      opts?: { pvcMode?: "session" | "app"; appId?: string },
    ) => Effect.Effect<Sandbox>
    readonly get: (sessionID: SessionID) => Effect.Effect<Sandbox | null>
    readonly destroy: (sessionID: SessionID) => Effect.Effect<void>
    readonly destroyById: (sandboxID: string) => Effect.Effect<void>
    readonly destroyAll: () => Effect.Effect<void>
    readonly cleanupSessionVolume: (sessionID: SessionID) => Effect.Effect<void>
    readonly keepAlive: (sessionID: SessionID) => Effect.Effect<void>
    readonly release: (sessionID: SessionID) => Effect.Effect<void>
    readonly isKeepAlive: (sessionID: SessionID) => Effect.Effect<boolean>
    readonly runInSession: (
      sessionID: SessionID,
      command: string,
      options?: { workingDirectory?: string; timeoutSeconds?: number },
      handlers?: {
        onStdout?: (msg: { text: string }) => void | Promise<void>
        onStderr?: (msg: { text: string }) => void | Promise<void>
        onEvent?: (ev: unknown) => void | Promise<void>
        onResult?: (res: unknown) => void | Promise<void>
        onExecutionComplete?: (c: unknown) => void | Promise<void>
        onError?: (err: unknown) => void | Promise<void>
        onInit?: (init: unknown) => void | Promise<void>
      },
      signal?: AbortSignal,
    ) => Effect.Effect<CommandExecution, Error, never>
    readonly runDetached: (
      sessionID: SessionID,
      command: string,
      options?: { workingDirectory?: string; timeoutSeconds?: number },
      handlers?: {
        onStdout?: (msg: { text: string }) => void | Promise<void>
        onStderr?: (msg: { text: string }) => void | Promise<void>
        onEvent?: (ev: unknown) => void | Promise<void>
        onResult?: (res: unknown) => void | Promise<void>
        onExecutionComplete?: (c: unknown) => void | Promise<void>
        onError?: (err: unknown) => void | Promise<void>
        onInit?: (init: unknown) => void | Promise<void>
      },
      signal?: AbortSignal,
    ) => Effect.Effect<CommandExecution, Error, never>
    readonly interrupt: (sessionID: SessionID) => Effect.Effect<void>
    readonly register: (sessionID: SessionID, sb: Sandbox) => Effect.Effect<void>
    readonly getEndpoint: (sessionID: SessionID, port: number) => Effect.Effect<string>
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxProvider") {}

  // ─── SQLite / 单机内存实现（原逻辑不变）─────────────────────────────
  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* SandboxConfig.Service
      const entries = yield* Ref.make(new Map<string, Entry>())
      const commandSessions = new Map<string, string>()
      const commandSemaphores = new Map<string, Semaphore.Semaphore>()
      const createRef = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())
      const sessionRef = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())
      const leases = new Set<string>()

      const connectionConfig = new ConnectionConfig({
        domain: config.domain,
        protocol: config.protocol,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        useServerProxy: config.useServerProxy,
      })

      const hasVolume = config.volumeType !== "none"

      function touchLastActive(sessionID: string) {
        return Ref.modify(entries, (m) => {
          const e = m.get(sessionID)
          if (!e) return [undefined, m] as const
          if (e.state === "running") m.set(sessionID, { ...e, lastActive: Date.now() })
          return [undefined, m] as const
        })
      }

      function setEntry(sessionID: string, entry: Entry) {
        return Ref.modify(entries, (m) => [undefined, m.set(sessionID, entry)] as const)
      }

      function removeEntry(sessionID: string) {
        return Ref.modify(entries, (m) => { m.delete(sessionID); return [undefined, m] as const })
      }

      function createSandbox(sessionID: SessionID, opts?: { pvcMode?: "session" | "app"; appId?: string }) {
        return Effect.gen(function* () {
          const timeoutSeconds = hasVolume ? config.maxTtlSeconds : config.timeoutSeconds
          log.info("creating sandbox", { sessionID, volumeType: config.volumeType, timeoutSeconds, pvcMode: opts?.pvcMode })
          const volumes = buildVolumes({ sessionID, pvcMode: opts?.pvcMode, appId: opts?.appId }, config)
          const sb = yield* Effect.tryPromise({
            try: () =>
              Sandbox.create({
                connectionConfig,
                image: config.image,
                timeoutSeconds,
                resource: config.resourceLimits,
                ...(volumes.length > 0 ? { volumes } : {}),
              }),
            catch: (e) => new Error(`Sandbox.create failed: ${e instanceof Error ? e.message : String(e)}`),
          })
          if (!hasVolume) {
            yield* Effect.tryPromise(() => sb.commands.run("mkdir -p /workspace")).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          log.info("sandbox created", { sessionID, sandboxID: sb.id, volumes: volumes.length })
          return sb
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.createSandbox"))
      }

      function destroySandbox(sb: Sandbox, sessionID: string) {
        return Effect.gen(function* () {
          log.info("destroying sandbox", { sessionID, sandboxID: sb.id })
          const cmdSession = commandSessions.get(sessionID)
          if (cmdSession) {
            yield* Effect.tryPromise(() => sb.commands.deleteSession(cmdSession)).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          commandSessions.delete(sessionID)
          yield* Effect.tryPromise(() => sb.kill()).pipe(
            Effect.catchCause(() => { log.error("sandbox kill failed", { sessionID }); return Effect.void }),
          )
          yield* Effect.tryPromise(() => sb.close()).pipe(
            Effect.catchCause(() => { log.error("sandbox close failed", { sessionID }); return Effect.void }),
          )
          log.info("sandbox destroyed", { sessionID })
        }).pipe(Effect.withSpan("SandboxProvider.destroySandbox"))
      }

      function claim<D, E>(ref: Ref.Ref<Map<string, Deferred.Deferred<D, E>>>, key: string, token: Deferred.Deferred<D, E>) {
        return Ref.modify(ref, (map) => {
          const existing = map.get(key)
          if (existing) return [existing, map] as const
          return [token, map.set(key, token)] as const
        })
      }

      const sandboxes = new Map<string, Sandbox>()

      const getOrCreate: Interface["getOrCreate"] = (sessionID, opts) =>
        Effect.gen(function* () {
          const myToken = yield* Deferred.make<Sandbox, Error>()
          const winner = yield* claim(createRef, sessionID, myToken)
          if (winner !== myToken) return yield* Deferred.await(winner).pipe(Effect.orDie)

          const entry = yield* Ref.modify(entries, (m) => [m.get(sessionID) ?? null, m] as const)

          const sb = yield* Effect.gen(function* () {
            if (!entry) return yield* createSandbox(sessionID, opts)
            if (entry.state === "running") {
              const healthy = yield* Effect.tryPromise(() => entry.sb.isHealthy()).pipe(
                Effect.catch(() => Effect.succeed(false)),
              )
              if (healthy) return entry.sb
              log.warn("sandbox unhealthy, rebuilding", { sessionID })
              yield* destroySandbox(entry.sb, sessionID)
              return yield* createSandbox(sessionID, opts)
            }
            log.info("recreating killed sandbox", { sessionID, sandboxID: entry.sandboxID })
            return yield* createSandbox(sessionID, opts)
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Ref.modify(createRef, (m) => { m.delete(sessionID); return [undefined, m] as const })
                yield* Deferred.fail(myToken, new Error("Sandbox creation failed")).pipe(Effect.catchCause(() => Effect.void))
                return yield* Effect.failCause(cause)
              }),
            ),
          )

          const owner = yield* Ref.modify(createRef, (m) => [m.get(sessionID) === myToken, m] as const)
          if (!owner) {
            yield* destroySandbox(sb, sessionID).pipe(Effect.catchCause(() => Effect.void))
            return yield* Effect.fail(new Error(`Sandbox creation cancelled: ${sessionID}`))
          }
          yield* Ref.modify(createRef, (m) => { m.delete(sessionID); return [undefined, m] as const })
          sandboxes.set(sessionID, sb)
          yield* setEntry(sessionID, { state: "running", sb, sandboxID: sb.id, lastActive: Date.now() })
          yield* Deferred.succeed(myToken, sb)
          return sb
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.getOrCreate"))

      const get: Interface["get"] = (sessionID) => Effect.sync(() => sandboxes.get(sessionID) ?? null)

      const destroy: Interface["destroy"] = (sessionID) =>
        Effect.gen(function* () {
          const sb = sandboxes.get(sessionID)
          sandboxes.delete(sessionID)
          yield* removeEntry(sessionID)
          const inFlight = yield* Ref.modify(createRef, (m) => {
            const d = m.get(sessionID)
            if (d) m.delete(sessionID)
            return [d, m] as const
          })
          if (inFlight) yield* Deferred.fail(inFlight, new Error(`Sandbox destroyed while creating: ${sessionID}`))
          const inFlightSession = yield* Ref.modify(sessionRef, (m) => {
            const d = m.get(sessionID)
            if (d) m.delete(sessionID)
            return [d, m] as const
          })
          if (inFlightSession) yield* Deferred.fail(inFlightSession, new Error(`Command session destroyed while creating: ${sessionID}`))
          if (sb) yield* destroySandbox(sb, sessionID)
        }).pipe(Effect.withSpan("SandboxProvider.destroy"))

      const destroyById: Interface["destroyById"] = (sandboxID) =>
        Effect.gen(function* () {
          for (const [sid, s] of sandboxes) {
            if (s.id === sandboxID) return yield* destroy(sid as SessionID)
          }
        }).pipe(Effect.withSpan("SandboxProvider.destroyById"))

      const destroyAll: Interface["destroyAll"] = () =>
        Effect.gen(function* () {
          log.info("destroying all sandboxes", { count: sandboxes.size })
          const inFlightCreates = yield* Ref.modify(createRef, (m) => { const e = Array.from(m.entries()); m.clear(); return [e, m] as const })
          for (const [, d] of inFlightCreates) yield* Deferred.fail(d, new Error("Sandbox destroyed during shutdown"))
          const inFlightSessions = yield* Ref.modify(sessionRef, (m) => { const e = Array.from(m.entries()); m.clear(); return [e, m] as const })
          for (const [, d] of inFlightSessions) yield* Deferred.fail(d, new Error("Command session destroyed during shutdown"))
          const all = yield* Ref.modify(entries, (m) => { const e = Array.from(m.entries()); m.clear(); return [e, m] as const })
          for (const [sid, entry] of all) {
            if (entry.state === "running") {
              sandboxes.delete(sid)
              yield* destroySandbox(entry.sb, sid).pipe(
                Effect.catchCause((cause) => { log.error("failed to destroy sandbox during shutdown", { sid, cause: Cause.pretty(cause) }); return Effect.void }),
              )
            }
          }
        }).pipe(Effect.withSpan("SandboxProvider.destroyAll"))

      const keepAlive: Interface["keepAlive"] = (sessionID) =>
        Effect.sync(() => { log.info("sandbox keep alive enabled", { sessionID }) })

      const release: Interface["release"] = (sessionID) =>
        Effect.sync(() => { log.info("sandbox keep alive released", { sessionID }) })

      const isKeepAlive: Interface["isKeepAlive"] = (sessionID) => Effect.sync(() => false)

      const runInSession: Interface["runInSession"] = (sessionID, command, options, handlers, signal) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          yield* touchLastActive(sessionID)
          let sessionId = commandSessions.get(sessionID)
          if (!sessionId) {
            const myToken = yield* Deferred.make<string, Error>()
            const winner = yield* claim(sessionRef, sessionID, myToken)
            if (winner !== myToken) {
              sessionId = yield* Deferred.await(winner)
            } else {
              sessionId = yield* Effect.tryPromise({
                try: () => sb.commands.createSession({ workingDirectory: "/workspace" }),
                catch: (e) => new Error(`Failed to create command session: ${String(e)}`),
              }).pipe(
                Effect.onExit((exit) =>
                  Ref.modify(sessionRef, (m) => {
                    const ours = m.get(sessionID) === myToken
                    m.delete(sessionID)
                    return [ours, m] as const
                  }).pipe(
                    Effect.andThen((ours) => {
                      if (ours) {
                        if (exit._tag === "Success") commandSessions.set(sessionID, exit.value)
                        return Deferred.done(myToken, exit)
                      }
                      return Effect.void
                    }),
                  ),
                ),
              )
            }
          }
          let sem = commandSemaphores.get(sessionID)
          if (!sem) { sem = Effect.runSync(Semaphore.make(1)); commandSemaphores.set(sessionID, sem) }
          return yield* sem.withPermit(
            Effect.tryPromise({
              try: () => sb.commands.runInSession(sessionId!, command, options, handlers, signal),
              catch: (e) => new Error(`runInSession failed: ${String(e)}`),
            }),
          )
        }).pipe(Effect.withSpan("SandboxProvider.runInSession"))

      const runDetached: Interface["runDetached"] = (sessionID, command, options, handlers, signal) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          const detachedSessionId = yield* Effect.tryPromise({
            try: () => sb.commands.createSession({ workingDirectory: options?.workingDirectory ?? "/workspace" }),
            catch: (e) => new Error(`Failed to create detached session: ${String(e)}`),
          })
          try {
            return yield* Effect.tryPromise({
              try: () => runCommandEarlyExit(sb, detachedSessionId, command, options, handlers, signal),
              catch: (e) => new Error(`runDetached failed: ${String(e)}`),
            })
          } finally {
            yield* Effect.tryPromise(() => sb.commands.deleteSession(detachedSessionId)).pipe(Effect.ignore)
          }
        }).pipe(Effect.withSpan("SandboxProvider.runDetached"))

      const interrupt: Interface["interrupt"] = (sessionID) =>
        Effect.gen(function* () {
          const sessionId = commandSessions.get(sessionID)
          if (!sessionId) return
          const sb = sandboxes.get(sessionID)
          if (!sb) return
          yield* Effect.tryPromise({
            try: () => sb.commands.interrupt(sessionId),
            catch: () => {},
          })
          log.info("sandbox command interrupted", { sessionID })
        }).pipe(
          Effect.ensuring(Effect.sync(() => {
            commandSessions.delete(sessionID)
          })),
          Effect.catch(() => Effect.void),
          Effect.withSpan("SandboxProvider.interrupt"),
        )

      const register: Interface["register"] = (sessionID, sb) =>
        Effect.sync(() => {
          commandSessions.delete(sessionID)
          sandboxes.set(sessionID, sb)
        })

      const getEndpoint: Interface["getEndpoint"] = (sessionID, port) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          const url = yield* Effect.tryPromise({
            try: () => sb.getEndpointUrl(port),
            catch: (e) => new Error(`getEndpoint failed: ${String(e)}`),
          })
          log.info("sandbox endpoint resolved", { sessionID, port, url })
          return url
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.getEndpoint"))

      yield* Effect.addFinalizer(() =>
        destroyAll().pipe(
          Effect.catchCause((cause) => {
            log.error("sandbox cleanup on scope exit failed", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      return Service.of({
        getOrCreate, get, destroy, destroyById, destroyAll, keepAlive, release, isKeepAlive,
        runInSession, runDetached, interrupt, register, getEndpoint,
        cleanupSessionVolume: (sessionID) => cleanupSessionVolume(sessionID, config, connectionConfig),
      })
    }),
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const pgLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* SandboxConfig.Service
      const commandSemaphores = new Map<string, Semaphore.Semaphore>()
      const createRef = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())
      const sbCache = new Map<string, { sb: Sandbox; cachedAt: number; sandboxID: string }>()
      const SB_CACHE_TTL_MS = 30_000

      function getCachedSandbox(sessionID: string): Sandbox | null {
        const hit = sbCache.get(sessionID)
        if (!hit) return null
        if (Date.now() - hit.cachedAt > SB_CACHE_TTL_MS) {
          sbCache.delete(sessionID)
          return null
        }
        return hit.sb
      }

      function invalidateCachedSandbox(sessionID: string) {
        sbCache.delete(sessionID)
      }

      function cacheSandbox(sessionID: string, sb: Sandbox) {
        sbCache.set(sessionID, { sb, cachedAt: Date.now(), sandboxID: sb.id })
      }

      const connectionConfig = new ConnectionConfig({
        domain: config.domain,
        protocol: config.protocol,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        useServerProxy: config.useServerProxy,
      })

      const hasVolume = config.volumeType !== "none"

      const pgDb: any = Database.Client()

      type Row = {
        id: string
        session_id: string
        host: string
        state: "running" | "killed"
        keep_alive: boolean
        command_session_id: string | null
        time_created: number
        time_updated: number
      }

      function dbGet(sessionID: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .select()
            .from(SandboxTable)
            .where(eq(SandboxTable.session_id, sessionID))
            .limit(1)
            .then((rows: Row[]) => rows[0] ?? null) as Promise<Row | null>,
          catch: (e) => new Error(`db.get failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbGetById(id: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .select()
            .from(SandboxTable)
            .where(eq(SandboxTable.id, id))
            .limit(1)
            .then((rows: Row[]) => rows[0] ?? null) as Promise<Row | null>,
          catch: (e) => new Error(`db.getById failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbUpsert(row: typeof SandboxTable.$inferInsert) {
        return Effect.tryPromise({
          try: () => pgDb
            .insert(SandboxTable)
            .values(row)
            .onConflictDoUpdate({
              target: SandboxTable.session_id,
              set: {
                id: row.id,
                host: row.host,
                state: row.state,
                keep_alive: row.keep_alive,
                command_session_id: row.command_session_id,
                time_updated: Date.now(),
              },
            })
            .run(),
          catch: (e) => new Error(`db.upsert failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbSetState(sessionID: string, state: "running" | "killed") {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ state, time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, sessionID))
            .run(),
          catch: (e) => new Error(`db.setState failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbSetStateFor(sessionID: string, id: string, state: "running" | "killed") {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ state, time_updated: Date.now() })
            .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, id)))
            .run(),
          catch: (e) => new Error(`db.setStateFor failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbSetKeepAlive(sessionID: string, val: boolean) {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ keep_alive: val, time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, sessionID))
            .run(),
          catch: (e) => new Error(`db.setKeepAlive failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbSetCommandSession(sessionID: string, id: string, cmdSessionID: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ command_session_id: cmdSessionID, time_updated: Date.now() })
            .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, id)))
            .run(),
          catch: (e) => new Error(`db.setCommandSession failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbDelete(sessionID: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .delete(SandboxTable)
            .where(eq(SandboxTable.session_id, sessionID))
            .run(),
          catch: (e) => new Error(`db.delete failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbDeleteFor(sessionID: string, id: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .delete(SandboxTable)
            .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, id)))
            .run(),
          catch: (e) => new Error(`db.deleteFor failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbMarkDestroyed(sessionID: string, id: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ state: "destroyed", command_session_id: null, time_updated: Date.now() })
            .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, id)))
            .run(),
          catch: (e) => new Error(`db.markDestroyed failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbAll() {
        return Effect.tryPromise({
          try: () => pgDb
            .select()
            .from(SandboxTable)
            .where(eq(SandboxTable.state, "running"))
            .all() as Promise<Row[]>,
          catch: (e) => new Error(`db.all failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      // Semaphore per session — serializes sandbox lifecycle operations
      // within a single process. Cross-process safety is ensured by PG's
      // ON CONFLICT and state checks inside getOrCreate/destroy.
      const lockSemaphores = new Map<string, Semaphore.Semaphore>()
      function lock<A, E>(sessionID: string, effect: Effect.Effect<A, E>) {
        return Effect.gen(function* () {
          let sem = lockSemaphores.get(sessionID)
          if (!sem) {
            sem = Effect.runSync(Semaphore.make(1))
            lockSemaphores.set(sessionID, sem)
          }
          return yield* sem.withPermits(1)(effect)
        })
      }

      // ── Sandbox 生命周期 ──────────────────────────────────────────────

      function reconnect(row: { id: string; host: string }) {
        return Effect.tryPromise({
          try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id }),
          catch: (e) => new Error(`Sandbox.connect failed: ${String(e)}`),
        })
      }

      function bestEffortKill(sandboxId: string, sessionID: string) {
        return Effect.tryPromise({
          try: () => {
            const killCfg = new ConnectionConfig({
              domain: config.domain,
              protocol: config.protocol,
              ...(config.apiKey ? { apiKey: config.apiKey } : {}),
              useServerProxy: config.useServerProxy,
              requestTimeoutSeconds: 10,
            })
            return Sandbox.connect({ connectionConfig: killCfg, sandboxId })
              .then((sb) => sb.kill().then(() => sb.close()))
          },
          catch: (e) => {
            log.warn("best-effort sandbox kill failed", { sessionID, sandboxId, error: String(e) })
          },
        }).pipe(Effect.catchCause(() => Effect.void))
      }

      function createSandbox(sessionID: SessionID, opts?: { pvcMode?: "session" | "app"; appId?: string }) {
        return Effect.gen(function* () {
          const existingRow = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          const isKept = existingRow?.keep_alive === true
          const baseTtl = hasVolume ? config.maxTtlSeconds : config.timeoutSeconds
          // keepAlive sandbox 使用 10x TTL，确保远程 sandbox 不会在保活期间自杀
          const timeoutSeconds = isKept ? Math.max(baseTtl, config.maxTtlSeconds) * 10 : baseTtl
          log.info("creating sandbox", { sessionID, volumeType: config.volumeType, timeoutSeconds, keepAlive: isKept, pvcMode: opts?.pvcMode })
          const volumes = buildVolumes({ sessionID, pvcMode: opts?.pvcMode, appId: opts?.appId }, config)
          const sb = yield* Effect.tryPromise({
            try: () =>
              Sandbox.create({
                connectionConfig,
                image: config.image,
                timeoutSeconds,
                resource: config.resourceLimits,
                ...(volumes.length > 0 ? { volumes } : {}),
              }),
            catch: (e) => new Error(`Sandbox.create failed: ${e instanceof Error ? e.message : String(e)}`),
          })
          if (!hasVolume) {
            yield* Effect.tryPromise(() => sb.commands.run("mkdir -p /workspace")).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          const host = `http://${config.domain}`
          yield* dbUpsert({
            id: sb.id,
            session_id: sessionID,
            host,
            state: "running",
            keep_alive: existingRow?.keep_alive ?? false,
            command_session_id: null,
            time_created: Date.now(),
            time_updated: Date.now(),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.tryPromise(() => sb.kill()).pipe(Effect.catchCause(() => Effect.void))
                yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catchCause(() => Effect.void))
                return yield* Effect.failCause(cause)
              }),
            ),
          )
          log.info("sandbox created", { sessionID, sandboxID: sb.id })
          return sb
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.createSandbox"))
      }

      function destroySandbox(sb: Sandbox, sessionID: string) {
        return Effect.gen(function* () {
          invalidateCachedSandbox(sessionID)
          log.info("destroying sandbox", { sessionID, sandboxID: sb.id })
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (row?.id === sb.id && row.command_session_id) {
            yield* Effect.tryPromise(() => sb.commands.deleteSession(row.command_session_id!)).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          yield* Effect.tryPromise(() => sb.kill()).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                log.error("sandbox kill failed", { sessionID, cause: String(cause) })
                // 诊断：获取 sandbox 实际状态/reason（SDK 已暴露，替代完整 diagnostic logs）
                const info = yield* Effect.tryPromise(() => sb.getInfo()).pipe(Effect.orElseSucceed(() => null))
                if (info?.status) {
                  log.warn("sandbox status on kill failure", { sessionID, sandboxID: sb.id, state: info.status.state, reason: info.status.reason, message: info.status.message })
                }
              }),
            ),
          )
          yield* Effect.tryPromise(() => sb.close()).pipe(
            Effect.catchCause(() => { log.error("sandbox close failed", { sessionID }); return Effect.void }),
          )
          yield* dbMarkDestroyed(sessionID, sb.id)
          log.info("sandbox destroyed", { sessionID })
        }).pipe(Effect.withSpan("SandboxProvider.destroySandbox"))
      }

      function claim<D, E>(ref: Ref.Ref<Map<string, Deferred.Deferred<D, E>>>, key: string, token: Deferred.Deferred<D, E>) {
        return Ref.modify(ref, (map) => {
          const existing = map.get(key)
          if (existing) return [existing, map] as const
          return [token, map.set(key, token)] as const
        })
      }

      // ── Interface 实装 ────────────────────────────────────────────────

      function getOrCreateUnlocked(sessionID: SessionID, opts?: { pvcMode?: "session" | "app"; appId?: string }) {
        return Effect.gen(function* () {
          const cached = getCachedSandbox(sessionID)
          if (cached) return cached

          const t0 = Date.now()
          log.info("getOrCreate start", { sessionID })

          // pod 内去重
          const myToken = yield* Deferred.make<Sandbox, Error>()
          const winner = yield* claim(createRef, sessionID, myToken)
          if (winner !== myToken) {
            log.info("getOrCreate awaiting winner", { sessionID, ms: Date.now() - t0 })
            return yield* Deferred.await(winner).pipe(Effect.orDie)
          }

          return yield* Effect.gen(function* () {
            const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))

            const sb = yield* Effect.gen(function* () {
              if (row?.state === "running") {
                const tReconnect = Date.now()
                const existing = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
                log.info("reconnect done", {
                  sessionID,
                  sandboxID: row.id,
                  ms: Date.now() - tReconnect,
                  success: !!existing,
                })

                if (existing) {
                  const tHealth = Date.now()
                  const healthy = yield* Effect.tryPromise(() => existing.isHealthy()).pipe(
                    Effect.catch(() => Effect.succeed(false)),
                  )
                  log.info("isHealthy done", {
                    sessionID,
                    sandboxID: row.id,
                    ms: Date.now() - tHealth,
                    healthy,
                  })

                  if (healthy) {
                    log.info("reconnected to existing sandbox", {
                      sessionID,
                      sandboxID: row.id,
                      totalMs: Date.now() - t0,
                    })
                    return existing
                  }
                  log.warn("sandbox unhealthy after reconnect, rebuilding", { sessionID })
                  yield* destroySandbox(existing, sessionID).pipe(Effect.catchCause(() => Effect.void))
                } else {
                  invalidateCachedSandbox(sessionID)
                  log.warn("sandbox reconnect returned null, rebuilding", { sessionID, sandboxID: row.id })
                }
              }
              if (row?.state === "killed") {
                log.info("recreating killed sandbox", { sessionID, sandboxID: row.id })
              }
              // P0-3: cross-pod mutex — prevent duplicate sandbox creation
              yield* Effect.tryPromise({
                try: () => pgDb.execute(sql`SELECT pg_advisory_lock(hashtext(${sessionID}))`),
                catch: (e) => new Error(`advisory_lock failed: ${String(e)}`),
              }).pipe(Effect.orDie)
              const tCreate = Date.now()
              const result = yield* createSandbox(sessionID, opts).pipe(
                Effect.ensuring(
                  Effect.tryPromise({
                    try: () => pgDb.execute(sql`SELECT pg_advisory_unlock(hashtext(${sessionID}))`),
                    catch: () => {},
                  }).pipe(Effect.ignore),
                ),
              )
              log.info("createSandbox done", {
                sessionID,
                sandboxID: result.id,
                ms: Date.now() - tCreate,
                totalMs: Date.now() - t0,
              })
              return result
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.gen(function* () {
                  yield* Deferred.fail(myToken, new Error("Sandbox creation failed")).pipe(Effect.catchCause(() => Effect.void))
                  return yield* Effect.failCause(cause)
                }),
              ),
            )

            const owner = yield* Ref.modify(createRef, (m) => [m.get(sessionID) === myToken, m] as const)
            if (!owner) {
              yield* destroySandbox(sb, sessionID).pipe(Effect.catchCause(() => Effect.void))
              return yield* Effect.fail(new Error(`Sandbox creation cancelled: ${sessionID}`))
            }
            yield* Ref.modify(createRef, (m) => { m.delete(sessionID); return [undefined, m] as const })
            yield* Deferred.succeed(myToken, sb)
            cacheSandbox(sessionID, sb)
            log.info("getOrCreate done", { sessionID, sandboxID: sb.id, totalMs: Date.now() - t0 })
            return sb
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const removed = yield* Ref.modify(createRef, (m) => {
                  if (m.get(sessionID) !== myToken) return [false, m] as const
                  m.delete(sessionID)
                  return [true, m] as const
                })
                if (removed) yield* Deferred.fail(myToken, new Error(`Sandbox creation interrupted: ${sessionID}`)).pipe(Effect.catchCause(() => Effect.void))
              }),
            ),
          )
        })
      }

      const getOrCreate: Interface["getOrCreate"] = (sessionID, opts) =>
        lock(sessionID, getOrCreateUnlocked(sessionID, opts)).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(90),
            orElse: () => Effect.fail(new Error(`Sandbox getOrCreate timeout after 90s: ${sessionID}`)),
          }),
          Effect.orDie,
        ).pipe(Effect.withSpan("SandboxProvider.getOrCreate"))

      const get: Interface["get"] = (sessionID) =>
        Effect.gen(function* () {
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (!row || row.state !== "running") return null
          const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
          if (!sb) {
            yield* dbSetStateFor(sessionID, row.id, "killed").pipe(Effect.catchCause(() => Effect.void))
            return null
          }
          return sb
        }).pipe(Effect.withSpan("SandboxProvider.get"))

      const destroy: Interface["destroy"] = (sessionID) =>
        lock(sessionID, Effect.gen(function* () {
          invalidateCachedSandbox(sessionID)
          yield* dbSetKeepAlive(sessionID, false).pipe(Effect.orElseSucceed(() => null))
          const inFlight = yield* Ref.modify(createRef, (m) => {
            const d = m.get(sessionID)
            if (d) m.delete(sessionID)
            return [d, m] as const
          })
          if (inFlight) yield* Deferred.fail(inFlight, new Error(`Sandbox destroyed while creating: ${sessionID}`))
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (row?.state === "running") {
            const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
            if (sb) yield* destroySandbox(sb, sessionID).pipe(Effect.catchCause(() => Effect.void))
            else {
              invalidateCachedSandbox(sessionID)
              yield* bestEffortKill(row.id, sessionID)
              yield* dbMarkDestroyed(sessionID, row.id)
            }
          } else if (row) {
            yield* dbMarkDestroyed(sessionID, row.id)
          }
        })).pipe(Effect.withSpan("SandboxProvider.destroy"))

      const destroyById: Interface["destroyById"] = (sandboxID) =>
        Effect.gen(function* () {
          const row = yield* dbGetById(sandboxID).pipe(Effect.orElseSucceed(() => null))
          if (!row || row.state !== "running") return
          invalidateCachedSandbox(row.session_id)
          yield* lock(row.session_id, Effect.gen(function* () {
            invalidateCachedSandbox(row.session_id)
            const current = yield* dbGetById(sandboxID).pipe(Effect.orElseSucceed(() => null))
            if (!current || current.id !== sandboxID || current.state !== "running") return
            yield* Ref.modify(createRef, (m) => {
              const d = m.get(current.session_id)
              if (d) m.delete(current.session_id)
              return [undefined, m] as const
            })
            const sb = yield* reconnect(current).pipe(Effect.orElseSucceed(() => null))
            if (sb) {
              yield* destroySandbox(sb, current.session_id).pipe(Effect.catchCause(() => Effect.void))
              return
            }
            invalidateCachedSandbox(current.session_id)
            yield* bestEffortKill(sandboxID, current.session_id)
            yield* dbDeleteFor(current.session_id, sandboxID).pipe(Effect.catchCause(() => Effect.void))
          }))
        }).pipe(Effect.withSpan("SandboxProvider.destroyById"))

      const destroyAll: Interface["destroyAll"] = () =>
        Effect.gen(function* () {
          sbCache.clear()
          const inFlightCreates = yield* Ref.modify(createRef, (m) => { const e = Array.from(m.entries()); m.clear(); return [e, m] as const })
          for (const [, d] of inFlightCreates) yield* Deferred.fail(d, new Error("Sandbox destroyed during shutdown"))
          const rows = yield* dbAll().pipe(Effect.orElseSucceed(() => [] as any[]))
          log.info("destroying all sandboxes", { count: rows.length })
          for (const row of rows) {
            yield* lock(row.session_id, Effect.gen(function* () {
              const current = yield* dbGet(row.session_id).pipe(Effect.orElseSucceed(() => null))
              if (!current || current.id !== row.id || current.state !== "running") return
              const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
              if (sb) {
                yield* destroySandbox(sb, row.session_id).pipe(
                  Effect.catchCause((cause) => { log.error("failed to destroy sandbox during shutdown", { cause: Cause.pretty(cause) }); return Effect.void }),
                )
                return
              }
              invalidateCachedSandbox(row.session_id)
              yield* bestEffortKill(row.id, row.session_id)
              yield* dbDeleteFor(row.session_id, row.id).pipe(Effect.catchCause(() => Effect.void))
            }))
          }
          commandSemaphores.clear()
        }).pipe(Effect.withSpan("SandboxProvider.destroyAll"))

      const keepAlive: Interface["keepAlive"] = (sessionID) =>
        Effect.gen(function* () {
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (row) {
            yield* dbSetKeepAlive(sessionID, true)
          } else {
            yield* dbUpsert({
              id: `pending-${sessionID}`,
              session_id: sessionID,
              host: "",
              state: "killed",
              keep_alive: true,
              command_session_id: null,
              time_created: Date.now(),
              time_updated: Date.now(),
            })
          }
          log.info("sandbox keep alive enabled", { sessionID })
        })

      const release: Interface["release"] = (sessionID) =>
        Effect.gen(function* () {
          yield* dbSetKeepAlive(sessionID, false)
          log.info("sandbox keep alive released", { sessionID })
        })

      const isKeepAlive: Interface["isKeepAlive"] = (sessionID) =>
        Effect.gen(function* () {
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          return row?.keep_alive === true
        })

      const runInSession: Interface["runInSession"] = (sessionID, command, options, handlers, signal) =>
        Effect.gen(function* () {
          const sb = yield* lock(sessionID, getOrCreateUnlocked(sessionID))

          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          let cmdSessionID = (row?.id === sb.id ? row?.command_session_id : null) ?? null

          if (!cmdSessionID) {
            let sem = commandSemaphores.get(sessionID)
            if (!sem) { sem = Effect.runSync(Semaphore.make(1)); commandSemaphores.set(sessionID, sem) }
            cmdSessionID = yield* sem.withPermit(Effect.gen(function* () {
              const row2 = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
              const existing = (row2?.id === sb.id ? row2?.command_session_id : null) ?? null
              if (existing) return existing

              const newSession = yield* Effect.tryPromise({
                try: () => sb.commands.createSession({ workingDirectory: "/workspace" }),
                catch: (e) => new Error(`Failed to create command session: ${String(e)}`),
              })
              yield* dbSetCommandSession(sessionID, sb.id, newSession).pipe(Effect.catchCause(() => Effect.void))
              return newSession
            }))
          }

          return yield* Effect.tryPromise({
            try: () => runCommandEarlyExit(sb, cmdSessionID!, command, options, handlers, signal),
            catch: (e) => new Error(`runInSession failed: ${String(e)}`),
          }).pipe(
            Effect.tapError((err) =>
              String(err).includes("not found")
                ? Effect.sync(() => { invalidateCachedSandbox(sessionID); log.warn("sandbox invalidated after command failure", { sessionID }) })
                : Effect.void,
            ),
          )
        }).pipe(Effect.withSpan("SandboxProvider.runInSession"))

      const runDetached: Interface["runDetached"] = (sessionID, command, options, handlers, signal) =>
        Effect.gen(function* () {
          const sb = yield* lock(sessionID, getOrCreateUnlocked(sessionID))
          const detachedSessionId = yield* Effect.tryPromise({
            try: () => sb.commands.createSession({ workingDirectory: options?.workingDirectory ?? "/workspace" }),
            catch: (e) => new Error(`Failed to create detached session: ${String(e)}`),
          })
          try {
            return yield* Effect.tryPromise({
              try: () => runCommandEarlyExit(sb, detachedSessionId, command, options, handlers, signal),
              catch: (e) => new Error(`runDetached failed: ${String(e)}`),
            }).pipe(
              Effect.tapError((err) =>
                String(err).includes("not found")
                  ? Effect.sync(() => { invalidateCachedSandbox(sessionID); log.warn("sandbox invalidated after detached failure", { sessionID }) })
                  : Effect.void,
              ),
            )
          } finally {
            yield* Effect.tryPromise(() => sb.commands.deleteSession(detachedSessionId)).pipe(Effect.ignore)
          }
        }).pipe(Effect.withSpan("SandboxProvider.runDetached"))

      const interrupt: Interface["interrupt"] = (sessionID) =>
        Effect.gen(function* () {
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (!row?.command_session_id) return
          const sb = yield* getOrCreate(sessionID)
          yield* Effect.tryPromise({
            try: () => sb.commands.interrupt(row.command_session_id!),
            catch: () => {},
          }).pipe(Effect.catch(() => Effect.void))
          log.info("sandbox command interrupted", { sessionID })
        }).pipe(
          Effect.ensuring(Effect.gen(function* () {
          yield* Effect.tryPromise({
              try: () => pgDb
                .update(SandboxTable)
                .set({ command_session_id: null, time_updated: Date.now() })
                .where(eq(SandboxTable.session_id, sessionID))
                .run(),
              catch: () => {},
            }).pipe(Effect.catch(() => Effect.void))
          })),
          Effect.withSpan("SandboxProvider.interrupt"),
        )

      const register: Interface["register"] = (sessionID, sb) =>
        lock(sessionID, Effect.gen(function* () {
          yield* dbUpsert({
            id: sb.id,
            session_id: sessionID,
            host: `http://${config.domain}`,
            state: "running",
            keep_alive: false,
            command_session_id: null,
            time_created: Date.now(),
            time_updated: Date.now(),
          })
        }))

      const getEndpoint: Interface["getEndpoint"] = (sessionID, port) =>
        Effect.gen(function* () {
          const sb = yield* getOrCreate(sessionID)
          const url = yield* Effect.tryPromise({
            try: () => sb.getEndpointUrl(port),
            catch: (e) => new Error(`getEndpoint failed: ${String(e)}`),
          })
          log.info("sandbox endpoint resolved", { sessionID, port, url })
          return url
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.getEndpoint"))

      // 周期性清理僵尸 sandbox（pod crash 后遗留的 state=running 记录）
      // 僵尸判定：state=running 且 time_updated 超过 idleKillMs*2 未更新
      const zombieThresholdMs = config.idleKillMs * 2
      yield* Effect.gen(function* () {
        yield* Effect.repeat(
          Effect.gen(function* () {
            const threshold = Date.now() - zombieThresholdMs
            const rows = yield* Effect.tryPromise({
              try: () => pgDb
                .select()
                .from(SandboxTable)
                .where(and(
                  eq(SandboxTable.state, "running"),
                  eq(SandboxTable.keep_alive, false),
                  lt(SandboxTable.time_updated, threshold),
                ))
                .all() as Promise<Row[]>,
              catch: () => [] as Row[],
            }).pipe(Effect.orElseSucceed(() => [] as Row[]))

            if (rows.length === 0) return
            log.info("zombie sandbox cleanup", { count: rows.length })
            for (const row of rows) {
              yield* lock(row.session_id, Effect.gen(function* () {
                const current = yield* dbGet(row.session_id).pipe(Effect.orElseSucceed(() => null))
                if (!current || current.id !== row.id || current.state !== "running") return
                if (current.time_updated > threshold) return
                const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
                if (sb) {
                  // reconcile：用 getInfo 验证 sandbox 实际状态，已终止的跳过 kill 直接回收 DB
                  const info = yield* Effect.tryPromise(() => sb.getInfo()).pipe(Effect.orElseSucceed(() => null))
                  const state = info?.status?.state
                  if (state && state !== "Running" && state !== "Creating" && state !== "Resuming") {
                    log.info("zombie sandbox already terminated", { sessionID: row.session_id, sandboxID: row.id, state, reason: info?.status?.reason })
                    yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catchCause(() => Effect.void))
                    yield* dbMarkDestroyed(row.session_id, row.id).pipe(Effect.catchCause(() => Effect.void))
                    return
                  }
                  yield* destroySandbox(sb, row.session_id).pipe(
                    Effect.catchCause(() => Effect.void),
                  )
                  return
                }
                yield* bestEffortKill(row.id, row.session_id)
                yield* dbMarkDestroyed(row.session_id, row.id).pipe(Effect.catchCause(() => Effect.void))
              }))
            }
          }),
          { schedule: Schedule.spaced(config.idleKillMs) },
        ).pipe(
          Effect.forkScoped,
          Effect.interruptible,
        )
      })

      yield* Effect.addFinalizer(() =>
        destroyAll().pipe(
          Effect.catchCause((cause) => {
            log.error("sandbox cleanup on scope exit failed", { cause: Cause.pretty(cause) })
            return Effect.void
          }),
        ),
      )

      return Service.of({
        getOrCreate, get, destroy, destroyById, destroyAll, keepAlive, release, isKeepAlive,
        runInSession, runDetached, interrupt, register, getEndpoint,
        cleanupSessionVolume: (sessionID) => cleanupSessionVolume(sessionID, config, connectionConfig),
      })
    }),
  )

  export const defaultLayer = (process.env["OPENCODE_DATABASE_URL"] ? pgLayer : layer).pipe(
    Layer.provide(SandboxConfig.defaultLayer),
  )

  export const node = LayerNode.make({
    service: Service,
    layer: defaultLayer,
    deps: [],
  })
}

export namespace NoopSandboxProvider {
  export const layer = Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed(null as unknown as Sandbox),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyById: () => Effect.void,
      destroyAll: () => Effect.void,
      keepAlive: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      runInSession: () => Effect.fail(new Error("Sandbox is disabled")),
      runDetached: () => Effect.fail(new Error("Sandbox is disabled")),
      interrupt: () => Effect.void,
      register: () => Effect.void,
      getEndpoint: () => Effect.die(new Error("Sandbox is disabled")),
      cleanupSessionVolume: () => Effect.void,
    }),
  )
}
