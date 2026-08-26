import { Effect, Context, Layer, Cause, Deferred, Ref, Semaphore, Schedule, Duration, Scope, Exit, Option } from "effect"
import { Sandbox, ConnectionConfig, SandboxApiException, SandboxManager } from "@alibaba-group/opensandbox"
import type { CommandExecution, Volume } from "@alibaba-group/opensandbox"
import { and, asc, eq, lt, or, sql } from "drizzle-orm"
import * as Log from "@opencode-ai/core/util/log"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Flag } from "@/flag/flag"
import type { SessionID } from "../session/schema"
import { parseSandboxColumn, resolveSandboxOpts } from "../session/sandbox-opts"
import { SessionTable } from "../session/session.pg"
import { Database } from "../storage/db"
import { SandboxTable } from "./sandbox.pg"
import { SessionSnapshot } from "./session-snapshot"
import { ExecLogTable } from "../session/exec-log"

export namespace SandboxConfig {
  export interface Interface {
    readonly domain: string
    readonly protocol: "http" | "https"
    readonly apiKey: string
    readonly useServerProxy: boolean
    readonly image: string
    readonly snapshotImage: string
    readonly timeoutSeconds: number
    readonly resourceLimits: Record<string, string>
    readonly volumeType: "none" | "pvc" | "host" | "snapshot"
    readonly pvcClaimName: string
    readonly snapshotTtlMs: number
    readonly snapshotWaitMs: number
    readonly idleKillMs: number
    readonly idleReapMs: number
    readonly idleReapIntervalMs: number
    readonly maxTtlSeconds: number
    readonly packageCacheMount: string
    readonly cleanupOnScopeExit?: boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxConfig") {}

  export const defaultConfig: Interface = {
    domain: Flag.OPENCODE_SANDBOX_DOMAIN,
    protocol: "http" as const,
    apiKey: Flag.OPENCODE_SANDBOX_API_KEY,
    useServerProxy: Flag.OPENCODE_SANDBOX_USE_SERVER_PROXY,
    image: Flag.OPENCODE_SANDBOX_IMAGE,
    snapshotImage: Flag.OPENCODE_SANDBOX_SNAPSHOT_IMAGE,
    timeoutSeconds: Flag.OPENCODE_SANDBOX_TIMEOUT,
    resourceLimits: { cpu: "1", memory: "2Gi" },
    volumeType: Flag.OPENCODE_SANDBOX_VOLUME_TYPE,
    pvcClaimName: Flag.OPENCODE_SANDBOX_PVC_CLAIM,
    snapshotTtlMs: Flag.OPENCODE_SANDBOX_SNAPSHOT_TTL_SEC * 1000,
    snapshotWaitMs: Flag.OPENCODE_SANDBOX_SNAPSHOT_WAIT_SEC * 1000,
    idleKillMs: Flag.OPENCODE_SANDBOX_IDLE_KILL_SEC * 1000,
    idleReapMs: Flag.OPENCODE_SANDBOX_IDLE_REAP_SEC * 1000,
    idleReapIntervalMs: 300_000,
    maxTtlSeconds: Flag.OPENCODE_SANDBOX_MAX_TTL_SEC,
    packageCacheMount: Flag.OPENCODE_SANDBOX_PACKAGE_CACHE_MOUNT,
    cleanupOnScopeExit: true,
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
  /** 会话级持久化方式（缺省回退全局 volumeType，兼容旧调用） */
  readonly persistMode?: "pvc" | "snapshot"
}

export function validateSnapshotConfig(config: Pick<SandboxConfig.Interface, "volumeType">) {
  // 全局默认是 snapshot 模式时需确保快照能力正常
  if (config.volumeType === "snapshot") {
    // snapshot 模式全局部署，快照模块始终可用
  }
}

export function buildVolumes(scope: VolumeScope, config: SandboxConfig.Interface): Volume[] {
  // 会话级 persistMode 优先，缺省回退全局 volumeType（兼容 pvc/host/none）
  const mode = scope.persistMode ?? config.volumeType
  // snapshot 模式：workspace 留在沙箱 rootfs（随快照持久化，见 docs/sandbox-snapshot-design.md），
  // 只挂跨会话共享的 package-cache；pvcMode/appId 不参与（app 卷不挂，参数自然失效）。
  // 快照模式不挂任何卷：workspace 已随快照 rootfs 持久化，node_modules 也在快照内。
  // package-cache PVC 是 RWO——同会话快照重建/多沙箱并存时第二个挂载者会被
  // 调度到无卷节点而 Pending（实测服务端 60s 超时），故快照会话不传 volumes。
  if (mode === "snapshot") return []

  if (mode === "none") return []

  if (scope.pvcMode === "app" && !scope.appId?.trim()) {
    throw new Error(`app 模式缺少 appId，拒绝创建 sandbox（sessionID=${scope.sessionID}）`)
  }
  const useApp = mode === "pvc" && scope.pvcMode === "app"
  const prefix = useApp ? `apps/${scope.appId!.trim()}` : `sessions/${scope.sessionID}`
  const mounts = [
    { name: "workspace", mountPath: "/workspace", sub: `${prefix}/workspace` },
    { name: "resources", mountPath: "/resources", sub: `${prefix}/resources` },
    { name: "home", mountPath: "/home/sandbox", sub: `${prefix}/home` },
    { name: "cache", mountPath: "/home/sandbox/.cache", sub: `${prefix}/cache` },
    { name: "config", mountPath: "/home/sandbox/.config", sub: `${prefix}/config` },
    { name: "local", mountPath: "/home/sandbox/.local", sub: `${prefix}/local` },
    { name: "tmp", mountPath: "/home/sandbox/tmp", sub: `${prefix}/tmp` },
  ]

  const result = mounts.map((m) => {
    const base: Volume = { name: m.name, mountPath: m.mountPath, subPath: m.sub }
    if (mode === "pvc") {
      base.pvc = { claimName: config.pvcClaimName }
    } else {
      base.host = { path: `/var/opencode/sessions/${scope.sessionID}/${m.name}` }
    }
    return base
  })

  if (mode === "pvc") {
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

export function withExecTimeout(
  effect: Effect.Effect<CommandExecution, Error>,
  timeoutSeconds: number | undefined,
): Effect.Effect<CommandExecution, Error> {
  if (!timeoutSeconds) return effect
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(timeoutSeconds),
      orElse: () => Effect.succeed({
        logs: { stdout: [], stderr: [] },
        result: [],
        exitCode: null,
        error: {
          name: "TimeoutError",
          value: `Command timed out after ${timeoutSeconds}s`,
          timestamp: Date.now(),
          traceback: [],
        },
      } as CommandExecution),
    }),
  )
}

export function withCommandOperationTimeout<A>(
  effect: Effect.Effect<A, Error>,
  timeoutSeconds: number | undefined,
  operation: string,
) {
  if (!timeoutSeconds) return effect
  return effect.pipe(
    Effect.timeoutOrElse({
      duration: Duration.seconds(timeoutSeconds),
      orElse: () => Effect.fail(new Error(`${operation} timed out after ${timeoutSeconds}s`)),
    }),
  )
}

const COMMAND_PERMIT_UNAVAILABLE = new Error("command semaphore unavailable")
// 外层预算 = timeoutSeconds + 宽限。排队通常毫秒级完成；宽限保证执行阶段的
// withExecTimeout 总是先到期，避免外层把执行超时误判成排队超时
const COMMAND_QUEUE_GRACE_SECONDS = 5
const queueLog = Log.create({ service: "sandbox-provider" })

// 沙箱级消失错误：沙箱/命令会话在挂起期间被回收等场景，强制重建后重试是安全的
// （命令不可能已在远端执行）。刻意收窄匹配，绝不误伤业务级 "File not found" 等错误。
export function isSandboxGone(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  if (msg.includes("Sandbox is no longer running")) return true
  return /^runInSession failed:|^runDetached failed:|^Failed to create (command|detached) session:/i.test(msg) &&
    /not found|\b404\b/i.test(msg)
}

export function withCommandSemaphoreTimeout<A>(
  semaphore: Semaphore.Semaphore,
  effect: Effect.Effect<A, Error>,
  timeoutSeconds: number | undefined,
  operation: string,
) {
  if (!timeoutSeconds) return semaphore.withPermit(effect)
  const t0 = Date.now()
  return withCommandOperationTimeout(
    semaphore.withPermitsIfAvailable(1)(effect).pipe(
      Effect.flatMap((result) => {
        if (Option.isSome(result)) {
          queueLog.info("command permit acquired", { operation, waitedMs: Date.now() - t0 })
          return Effect.succeed(result.value)
        }
        return Effect.fail(COMMAND_PERMIT_UNAVAILABLE)
      }),
      Effect.retry({
        while: (error) => error === COMMAND_PERMIT_UNAVAILABLE,
        schedule: Schedule.spaced(Duration.millis(10)),
      }),
    ),
    timeoutSeconds + COMMAND_QUEUE_GRACE_SECONDS,
    operation,
  )
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
  const CREATE_TIMEOUT_SECONDS = 60
  const GET_OR_CREATE_TIMEOUT_SECONDS = 90
  const COMMAND_CLEANUP_TIMEOUT_SECONDS = 10

  export interface Interface {
    readonly getOrCreate: (
      sessionID: SessionID,
      opts?: { pvcMode?: "session" | "app"; appId?: string; sandbox?: { cpu: string; memory: string; image?: string; snapshotId?: string } },
    ) => Effect.Effect<Sandbox>
    readonly get: (sessionID: SessionID) => Effect.Effect<Sandbox | null>
    readonly destroy: (sessionID: SessionID) => Effect.Effect<void>
    readonly destroyById: (sandboxID: string) => Effect.Effect<void>
    readonly destroyAll: () => Effect.Effect<void>
    readonly cleanupSessionVolume: (sessionID: SessionID) => Effect.Effect<void>
    readonly purgeSnapshots?: (sessionID: SessionID) => Effect.Effect<void>
    /** 显式快照：对会话当前沙箱发起快照（异步，不等 Ready），返回快照 id；无沙箱/失败返回 null */
    readonly createSnapshot?: (sessionID: SessionID) => Effect.Effect<string | null>
    /** 会话最新快照状态（无则 null） */
    readonly getLatestSnapshot?: (sessionID: SessionID) => Effect.Effect<{ id: string; state: string; reason: string | null } | null>
    readonly keepAlive: (sessionID: SessionID) => Effect.Effect<void>
    readonly touch: (sessionID: SessionID) => Effect.Effect<void>
    readonly release: (sessionID: SessionID) => Effect.Effect<void>
    readonly isKeepAlive: (sessionID: SessionID) => Effect.Effect<boolean>
    /** 会话是否为快照持久化模式（创建时固化；onIdle 保留沙箱与否的依据） */
    readonly isSnapshotSession: (sessionID: SessionID) => Effect.Effect<boolean>
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
        requestTimeoutSeconds: 120,
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

      function createSandbox(sessionID: SessionID, opts?: { pvcMode?: "session" | "app"; appId?: string; persistMode?: "pvc" | "snapshot"; sandbox?: { cpu: string; memory: string; image?: string; snapshotId?: string } }) {
        return Effect.gen(function* () {
          const resolved = opts ?? (yield* Effect.promise(() => resolveSandboxOpts(sessionID)))
          const timeoutSeconds = hasVolume ? config.maxTtlSeconds : config.timeoutSeconds
          // 只透传 cpu/memory 给远端：SandboxResource 里的 image/snapshotId/persistMode 是
          // opencode 会话级语义，泄漏进 resourceLimits 会被远端按非法资源处理（实测 Pending 60s 超时）
          const resource = resolved.sandbox
            ? { cpu: resolved.sandbox.cpu, memory: resolved.sandbox.memory }
            : config.resourceLimits
          log.info("creating sandbox", { sessionID, volumeType: config.volumeType, timeoutSeconds, pvcMode: resolved.pvcMode, resource })
          const volumes = buildVolumes({ sessionID, pvcMode: resolved.pvcMode, appId: resolved.appId, persistMode: resolved.persistMode }, config)
          const persistMode = resolved.persistMode ?? (config.volumeType === "snapshot" ? "snapshot" : "pvc")
          const sessionImage = resolved.sandbox?.image?.trim()
            || (persistMode === "snapshot" ? config.snapshotImage : config.image)
          const sb = yield* Effect.tryPromise({
            try: () =>
              Sandbox.create({
                connectionConfig,
                image: sessionImage,
                timeoutSeconds,
                resource,
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
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(CREATE_TIMEOUT_SECONDS),
            orElse: () => Effect.fail(new Error(`Sandbox create timed out after ${CREATE_TIMEOUT_SECONDS}s: ${sessionID}`)),
          }),
          Effect.orDie,
          Effect.withSpan("SandboxProvider.createSandbox"),
        )
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

      const touch: Interface["touch"] = touchLastActive

      const release: Interface["release"] = (sessionID) =>
        Effect.sync(() => { log.info("sandbox keep alive released", { sessionID }) })

      const isKeepAlive: Interface["isKeepAlive"] = (sessionID) => Effect.sync(() => false)

      const isSnapshotSession: Interface["isSnapshotSession"] = (sessionID) =>
        Effect.succeed(config.volumeType === "snapshot")

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
            withExecTimeout(
              Effect.tryPromise({
                try: () => sb.commands.runInSession(sessionId!, command, options, handlers, signal),
                catch: (e) => new Error(`runInSession failed: ${String(e)}`),
              }),
              options?.timeoutSeconds,
            ),
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
            return yield* withExecTimeout(
              Effect.tryPromise({
                try: () => runCommandEarlyExit(sb, detachedSessionId, command, options, handlers, signal),
                catch: (e) => new Error(`runDetached failed: ${String(e)}`),
              }),
              options?.timeoutSeconds,
            )
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

      if (config.cleanupOnScopeExit !== false) {
        yield* Effect.addFinalizer(() =>
          destroyAll().pipe(
            Effect.catchCause((cause) => {
              log.error("sandbox cleanup on scope exit failed", { cause: Cause.pretty(cause) })
              return Effect.void
            }),
          ),
        )
      }

      return Service.of({
        getOrCreate, get, destroy, destroyById, destroyAll, keepAlive, touch, release, isKeepAlive, isSnapshotSession,
        runInSession, runDetached, interrupt, register, getEndpoint,
        cleanupSessionVolume: (sessionID) => cleanupSessionVolume(sessionID, config, connectionConfig),
        purgeSnapshots: () => Effect.void,
      })
    }),
  )

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  export const pgLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* SandboxConfig.Service
      yield* Effect.try({
        try: () => validateSnapshotConfig(config),
        catch: (error) => error instanceof Error ? error : new Error(String(error)),
      }).pipe(Effect.orDie)
      const runPromise = Effect.runPromiseWith(yield* Effect.context())
      const commandSemaphores = new Map<string, Semaphore.Semaphore>()
      const detachedCommandSessions = new Map<string, Set<string>>()
      const createRef = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())
      // Sandbox creations outlive the caller that triggered them: when a
      // waiter times out, the creation fiber keeps running here until the
      // layer is disposed.
      const creationScope = yield* Scope.make()
      yield* Effect.addFinalizer(() => Scope.close(creationScope, Exit.succeed(undefined)))
      const sbCache = new Map<string, { sb: Sandbox; cachedAt: number; sandboxID: string }>()
      const SB_CACHE_TTL_MS = 300_000
      const CLEANUP_BATCH_SIZE = 100
      const CLEANUP_RETRY_MS = Math.max(30_000, config.idleReapIntervalMs)
      const COMMAND_HEARTBEAT_MS = Math.max(
        1_000,
        Math.min(60_000, Math.floor(Math.min(config.idleReapMs, config.idleKillMs * 2) / 3)),
      )

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
        requestTimeoutSeconds: 120,
      })

      const hasVolume = config.volumeType !== "none"

      const pgDb: any = Database.Client()
      // 快照模块（所有方法吞错，不影响回收/创建主流程）
      const snapshots = SessionSnapshot.create({
        pgDb,
        connectionConfig,
        ttlMs: config.snapshotTtlMs,
        waitMs: config.snapshotWaitMs,
      })

      type Row = {
        id: string
        session_id: string
        host: string
        state: "running" | "snapshotting" | "killed" | "destroyed"
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

      function dbGetSessionDirectory(sessionID: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .select({ directory: SessionTable.directory })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as SessionID))
            .limit(1)
            .then((rows: { directory: string }[]) => rows[0]?.directory ?? null) as Promise<string | null>,
          catch: () => null as null,
        }).pipe(Effect.orElseSucceed(() => null))
      }

      // 会话级持久化方式（固化在 sandbox JSON 的 persistMode；未固化旧行回退全局 volumeType）
      function dbResolvePersistMode(sessionID: string) {
        const fallback = config.volumeType === "snapshot" ? "snapshot" as const : "pvc" as const
        return Effect.tryPromise({
          try: () => pgDb
            .select({ sandbox: SessionTable.sandbox })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID as SessionID))
            .limit(1)
            .then((rows: { sandbox: unknown }[]) => parseSandboxColumn(rows[0]?.sandbox)?.persistMode ?? fallback),
          catch: () => fallback,
        }).pipe(Effect.orElseSucceed(() => fallback))
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

      function dbEnsureKeepAlive(sessionID: string) {
        return Effect.tryPromise({
          try: async () => {
            const now = Date.now()
            await pgDb
              .insert(SandboxTable)
              .values({
                id: `pending-${sessionID}`,
                session_id: sessionID,
                host: "",
                state: "destroyed",
                keep_alive: true,
                command_session_id: null,
                time_created: now,
                time_updated: now,
              })
              .onConflictDoNothing()
              .run()
            await pgDb
              .update(SandboxTable)
              .set({ keep_alive: true, time_updated: Date.now() })
              .where(eq(SandboxTable.session_id, sessionID))
              .run()
          },
          catch: (e) => new Error(`db.ensureKeepAlive failed: ${String(e)}`),
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

      function dbTransitionState(
        sessionID: string,
        id: string,
        from: "running" | "snapshotting" | "killed",
        to: "running" | "snapshotting" | "killed",
      ) {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ state: to, time_updated: Date.now() })
            .where(and(
              eq(SandboxTable.session_id, sessionID),
              eq(SandboxTable.id, id),
              eq(SandboxTable.state, from),
            ))
            .returning({ id: SandboxTable.id })
            .then((rows: Array<{ id: string }>) => rows.length > 0),
          catch: (e) => new Error(`db.transitionState failed: ${String(e)}`),
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

      function dbSetCommandSession(sessionID: string, id: string, cmdSessionID: string | null) {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ command_session_id: cmdSessionID, time_updated: Date.now() })
            .where(and(eq(SandboxTable.session_id, sessionID), eq(SandboxTable.id, id)))
            .run(),
          catch: (e) => new Error(`db.setCommandSession failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbTouchSandbox(sessionID: string, id: string) {
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ time_updated: Date.now() })
            .where(and(
              eq(SandboxTable.session_id, sessionID),
              eq(SandboxTable.id, id),
              eq(SandboxTable.state, "running"),
            ))
            .returning({ id: SandboxTable.id })
            .then((rows: Array<{ id: string }>) => rows.length > 0),
          catch: (e) => new Error(`db.touchSandbox failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbClaimIdleSandbox(sessionID: string, id: string, threshold: number, keepAlive?: boolean) {
        const retryBefore = Date.now() - CLEANUP_RETRY_MS
        const snapshottingBefore = Date.now() - config.snapshotWaitMs - 60_000
        return Effect.tryPromise({
          try: () => pgDb
            .update(SandboxTable)
            .set({ state: "killed", time_updated: Date.now() })
            .where(and(
              eq(SandboxTable.session_id, sessionID),
              eq(SandboxTable.id, id),
              or(
                and(
                  eq(SandboxTable.state, "running"),
                  lt(SandboxTable.time_updated, threshold),
                  keepAlive === undefined ? undefined : eq(SandboxTable.keep_alive, keepAlive),
                ),
                and(
                  eq(SandboxTable.state, "killed"),
                  lt(SandboxTable.time_updated, retryBefore),
                ),
                and(
                  eq(SandboxTable.state, "snapshotting"),
                  lt(SandboxTable.time_updated, snapshottingBefore),
                ),
              ),
            ))
            .returning({ id: SandboxTable.id })
            .then((rows: Array<{ id: string }>) => rows.length > 0),
          catch: (e) => new Error(`db.claimIdleSandbox failed: ${String(e)}`),
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

      function lockWithTimeout<A>(sessionID: string, effect: Effect.Effect<A, Error>, timeoutSeconds: number) {
        let sem = lockSemaphores.get(sessionID)
        if (!sem) {
          sem = Effect.runSync(Semaphore.make(1))
          lockSemaphores.set(sessionID, sem)
        }
        return withCommandSemaphoreTimeout(sem, effect, timeoutSeconds, "sandbox lock wait")
      }

      // ── Sandbox 生命周期 ──────────────────────────────────────────────

      function reconnect(row: { id: string; host: string }) {
        return Effect.tryPromise({
          try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id }),
          catch: (error) => error instanceof Error ? error : new Error(`Sandbox.connect failed: ${String(error)}`),
        })
      }

      function reconnectIfPresent(row: { id: string; host: string }) {
        return reconnect(row).pipe(
          Effect.catch((error) =>
            error instanceof SandboxApiException && error.statusCode === 404
              ? Effect.succeed(null)
              : Effect.fail(error),
          ),
        )
      }

      function killByID(sandboxId: string, sessionID: string) {
        return Effect.tryPromise({
          try: async () => {
            const killCfg = new ConnectionConfig({
              domain: config.domain,
              protocol: config.protocol,
              ...(config.apiKey ? { apiKey: config.apiKey } : {}),
              useServerProxy: config.useServerProxy,
              requestTimeoutSeconds: 10,
            })
            const manager = SandboxManager.create({ connectionConfig: killCfg })
            try {
              await manager.killSandbox(sandboxId)
            } catch (error) {
              if (!(error instanceof SandboxApiException) || error.statusCode !== 404) throw error
            } finally {
              await manager.close().catch(() => undefined)
            }
          },
          catch: (e) => new Error(`Sandbox kill failed: ${sessionID}/${sandboxId}: ${String(e)}`),
        })
      }

      function createSandbox(sessionID: SessionID, opts?: { pvcMode?: "session" | "app"; appId?: string; persistMode?: "pvc" | "snapshot"; sandbox?: { cpu: string; memory: string; image?: string; snapshotId?: string } }) {
        return Effect.gen(function* () {
          const existingRow = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          const isKept = existingRow?.keep_alive === true
          const baseTtl = hasVolume ? config.maxTtlSeconds : config.timeoutSeconds
          // keepAlive sandbox 使用 10x TTL，确保远程 sandbox 不会在保活期间自杀
          const timeoutSeconds = isKept ? Math.max(baseTtl, config.maxTtlSeconds) * 10 : baseTtl
          const resolved = opts ?? (yield* Effect.promise(() => resolveSandboxOpts(sessionID)))
          const persistMode = resolved.persistMode ?? (config.volumeType === "snapshot" ? "snapshot" : "pvc")
          // 只透传 cpu/memory 给远端：SandboxResource 里的 image/snapshotId/persistMode 是
          // opencode 会话级语义，泄漏进 resourceLimits 会被远端按非法资源处理（实测 Pending 60s 超时）
          const resource = resolved.sandbox
            ? { cpu: resolved.sandbox.cpu, memory: resolved.sandbox.memory }
            : config.resourceLimits
          const timeStarted = Date.now()
          const volumes = buildVolumes({ sessionID, pvcMode: resolved.pvcMode, appId: resolved.appId, persistMode }, config)
          // 会话级沙箱参数（SandboxResource）：镜像覆盖 + 显式恢复源；
          // snapshot 模式冷启动/恢复失败降级用精简镜像（rootfs 小、快照快），默认（pvc）用原镜像
          const sessionImage = resolved.sandbox?.image?.trim()
            || (persistMode === "snapshot" ? config.snapshotImage : config.image)
          const explicitSnapshotId = resolved.sandbox?.snapshotId?.trim() || null

          // 快照恢复优先：显式 snapshotId > 会话快照表最新 ready|stale；恢复失败在 catch 分支降级镜像
          const snapshotId = snapshots && persistMode === "snapshot"
            ? (explicitSnapshotId ?? (yield* Effect.promise(() => snapshots.resolveForCreate(sessionID))))
            : explicitSnapshotId
          const createFromSnapshot = (id: string) =>
            Effect.tryPromise({
              try: () =>
                Sandbox.create({
                  connectionConfig,
                  snapshotId: id,
                  timeoutSeconds,
                  resource,
                  ...(volumes.length > 0 ? { volumes } : {}),
                }),
              catch: (e) => new Error(`Sandbox.create failed: ${e instanceof Error ? e.message : String(e)}`),
            })
          const createFromImage = () =>
            Effect.tryPromise({
              try: () =>
                Sandbox.create({
                  connectionConfig,
                  image: sessionImage,
                  timeoutSeconds,
                  resource,
                  ...(volumes.length > 0 ? { volumes } : {}),
                }),
              catch: (e) => new Error(`Sandbox.create failed: ${e instanceof Error ? e.message : String(e)}`),
            })
          // 快照恢复优先：有快照则从快照拉起（秒级）；恢复失败（快照被 GC/层损坏）
          // 标记 failed 并降级镜像冷启动，不阻塞会话创建
          const created = yield* (snapshotId
            ? createFromSnapshot(snapshotId).pipe(
                Effect.map((sb) => ({ sb, restoredFromSnapshot: true })),
                Effect.catchIf(
                  (err): err is Error => err instanceof Error,
                  (err) =>
                    Effect.andThen(
                      snapshots
                        ? Effect.promise(() => snapshots.markRestoreFailed(sessionID, snapshotId!, err.message))
                        : Effect.void,
                      createFromImage().pipe(Effect.map((sb) => ({ sb, restoredFromSnapshot: false }))),
                    ),
                ),
              )
            : createFromImage().pipe(Effect.map((sb) => ({ sb, restoredFromSnapshot: false }))))
          const sb = created.sb
          // snapshot 模式冷启动（无快照可恢复）时 /workspace 在 rootfs 上，需手动创建
          if (!hasVolume || (persistMode === "snapshot" && !created.restoredFromSnapshot)) {
            yield* Effect.tryPromise(() => sb.commands.run("mkdir -p /workspace")).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          yield* Effect.tryPromise(() => sb.commands.run("git config --global core.fsmonitor true && git config --global core.untrackedcache true")).pipe(
            Effect.catchCause(() => Effect.void),
          )
          const timeFinished = Date.now()
          yield* Effect.tryPromise({
            try: () =>
              pgDb
                .insert(ExecLogTable)
                .values({
                  id: `sandbox-create-${timeStarted}`,
                  session_id: sessionID,
                  command: JSON.stringify({ sandboxID: sb.id, image: sessionImage, restoredFromSnapshot: created.restoredFromSnapshot, durationMs: timeFinished - timeStarted }),
                  status: "completed",
                  source: "sandbox-create",
                  time_started: timeStarted,
                  time_finished: timeFinished,
                })
                .run(),
            catch: () => null,
          }).pipe(Effect.catchCause(() => Effect.void))
          const host = `http://${config.domain}`
          // 远程创建期间 keepAlive 可能已并发设置（async 场景），upsert 前重新读取
          // latest 的 keep_alive，避免用创建前的快照覆盖掉刚设置的 keepAlive。
          const latest = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          yield* dbUpsert({
            id: sb.id,
            session_id: sessionID,
            host,
            state: "running",
            keep_alive: latest?.keep_alive ?? existingRow?.keep_alive ?? false,
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
          // 恢复成功：会话快照标记 stale（已消费，保留作回退直到被新快照替代）；
          // 显式指定的快照（可能来自其他会话，派生语义）状态由其属主会话管理，不动
          if (created.restoredFromSnapshot && snapshotId && snapshots && !explicitSnapshotId) {
            yield* Effect.promise(() => snapshots!.markConsumed(snapshotId)).pipe(Effect.catchCause(() => Effect.void))
          }
          log.info("sandbox created", { sessionID, sandboxID: sb.id, restoreFrom: created.restoredFromSnapshot ? snapshotId : null })
          return sb
        }).pipe(
          Effect.timeoutOrElse({
            duration: Duration.seconds(CREATE_TIMEOUT_SECONDS),
            orElse: () => Effect.fail(new Error(`Sandbox create timed out after ${CREATE_TIMEOUT_SECONDS}s: ${sessionID}`)),
          }),
          Effect.orDie,
          Effect.withSpan("SandboxProvider.createSandbox"),
        )
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
          yield* Effect.tryPromise({
            try: () => sb.kill(),
            catch: (error) => new Error(`Sandbox kill failed: ${sessionID}/${sb.id}: ${String(error)}`),
          }).pipe(
            Effect.tapError(() =>
              Effect.gen(function* () {
                const info = yield* Effect.tryPromise(() => sb.getInfo()).pipe(Effect.orElseSucceed(() => null))
                if (!info?.status) return
                log.warn("sandbox status on kill failure", { sessionID, sandboxID: sb.id, state: info.status.state, reason: info.status.reason, message: info.status.message })
              }),
            ),
            Effect.ensuring(
              Effect.tryPromise(() => sb.close()).pipe(
                Effect.catchCause(() => { log.error("sandbox close failed", { sessionID }); return Effect.void }),
              ),
            ),
          )
          yield* dbMarkDestroyed(sessionID, sb.id)
          log.info("sandbox destroyed", { sessionID })
        }).pipe(Effect.withSpan("SandboxProvider.destroySandbox"))
      }

      function cleanupSandbox(row: Row, opts?: { snapshot?: boolean }) {
        return Effect.gen(function* () {
          invalidateCachedSandbox(row.session_id)
          const sb = yield* reconnectIfPresent(row)
          if (sb) {
            if (opts?.snapshot && snapshots) {
              // 快照+销毁异步化：锁内仅发起，后台 fiber 等快照 Ready 后才 kill 源沙箱。
              // 代码安全承诺：快照未成功不销毁——失败/超时保留沙箱（行保持 killed，300s 后
              // idle reap 重试快照）；沙箱由 TTL 兜底最终回收，重试期间不阻塞会话恢复。
              yield* Effect.gen(function* () {
                const snapshotId = yield* Effect.promise(() => snapshots.startSnapshot(sb, row.session_id))
                if (!snapshotId) {
                  log.warn("snapshot start failed; keeping sandbox for retry", { sessionID: row.session_id, sandboxID: sb.id })
                  yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catchCause(() => Effect.void))
                  return
                }
                const result = yield* Effect.promise(() => snapshots.awaitSnapshot(row.session_id, snapshotId))
                if (result !== "ready") {
                  log.warn("snapshot not ready; keeping sandbox for retry", { sessionID: row.session_id, sandboxID: sb.id, snapshotId })
                  yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catchCause(() => Effect.void))
                  return
                }
                yield* destroySandbox(sb, row.session_id).pipe(Effect.catchCause(() => Effect.void))
              }).pipe(Effect.forkIn(creationScope))
              return
            }
            return yield* destroySandbox(sb, row.session_id)
          }
          yield* killByID(row.id, row.session_id)
          yield* dbMarkDestroyed(row.session_id, row.id)
          log.info("sandbox destroyed by id", { sessionID: row.session_id, sandboxID: row.id })
        }).pipe(
          Effect.catchCause((cause) => {
            log.error("sandbox cleanup failed; leaving killed for retry", {
              sessionID: row.session_id,
              sandboxID: row.id,
              cause: Cause.pretty(cause),
            })
            return Effect.void
          }),
        )
      }

      function withCommandHeartbeat<A, E>(sessionID: string, sandboxID: string, effect: Effect.Effect<A, E>) {
        const intervalMs = Math.min(COMMAND_HEARTBEAT_MS, Math.max(1_000, Math.floor(config.idleReapMs / 3)))
        return Effect.scoped(
          Effect.gen(function* () {
            const active = yield* dbTouchSandbox(sessionID, sandboxID)
            if (!active) return yield* Effect.fail(new Error(`Sandbox is no longer running: ${sessionID}/${sandboxID}`))
            yield* dbTouchSandbox(sessionID, sandboxID).pipe(
              Effect.catchCause(() => Effect.void),
              Effect.repeat(Schedule.spaced(Duration.millis(intervalMs))),
              Effect.forkScoped,
            )
            return yield* effect
          }),
        )
      }

      function claim<D, E>(ref: Ref.Ref<Map<string, Deferred.Deferred<D, E>>>, key: string, token: Deferred.Deferred<D, E>) {
        return Ref.modify(ref, (map) => {
          const existing = map.get(key)
          if (existing) return [existing, map] as const
          return [token, map.set(key, token)] as const
        })
      }

      // ── Interface 实装 ────────────────────────────────────────────────

      function getOrCreateUnlocked(sessionID: SessionID, opts?: { pvcMode?: "session" | "app"; appId?: string; sandbox?: { cpu: string; memory: string; image?: string; snapshotId?: string } }) {
        return Effect.gen(function* () {
          const cached = getCachedSandbox(sessionID)
          if (cached) {
            const touched = yield* dbTouchSandbox(sessionID, cached.id).pipe(Effect.orElseSucceed(() => false))
            if (touched) return cached
            invalidateCachedSandbox(sessionID)
          }

          const t0 = Date.now()
          log.info("getOrCreate start", { sessionID })

          // pod 内去重
          const myToken = yield* Deferred.make<Sandbox, Error>()
          const winner = yield* claim(createRef, sessionID, myToken)
          if (winner !== myToken) {
            log.info("getOrCreate awaiting winner", { sessionID, ms: Date.now() - t0 })
            return yield* Deferred.await(winner).pipe(Effect.orDie)
          }

          // The creation body runs in a background (scoped) fiber: when a
          // waiter (e.g. getOrCreate's 90s timeout) gives up, the creation
          // keeps going instead of being cancelled, so a retry joins the
          // in-flight creation via createRef/Deferred or the sandbox cache
          // rather than starting from scratch.
          yield* Effect.gen(function* () {
            const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))

            const sb = yield* Effect.gen(function* () {
              if (row?.state === "running") {
                const tReconnect = Date.now()
                const existing = yield* reconnectIfPresent(row)
                log.info("reconnect done", {
                  sessionID,
                  sandboxID: row.id,
                  ms: Date.now() - tReconnect,
                  success: !!existing,
                })

                if (existing) {
                  const tHealth = Date.now()
                  const healthy = yield* Effect.tryPromise({
                    try: () => existing.isHealthy(),
                    catch: (error) => new Error(`Sandbox health check failed: ${String(error)}`),
                  })
                  log.info("isHealthy done", {
                    sessionID,
                    sandboxID: row.id,
                    ms: Date.now() - tHealth,
                    healthy,
                  })

                  if (healthy) {
                    const touched = yield* dbTouchSandbox(sessionID, row.id).pipe(Effect.orElseSucceed(() => false))
                    if (!touched) {
                      yield* Effect.tryPromise(() => existing.close()).pipe(Effect.ignore)
                      return yield* Effect.fail(new Error(`Sandbox lifecycle changed: ${sessionID}/${row.id}`))
                    }
                    log.info("reconnected to existing sandbox", {
                      sessionID,
                      sandboxID: row.id,
                      totalMs: Date.now() - t0,
                    })
                    return existing
                  }
                  log.warn("sandbox unhealthy after reconnect, rebuilding", { sessionID })
                  yield* dbSetStateFor(sessionID, row.id, "killed")
                  if (snapshots && (yield* dbResolvePersistMode(sessionID)) === "snapshot") {
                    yield* Effect.tryPromise(() => existing.close()).pipe(Effect.catchCause(() => Effect.void))
                    yield* cleanupSandbox({ ...row, state: "killed" }, { snapshot: true })
                    return yield* Effect.fail(new Error(`Sandbox cleanup pending: ${sessionID}/${row.id}`))
                  }
                  yield* destroySandbox(existing, sessionID)
                } else {
                  invalidateCachedSandbox(sessionID)
                  log.info("sandbox no longer exists; rebuilding", { sessionID, sandboxID: row.id })
                }
              }
              if (row?.state === "snapshotting") {
                return yield* Effect.fail(new Error(`Sandbox snapshot pending: ${sessionID}/${row.id}`))
              }
              if (row?.state === "killed") {
                log.info("retrying killed sandbox cleanup before recreation", { sessionID, sandboxID: row.id })
                // 快照保护：killed 行可能是上次快照未完成保留的沙箱，重试同样先快照再销毁
                // （异步 fork；快照未完成期间本函数走下方 "cleanup pending" 失败，下次重试恢复）
                const snapshotSession = snapshots && (yield* dbResolvePersistMode(sessionID)) === "snapshot"
                yield* cleanupSandbox(row, snapshotSession ? { snapshot: true } : undefined)
                const pending = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
                if (pending?.id === row.id && pending.state === "killed") {
                  return yield* Effect.fail(new Error(`Sandbox cleanup pending: ${sessionID}/${row.id}`))
                }
              }
              // P0-3: cross-pod mutex — transaction-level locks are released with
              // the same pooled connection that acquired them.
              const tCreate = Date.now()
              const result = yield* Effect.promise(() =>
                pgDb.transaction(async (tx: any) => {
                  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${sessionID}))`)
                  const current = await runPromise(dbGet(sessionID).pipe(Effect.orElseSucceed(() => null)))
                  if (current?.state === "running") {
                    const existing = await runPromise(reconnectIfPresent(current))
                    if (existing) {
                      const healthy = await existing.isHealthy().catch(() => false)
                      if (healthy) {
                        const touched = await runPromise(dbTouchSandbox(sessionID, current.id).pipe(Effect.orElseSucceed(() => false)))
                        if (!touched) {
                          await existing.close().catch(() => undefined)
                          throw new Error(`Sandbox lifecycle changed: ${sessionID}/${current.id}`)
                        }
                        return existing
                      }
                    }
                  }
                  return runPromise(createSandbox(sessionID, opts))
                }) as Promise<Sandbox>,
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
                  // 保留原始失败信息（如 "Sandbox snapshot pending"），避免 waiter 拿到无意义的通用文案
                  const failReason = cause.reasons.find(Cause.isFailReason)
                  const message = failReason?.error?.message ?? Cause.pretty(cause)
                  yield* Deferred.fail(myToken, new Error(message)).pipe(Effect.catchCause(() => Effect.void))
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
            Effect.forkIn(creationScope),
          )

          return yield* Deferred.await(myToken)
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
            invalidateCachedSandbox(sessionID)
            log.warn("sandbox reconnect failed; leaving state unchanged", { sessionID, sandboxID: row.id })
            return null
          }
          yield* dbTouchSandbox(sessionID, row.id).pipe(Effect.catchCause(() => Effect.void))
          return sb
        }).pipe(Effect.withSpan("SandboxProvider.get"))

      const destroy: Interface["destroy"] = (sessionID) =>
        lock(sessionID, Effect.gen(function* () {
          invalidateCachedSandbox(sessionID)
          // keepAlive 是 session 维度的持久偏好：destroy 只销毁 sandbox，不改变 keepAlive。
          // 清除 keepAlive 必须显式调用 release()；destroy 后重建仍继承 keepAlive。
          const inFlight = yield* Ref.modify(createRef, (m) => {
            const d = m.get(sessionID)
            if (d) m.delete(sessionID)
            return [d, m] as const
          })
          if (inFlight) yield* Deferred.fail(inFlight, new Error(`Sandbox destroyed while creating: ${sessionID}`))
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (row?.state === "running" || row?.state === "snapshotting" || row?.state === "killed") {
            if (row.state !== "killed") yield* dbSetStateFor(sessionID, row.id, "killed")
            const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
            if (sb) yield* destroySandbox(sb, sessionID).pipe(Effect.catchCause(() => Effect.void))
            else yield* cleanupSandbox({ ...row, state: "killed" })
          }
        })).pipe(Effect.withSpan("SandboxProvider.destroy"))

      const destroyById: Interface["destroyById"] = (sandboxID) =>
        Effect.gen(function* () {
          const row = yield* dbGetById(sandboxID).pipe(Effect.orElseSucceed(() => null))
          if (!row || (row.state !== "running" && row.state !== "snapshotting" && row.state !== "killed")) return
          invalidateCachedSandbox(row.session_id)
          yield* lock(row.session_id, Effect.gen(function* () {
            invalidateCachedSandbox(row.session_id)
            const current = yield* dbGetById(sandboxID).pipe(Effect.orElseSucceed(() => null))
            if (!current || current.id !== sandboxID || (current.state !== "running" && current.state !== "snapshotting" && current.state !== "killed")) return
            if (current.state !== "killed") yield* dbSetStateFor(current.session_id, current.id, "killed")
            const inFlight = yield* Ref.modify(createRef, (m) => {
              const d = m.get(current.session_id)
              if (d) m.delete(current.session_id)
              return [d, m] as const
            })
            if (inFlight) yield* Deferred.fail(inFlight, new Error(`Sandbox destroyed while creating: ${current.session_id}`))
            yield* cleanupSandbox({ ...current, state: "killed" })
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
              yield* dbSetStateFor(row.session_id, row.id, "killed")
              yield* cleanupSandbox({ ...row, state: "killed" })
            }))
          }
          commandSemaphores.clear()
          detachedCommandSessions.clear()
        }).pipe(Effect.withSpan("SandboxProvider.destroyAll"))

      const keepAlive: Interface["keepAlive"] = (sessionID) =>
        Effect.gen(function* () {
          yield* dbEnsureKeepAlive(sessionID)
          log.info("sandbox keep alive enabled", { sessionID })
        })

      const touch: Interface["touch"] = (sessionID) =>
        Effect.gen(function* () {
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (row && row.state === "running")
            yield* dbTouchSandbox(sessionID, row.id).pipe(Effect.catchCause(() => Effect.void))
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

      // 挂起恢复自愈：question/permission 长时间等待用户期间沙箱可能已被 idle-reap 回收，
      // 恢复后的第一次命令会命中陈旧状态而失败。检测到沙箱级消失错误时强制重建并重试一次，
      // 让「隔了很久才回来」的用户无感继续任务（重试安全：沙箱已消失时命令不可能已在远端执行）。
      const withRecreateRetry = <A>(sessionID: SessionID, attempt: () => Effect.Effect<A, Error>) =>
        attempt().pipe(
          Effect.catchIf(isSandboxGone, () =>
            Effect.gen(function* () {
              log.warn("sandbox gone; recreating and retrying command once", { sessionID })
              // 陈旧的 command session 记录也要清掉，否则重试仍复用失效 ID
              const stale = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
              if (stale?.command_session_id) {
                yield* dbSetCommandSession(sessionID, stale.id, null).pipe(Effect.catchCause(() => Effect.void))
              }
              invalidateCachedSandbox(sessionID)
              return yield* attempt()
            }),
          ),
        )

      const runInSession: Interface["runInSession"] = (sessionID, command, options, handlers, signal) =>
        withRecreateRetry(sessionID, () =>
        Effect.gen(function* () {
          const operationTimeoutSeconds = options?.timeoutSeconds
            ? Math.min(options.timeoutSeconds, GET_OR_CREATE_TIMEOUT_SECONDS)
            : GET_OR_CREATE_TIMEOUT_SECONDS
          const sb = yield* lockWithTimeout(sessionID, getOrCreateUnlocked(sessionID), operationTimeoutSeconds)
          yield* dbTouchSandbox(sessionID, sb.id).pipe(Effect.catchCause(() => Effect.void))
          const workingDirectory = options?.workingDirectory ?? (yield* dbGetSessionDirectory(sessionID)) ?? "/workspace"

          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          let cmdSessionID = (row?.id === sb.id ? row?.command_session_id : null) ?? null

          let sem = commandSemaphores.get(sessionID)
          if (!sem) { sem = Effect.runSync(Semaphore.make(1)); commandSemaphores.set(sessionID, sem) }

          if (!cmdSessionID) {
            cmdSessionID = yield* withCommandSemaphoreTimeout(
              sem,
              Effect.gen(function* () {
                const row2 = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
                const existing = (row2?.id === sb.id ? row2?.command_session_id : null) ?? null
                if (existing) return existing

                const newSession = yield* withCommandOperationTimeout(Effect.tryPromise({
                  try: () => sb.commands.createSession({ workingDirectory }),
                  catch: (e) => new Error(`Failed to create command session: ${String(e)}`),
                }), options?.timeoutSeconds, "create command session")
                yield* dbSetCommandSession(sessionID, sb.id, newSession).pipe(Effect.catchCause(() => Effect.void))
                return newSession
              }),
              options?.timeoutSeconds,
              "prepare command session",
            )
          }

          return yield* withCommandSemaphoreTimeout(
            sem,
            withCommandHeartbeat(sessionID, sb.id, withExecTimeout(
              Effect.tryPromise({
                try: () => runCommandEarlyExit(sb, cmdSessionID!, command, { ...options, workingDirectory }, handlers, signal),
                catch: (e) => new Error(`runInSession failed: ${String(e)}`),
              }).pipe(
                Effect.tapError((err) =>
                  String(err).includes("not found")
                    ? Effect.sync(() => { invalidateCachedSandbox(sessionID); log.warn("sandbox invalidated after command failure", { sessionID }) })
                    : Effect.void,
                ),
              ),
              options?.timeoutSeconds,
            // 超时后旧命令仍在沙箱执行，且 SDK interrupt 会让持久 session 进入
            // 立即 EOF 的报废状态：改为销毁 command session 并清 PG 记录，
            // 下条命令自动重建干净 session（同时隔离旧进程输出交叉）
            ).pipe(
              Effect.tap((result) => {
                if (result.error?.name !== "TimeoutError") return Effect.void
                log.warn("foreground command timed out; recycling command session", { sessionID, sandboxID: sb.id })
                return withCommandOperationTimeout(
                  Effect.tryPromise({
                    try: () => sb.commands.deleteSession(cmdSessionID!),
                    catch: (e) => new Error(`delete timed-out session failed: ${String(e)}`),
                  }),
                  COMMAND_CLEANUP_TIMEOUT_SECONDS,
                  "recycle timed-out command session",
                ).pipe(
                  Effect.catchCause(() => Effect.void),
                  Effect.andThen(dbSetCommandSession(sessionID, sb.id, null).pipe(Effect.catchCause(() => Effect.void))),
                )
              }),
              // SDK 对失效的 command session 不报错而是静默返回空流（无 complete/error/exitCode），
              // 转成 isSandboxGone 可识别的失败，交由外层重建重试
              Effect.tap((result) => {
                if (result.complete || result.error || result.exitCode != null) return Effect.void
                log.warn("empty execution stream; command session likely stale", { sessionID, cmdSessionID })
                return Effect.fail(new Error(`runInSession failed: command session ${cmdSessionID} not found (empty execution stream)`))
              }),
            )),
            options?.timeoutSeconds,
            // 外层预算覆盖排队等待 + 执行；执行超时走 TimeoutError 结果路径，此处 fail 多为纯排队超时
            "command queue wait",
          )
        }).pipe(Effect.withSpan("SandboxProvider.runInSession")),
        )

      const runDetached: Interface["runDetached"] = (sessionID, command, options, handlers, signal) =>
        withRecreateRetry(sessionID, () =>
        Effect.gen(function* () {
          const operationTimeoutSeconds = options?.timeoutSeconds
            ? Math.min(options.timeoutSeconds, GET_OR_CREATE_TIMEOUT_SECONDS)
            : GET_OR_CREATE_TIMEOUT_SECONDS
          const sb = yield* lockWithTimeout(sessionID, getOrCreateUnlocked(sessionID), operationTimeoutSeconds)
          yield* dbTouchSandbox(sessionID, sb.id).pipe(Effect.catchCause(() => Effect.void))
          const workingDirectory = options?.workingDirectory ?? (yield* dbGetSessionDirectory(sessionID)) ?? "/workspace"
          const detachedSessionId = yield* withCommandOperationTimeout(Effect.tryPromise({
            try: () => sb.commands.createSession({ workingDirectory }),
            catch: (e) => new Error(`Failed to create detached session: ${String(e)}`),
          }), options?.timeoutSeconds, "create detached command session")
          const detached = detachedCommandSessions.get(sessionID) ?? new Set<string>()
          detached.add(detachedSessionId)
          detachedCommandSessions.set(sessionID, detached)
          let completed = false
          try {
          // async/detached 命令不维持心跳：后台命令不应阻止 idle-reap 回收无人使用的会话沙箱。
          // 防误杀只保留给前台命令（runInSession，AI 正在同步等待）。
          const result = yield* withExecTimeout(
              Effect.tryPromise({
                try: () => runCommandEarlyExit(sb, detachedSessionId, command, { ...options, workingDirectory }, handlers, signal),
                catch: (e) => new Error(`runDetached failed: ${String(e)}`),
              }).pipe(
                Effect.tapError((err) =>
                  String(err).includes("not found")
                    ? Effect.sync(() => { invalidateCachedSandbox(sessionID); log.warn("sandbox invalidated after detached failure", { sessionID }) })
                    : Effect.void,
                ),
              ),
              options?.timeoutSeconds,
            // detached 同样可能命中失效 session 的静默空流，转成可重试失败
            ).pipe(
              Effect.tap((result) => {
                if (result.complete || result.error || result.exitCode != null) return Effect.void
                log.warn("empty detached execution stream; session likely stale", { sessionID, detachedSessionId })
                return Effect.fail(new Error(`runDetached failed: command session ${detachedSessionId} not found (empty execution stream)`))
              }),
            )
            if (result.error?.name === "TimeoutError") {
              yield* Effect.tryPromise(() => sb.commands.interrupt(detachedSessionId)).pipe(Effect.ignore)
            }
            completed = true
            return result
          } finally {
            if (!completed) yield* Effect.tryPromise(() => sb.commands.interrupt(detachedSessionId)).pipe(Effect.ignore)
            yield* withCommandOperationTimeout(
              Effect.tryPromise(() => sb.commands.deleteSession(detachedSessionId)),
              COMMAND_CLEANUP_TIMEOUT_SECONDS,
              "delete detached command session",
            ).pipe(Effect.ignore)
            detached.delete(detachedSessionId)
            if (detached.size === 0) detachedCommandSessions.delete(sessionID)
          }
        }).pipe(Effect.withSpan("SandboxProvider.runDetached")),
        )

      const interrupt: Interface["interrupt"] = (sessionID) =>
        Effect.gen(function* () {
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          const detached = detachedCommandSessions.get(sessionID)
          if (!row?.command_session_id && !detached?.size) return
          const sb = yield* getOrCreate(sessionID)
          const sessions = [
            ...(row?.command_session_id ? [row.command_session_id] : []),
            ...(detached ? [...detached] : []),
          ]
          yield* Effect.all(
            sessions.map((commandSessionID) =>
              Effect.tryPromise({
                try: () => sb.commands.interrupt(commandSessionID),
                catch: () => {},
              }).pipe(Effect.catch(() => Effect.void)),
            ),
            { concurrency: "unbounded", discard: true },
          )
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
          const existing = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          yield* dbUpsert({
            id: sb.id,
            session_id: sessionID,
            host: `http://${config.domain}`,
            state: "running",
            keep_alive: existing?.keep_alive ?? false,
            command_session_id: null,
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          cacheSandbox(sessionID, sb)
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
                .orderBy(asc(SandboxTable.time_updated))
                .limit(CLEANUP_BATCH_SIZE)
                .all() as Promise<Row[]>,
              catch: (error) => new Error(`zombie sandbox query failed: ${String(error)}`),
            }).pipe(Effect.catchCause((cause) => {
              log.error("zombie sandbox query failed", { cause: Cause.pretty(cause) })
              return Effect.succeed([] as Row[])
            }))

            if (rows.length === 0) return
            log.info("zombie sandbox cleanup", { count: rows.length })
            yield* Effect.forEach(rows, (row) =>
              lock(row.session_id, Effect.gen(function* () {
                const claimed = yield* dbClaimIdleSandbox(row.session_id, row.id, threshold, false)
                if (!claimed) return
                const snapshotSession = !!snapshots && (yield* dbResolvePersistMode(row.session_id)) === "snapshot"
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
                  if (!snapshotSession) {
                    yield* destroySandbox(sb, row.session_id).pipe(Effect.catchCause(() => Effect.void))
                    return
                  }
                  // zombie 判定只基于 time_updated 超时，沙箱可能实际存活（与 idle 场景重叠）。
                  // 快照会话与 idle reap 同一语义：快照 Ready 才 kill，失败保留沙箱重试。
                  // 关闭本次探测连接，cleanupSandbox 内部会重新 connect。
                  yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catchCause(() => Effect.void))
                }
                yield* cleanupSandbox({ ...row, state: "killed" }, snapshotSession ? { snapshot: true } : undefined)
              })).pipe(Effect.catchCause((cause) => {
                log.error("zombie sandbox candidate failed", { sessionID: row.session_id, cause: Cause.pretty(cause) })
                return Effect.void
              })),
              { concurrency: 4, discard: true },
            )
          }),
          { schedule: Schedule.spaced(config.idleKillMs) },
        ).pipe(
          Effect.forkScoped,
          Effect.interruptible,
        )
      })

      // 周期性回收空闲 sandbox（含 keep_alive=true，idleReapMs 阈值）
      // 判定：state=running 且 time_updated 超过 idleReapMs 未更新
      const idleReapMs = config.idleReapMs
      yield* Effect.gen(function* () {
        yield* Effect.repeat(
          Effect.gen(function* () {
            const threshold = Date.now() - idleReapMs
            const retryBefore = Date.now() - CLEANUP_RETRY_MS
            const snapshottingBefore = Date.now() - config.snapshotWaitMs - 60_000
            const rows = yield* Effect.tryPromise({
              try: () => pgDb
                .select()
                .from(SandboxTable)
                .where(or(
                  and(
                    eq(SandboxTable.state, "running"),
                    lt(SandboxTable.time_updated, threshold),
                  ),
                  and(
                    eq(SandboxTable.state, "killed"),
                    lt(SandboxTable.time_updated, retryBefore),
                  ),
                  and(
                    eq(SandboxTable.state, "snapshotting"),
                    lt(SandboxTable.time_updated, snapshottingBefore),
                  ),
                ))
                .orderBy(asc(SandboxTable.time_updated))
                .limit(CLEANUP_BATCH_SIZE)
                .all() as Promise<Row[]>,
              catch: (error) => new Error(`idle sandbox reap query failed: ${String(error)}`),
            }).pipe(Effect.catchCause((cause) => {
              log.error("idle sandbox reap query failed", { cause: Cause.pretty(cause) })
              return Effect.succeed([] as Row[])
            }))

            // 顺带执行快照 GC + 对账（吞错；独立于本轮是否有 idle 沙箱）
            if (snapshots) yield* Effect.promise(() => snapshots.gc()).pipe(Effect.catchCause(() => Effect.void))

            if (rows.length === 0) return
            log.info("idle sandbox reap scan", { count: rows.length })
            yield* Effect.forEach(rows, (row) =>
              lock(row.session_id, Effect.gen(function* () {
                const claimed = yield* dbClaimIdleSandbox(row.session_id, row.id, threshold)
                if (!claimed) return
                const snapshotSession = !!snapshots && (yield* dbResolvePersistMode(row.session_id)) === "snapshot"
                yield* cleanupSandbox({ ...row, state: "killed" }, snapshotSession ? { snapshot: true } : undefined)
              })).pipe(Effect.catchCause((cause) => {
                log.error("idle sandbox candidate failed", { sessionID: row.session_id, cause: Cause.pretty(cause) })
                return Effect.void
              })),
              { concurrency: 4, discard: true },
            )
          }),
          { schedule: Schedule.spaced(Duration.millis(config.idleReapIntervalMs)) },
        ).pipe(
          Effect.forkScoped,
          Effect.interruptible,
        )
      })

      // PG sandboxes are shared across server instances. Process shutdown must
      // not destroy resources owned by other instances; idle cleanup handles them.

      return Service.of({
        getOrCreate, get, destroy, destroyById, destroyAll, keepAlive, touch, release, isKeepAlive,
        isSnapshotSession: (sessionID) => dbResolvePersistMode(sessionID).pipe(Effect.map((mode) => mode === "snapshot")),
        runInSession, runDetached, interrupt, register, getEndpoint,
        cleanupSessionVolume: (sessionID) => cleanupSessionVolume(sessionID, config, connectionConfig),
        // 会话删除联动：清理该会话全部快照记录与远端快照（含用户数据，不留存）
        purgeSnapshots: (sessionID) =>
          snapshots
            ? Effect.promise(() => snapshots.deleteAllForSession(sessionID)).pipe(Effect.catchCause(() => Effect.void))
            : Effect.void,
        // 显式快照：先 fence sandbox，阻止新写入；终态后恢复 running，源沙箱不销毁。
        createSnapshot: (sessionID) =>
          lock(sessionID, Effect.gen(function* () {
            if (!snapshots) {
              log.info("snapshot request rejected", { sessionID, reason: "snapshot disabled" })
              return null
            }
            // 仅快照会话支持显式快照（pvc 会话 workspace 在共享卷，快照无意义）
            const mode = yield* dbResolvePersistMode(sessionID)
            if (mode !== "snapshot") {
              log.info("snapshot request rejected", { sessionID, reason: `persistMode=${mode}` })
              return null
            }
            const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
            if (!row || row.state !== "running") {
              log.info("snapshot request rejected", { sessionID, reason: `sandbox state=${row?.state ?? "none"}` })
              return null
            }
            const claimed = yield* dbTransitionState(sessionID, row.id, "running", "snapshotting")
            if (!claimed) {
              log.info("snapshot request rejected", { sessionID, reason: "state transition running->snapshotting lost race" })
              return null
            }
            const sb = yield* reconnectIfPresent(row).pipe(
              Effect.tapError(() => dbTransitionState(sessionID, row.id, "snapshotting", "running")),
            )
            if (!sb) {
              log.warn("snapshot request failed; sandbox gone on server", { sessionID, sandboxID: row.id })
              yield* dbMarkDestroyed(sessionID, row.id)
              return null
            }
            const id = yield* Effect.promise(() => snapshots.startSnapshot(sb, sessionID))
            if (!id) {
              log.warn("snapshot request failed; startSnapshot error", { sessionID, sandboxID: row.id })
              yield* dbTransitionState(sessionID, row.id, "snapshotting", "running")
              yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catchCause(() => Effect.void))
              return null
            }
            yield* Effect.promise(() => snapshots.awaitSnapshot(sessionID, id)).pipe(
              Effect.ensuring(Effect.gen(function* () {
                yield* dbTransitionState(sessionID, row.id, "snapshotting", "running").pipe(Effect.catchCause(() => Effect.void))
                yield* Effect.tryPromise(() => sb.close()).pipe(Effect.catchCause(() => Effect.void))
              })),
              Effect.forkIn(creationScope),
            )
            return id
          })).pipe(Effect.catchCause((cause) => {
            log.error("createSnapshot failed", { sessionID, cause: Cause.pretty(cause) })
            return Effect.succeed(null)
          })),
        getLatestSnapshot: (sessionID) =>
          snapshots
            ? Effect.promise(() => snapshots.getLatest(sessionID)).pipe(
                Effect.map((row) => row ? { id: row.id, state: row.state, reason: row.reason } : null),
                Effect.catchCause(() => Effect.succeed(null)),
              )
            : Effect.succeed(null),
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
      touch: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      isSnapshotSession: () => Effect.succeed(false),
      runInSession: () => Effect.fail(new Error("Sandbox is disabled")),
      runDetached: () => Effect.fail(new Error("Sandbox is disabled")),
      interrupt: () => Effect.void,
      register: () => Effect.void,
      getEndpoint: () => Effect.die(new Error("Sandbox is disabled")),
      cleanupSessionVolume: () => Effect.void,
    }),
  )
}
