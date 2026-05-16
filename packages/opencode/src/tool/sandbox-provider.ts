import { Effect, Context, Layer, Cause, Deferred, Ref, Semaphore } from "effect"
import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"
import type { CommandExecution, Volume } from "@alibaba-group/opensandbox"
import { eq } from "drizzle-orm"
import { Log } from "../util/log"
import { Flag } from "../flag/flag"
import { Database } from "../storage/db"
import { SandboxTable } from "./sandbox.pg"
import type { SessionID } from "../session/schema"

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
  }

  export class Service extends Context.Service<Service, Interface>()("@opencode/SandboxConfig") {}

  export const defaultConfig: Interface = {
    domain: Flag.OPENCODE_SANDBOX_DOMAIN,
    protocol: "http" as const,
    apiKey: Flag.OPENCODE_SANDBOX_API_KEY,
    useServerProxy: Flag.OPENCODE_SANDBOX_USE_SERVER_PROXY,
    image: Flag.OPENCODE_SANDBOX_IMAGE,
    timeoutSeconds: Flag.OPENCODE_SANDBOX_TIMEOUT,
    resourceLimits: { cpu: "1", memory: "2Gi" },
    volumeType: Flag.OPENCODE_SANDBOX_VOLUME_TYPE,
    pvcClaimName: Flag.OPENCODE_SANDBOX_PVC_CLAIM,
    idleKillMs: Flag.OPENCODE_SANDBOX_IDLE_KILL_SEC * 1000,
    maxTtlSeconds: Flag.OPENCODE_SANDBOX_MAX_TTL_SEC,
  }

  export const layer = Layer.succeed(Service, Service.of(defaultConfig))
  export const defaultLayer = layer
}

type Entry =
  | { state: "running"; sb: Sandbox; sandboxID: string; lastActive: number }
  | { state: "killed"; sandboxID: string; lastActive: number }

export function buildVolumes(sessionID: string, config: SandboxConfig.Interface): Volume[] {
  if (config.volumeType === "none") return []

  const prefix = `sessions/${sessionID}`
  const mounts = [
    { name: "workspace", mountPath: "/workspace", sub: `${prefix}/workspace` },
    { name: "home", mountPath: "/home/sandbox", sub: `${prefix}/home` },
    { name: "cache", mountPath: "/home/sandbox/.cache", sub: `${prefix}/cache` },
    { name: "config", mountPath: "/home/sandbox/.config", sub: `${prefix}/config` },
    { name: "local", mountPath: "/home/sandbox/.local", sub: `${prefix}/local` },
    { name: "tmp", mountPath: "/home/sandbox/tmp", sub: `${prefix}/tmp` },
  ]

  return mounts.map((m) => {
    const base: Volume = { name: m.name, mountPath: m.mountPath, subPath: m.sub }
    if (config.volumeType === "pvc") {
      base.pvc = { claimName: config.pvcClaimName }
    } else {
      base.host = { path: `/var/opencode/sessions/${sessionID}/${m.name}` }
    }
    return base
  })
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

export namespace SandboxProvider {
  const log = Log.create({ service: "sandbox-provider" })

  export interface Interface {
    readonly getOrCreate: (sessionID: SessionID) => Effect.Effect<Sandbox>
    readonly get: (sessionID: SessionID) => Effect.Effect<Sandbox | null>
    readonly destroy: (sessionID: SessionID) => Effect.Effect<void>
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
      const leases = new Set<string>()
      const createRef = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())
      const sessionRef = yield* Ref.make(new Map<string, Deferred.Deferred<string, Error>>())

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

      function createSandbox(sessionID: SessionID) {
        return Effect.gen(function* () {
          const timeoutSeconds = hasVolume ? config.maxTtlSeconds : config.timeoutSeconds
          log.info("creating sandbox", { sessionID, volumeType: config.volumeType, timeoutSeconds })
          const volumes = buildVolumes(sessionID, config)
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
          commandSemaphores.delete(sessionID)
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

      const getOrCreate: Interface["getOrCreate"] = (sessionID) =>
        Effect.gen(function* () {
          const myToken = yield* Deferred.make<Sandbox, Error>()
          const winner = yield* claim(createRef, sessionID, myToken)
          if (winner !== myToken) return yield* Deferred.await(winner).pipe(Effect.orDie)

          const entry = yield* Ref.modify(entries, (m) => [m.get(sessionID) ?? null, m] as const)

          const sb = yield* Effect.gen(function* () {
            if (!entry) return yield* createSandbox(sessionID)
            if (entry.state === "running") {
              const healthy = yield* Effect.tryPromise(() => entry.sb.isHealthy()).pipe(
                Effect.catch(() => Effect.succeed(false)),
              )
              if (healthy) return entry.sb
              log.warn("sandbox unhealthy, rebuilding", { sessionID })
              yield* destroySandbox(entry.sb, sessionID)
              return yield* createSandbox(sessionID)
            }
            log.info("recreating killed sandbox", { sessionID, sandboxID: entry.sandboxID })
            return yield* createSandbox(sessionID)
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
          leases.delete(sessionID)
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

      const destroyAll: Interface["destroyAll"] = () =>
        Effect.gen(function* () {
          log.info("destroying all sandboxes", { count: sandboxes.size })
          leases.clear()
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
        Effect.sync(() => { leases.add(sessionID); log.info("sandbox keep alive enabled", { sessionID }) })

      const release: Interface["release"] = (sessionID) =>
        Effect.sync(() => { leases.delete(sessionID); log.info("sandbox keep alive released", { sessionID }) })

      const isKeepAlive: Interface["isKeepAlive"] = (sessionID) => Effect.sync(() => leases.has(sessionID))

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
          if (!sem) { sem = yield* Semaphore.make(1); commandSemaphores.set(sessionID, sem) }
          return yield* sem.withPermit(
            Effect.tryPromise({
              try: () => sb.commands.runInSession(sessionId!, command, options, handlers, signal),
              catch: (e) => new Error(`runInSession failed: ${String(e)}`),
            }),
          )
        }).pipe(Effect.withSpan("SandboxProvider.runInSession"))

      const register: Interface["register"] = (sessionID, sb) =>
        Effect.sync(() => {
          commandSessions.delete(sessionID)
          commandSemaphores.delete(sessionID)
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
        getOrCreate, get, destroy, destroyAll, keepAlive, release, isKeepAlive,
        runInSession, register, getEndpoint,
        cleanupSessionVolume: (sessionID) => cleanupSessionVolume(sessionID, config, connectionConfig),
      })
    }),
  )

  // ─── PG / 多 pod 实现（状态全部持久化到 sandbox 表）────────────────
  export const pgLayer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const config = yield* SandboxConfig.Service
      // pod 内仍保留 Semaphore，保证单 pod 内 bash 命令串行
      const commandSemaphores = new Map<string, Semaphore.Semaphore>()
      // pod 内 Deferred 去重，防止同 pod 并发创建同一 session 的沙箱
      const createRef = yield* Ref.make(new Map<string, Deferred.Deferred<Sandbox, Error>>())

      const connectionConfig = new ConnectionConfig({
        domain: config.domain,
        protocol: config.protocol,
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        useServerProxy: config.useServerProxy,
      })

      const hasVolume = config.volumeType !== "none"

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

      // ── DB 操作 ─────────────────────────────────────────────────────

      function dbGet(sessionID: string) {
        return Effect.tryPromise({
          try: () => Database.Client()
            .select()
            .from(SandboxTable)
            .where(eq(SandboxTable.session_id, sessionID))
            .limit(1)
            .then((rows: Row[]) => rows[0] ?? null) as Promise<Row | null>,
          catch: (e) => new Error(`db.get failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbUpsert(row: typeof SandboxTable.$inferInsert) {
        return Effect.tryPromise({
          try: () => Database.Client()
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
          try: () => Database.Client()
            .update(SandboxTable)
            .set({ state, time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, sessionID))
            .run(),
          catch: (e) => new Error(`db.setState failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbSetKeepAlive(sessionID: string, val: boolean) {
        return Effect.tryPromise({
          try: () => Database.Client()
            .update(SandboxTable)
            .set({ keep_alive: val, time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, sessionID))
            .run(),
          catch: (e) => new Error(`db.setKeepAlive failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbSetCommandSession(sessionID: string, cmdSessionID: string) {
        return Effect.tryPromise({
          try: () => Database.Client()
            .update(SandboxTable)
            .set({ command_session_id: cmdSessionID, time_updated: Date.now() })
            .where(eq(SandboxTable.session_id, sessionID))
            .run(),
          catch: (e) => new Error(`db.setCommandSession failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbDelete(sessionID: string) {
        return Effect.tryPromise({
          try: () => Database.Client()
            .delete(SandboxTable)
            .where(eq(SandboxTable.session_id, sessionID))
            .run(),
          catch: (e) => new Error(`db.delete failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      function dbAll() {
        return Effect.tryPromise({
          try: () => Database.Client()
            .select()
            .from(SandboxTable)
            .where(eq(SandboxTable.state, "running"))
            .all() as Promise<Row[]>,
          catch: (e) => new Error(`db.all failed: ${String(e)}`),
        }).pipe(Effect.orDie)
      }

      // ── Sandbox 生命周期 ──────────────────────────────────────────────

      function reconnect(row: { id: string; host: string }) {
        return Effect.tryPromise({
          try: () => Sandbox.connect({ connectionConfig, sandboxId: row.id }),
          catch: (e) => new Error(`Sandbox.connect failed: ${String(e)}`),
        })
      }

      function createSandbox(sessionID: SessionID) {
        return Effect.gen(function* () {
          const timeoutSeconds = hasVolume ? config.maxTtlSeconds : config.timeoutSeconds
          log.info("creating sandbox", { sessionID, volumeType: config.volumeType, timeoutSeconds })
          const volumes = buildVolumes(sessionID, config)
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
            keep_alive: false,
            command_session_id: null,
            time_created: Date.now(),
            time_updated: Date.now(),
          })
          log.info("sandbox created", { sessionID, sandboxID: sb.id })
          return sb
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.createSandbox"))
      }

      function destroySandbox(sb: Sandbox, sessionID: string) {
        return Effect.gen(function* () {
          log.info("destroying sandbox", { sessionID, sandboxID: sb.id })
          commandSemaphores.delete(sessionID)
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (row?.command_session_id) {
            yield* Effect.tryPromise(() => sb.commands.deleteSession(row.command_session_id!)).pipe(
              Effect.catchCause(() => Effect.void),
            )
          }
          yield* Effect.tryPromise(() => sb.kill()).pipe(
            Effect.catchCause(() => { log.error("sandbox kill failed", { sessionID }); return Effect.void }),
          )
          yield* Effect.tryPromise(() => sb.close()).pipe(
            Effect.catchCause(() => { log.error("sandbox close failed", { sessionID }); return Effect.void }),
          )
          yield* dbDelete(sessionID)
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

      const getOrCreate: Interface["getOrCreate"] = (sessionID) =>
        Effect.gen(function* () {
          // pod 内去重
          const myToken = yield* Deferred.make<Sandbox, Error>()
          const winner = yield* claim(createRef, sessionID, myToken)
          if (winner !== myToken) return yield* Deferred.await(winner).pipe(Effect.orDie)

          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))

          const sb = yield* Effect.gen(function* () {
            if (row?.state === "running") {
              // 尝试重连已有沙箱
              const existing = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
              if (existing) {
                const healthy = yield* Effect.tryPromise(() => existing.isHealthy()).pipe(
                  Effect.catch(() => Effect.succeed(false)),
                )
                if (healthy) {
                  log.info("reconnected to existing sandbox", { sessionID, sandboxID: row.id })
                  return existing
                }
                log.warn("sandbox unhealthy after reconnect, rebuilding", { sessionID })
                yield* destroySandbox(existing, sessionID).pipe(Effect.catchCause(() => Effect.void))
              }
            }
            if (row?.state === "killed") {
              log.info("recreating killed sandbox", { sessionID, sandboxID: row.id })
            }
            return yield* createSandbox(sessionID)
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
          yield* Deferred.succeed(myToken, sb)
          return sb
        }).pipe(Effect.orDie, Effect.withSpan("SandboxProvider.getOrCreate"))

      const get: Interface["get"] = (sessionID) =>
        Effect.gen(function* () {
          const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))
          if (!row || row.state !== "running") return null
          const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
          if (!sb) {
            yield* dbSetState(sessionID, "killed").pipe(Effect.catchCause(() => Effect.void))
            return null
          }
          return sb
        }).pipe(Effect.withSpan("SandboxProvider.get"))

      const destroy: Interface["destroy"] = (sessionID) =>
        Effect.gen(function* () {
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
            else yield* dbDelete(sessionID)
          } else {
            yield* dbDelete(sessionID)
          }
          commandSemaphores.delete(sessionID)
        }).pipe(Effect.withSpan("SandboxProvider.destroy"))

      const destroyAll: Interface["destroyAll"] = () =>
        Effect.gen(function* () {
          const inFlightCreates = yield* Ref.modify(createRef, (m) => { const e = Array.from(m.entries()); m.clear(); return [e, m] as const })
          for (const [, d] of inFlightCreates) yield* Deferred.fail(d, new Error("Sandbox destroyed during shutdown"))
          const rows = yield* dbAll().pipe(Effect.orElseSucceed(() => [] as any[]))
          log.info("destroying all sandboxes", { count: rows.length })
          for (const row of rows) {
            const sb = yield* reconnect(row).pipe(Effect.orElseSucceed(() => null))
            if (sb) {
              yield* destroySandbox(sb, row.session_id).pipe(
                Effect.catchCause((cause) => { log.error("failed to destroy sandbox during shutdown", { cause: Cause.pretty(cause) }); return Effect.void }),
              )
            } else {
              yield* dbDelete(row.session_id).pipe(Effect.catchCause(() => Effect.void))
            }
          }
          commandSemaphores.clear()
        }).pipe(Effect.withSpan("SandboxProvider.destroyAll"))

      const keepAlive: Interface["keepAlive"] = (sessionID) =>
        Effect.gen(function* () {
          yield* dbSetKeepAlive(sessionID, true)
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
          const sb = yield* getOrCreate(sessionID)

          // Semaphore 提前初始化，保护 createSession + runInSession 全流程
          // 防止并发请求同时发现 command_session_id=null 而重复创建 shell session
          let sem = commandSemaphores.get(sessionID)
          if (!sem) { sem = yield* Semaphore.make(1); commandSemaphores.set(sessionID, sem) }

          return yield* sem.withPermit(Effect.gen(function* () {
            const row = yield* dbGet(sessionID).pipe(Effect.orElseSucceed(() => null))

            // command_session_id 必须属于当前沙箱（sandbox ID 一致才复用）
            // 沙箱重建后 DB 里的 command_session_id 已被 createSandbox 置 null
            let cmdSessionID = (row?.id === sb.id ? row?.command_session_id : null) ?? null

            if (!cmdSessionID) {
              cmdSessionID = yield* Effect.tryPromise({
                try: () => sb.commands.createSession({ workingDirectory: "/workspace" }),
                catch: (e) => new Error(`Failed to create command session: ${String(e)}`),
              })
              yield* dbSetCommandSession(sessionID, cmdSessionID).pipe(Effect.catchCause(() => Effect.void))
            }

            return yield* Effect.tryPromise({
              try: () => sb.commands.runInSession(cmdSessionID!, command, options, handlers, signal),
              catch: (e) => new Error(`runInSession failed: ${String(e)}`),
            })
          }))
        }).pipe(Effect.withSpan("SandboxProvider.runInSession"))

      const register: Interface["register"] = (sessionID, sb) =>
        Effect.gen(function* () {
          commandSemaphores.delete(sessionID)
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
        getOrCreate, get, destroy, destroyAll, keepAlive, release, isKeepAlive,
        runInSession, register, getEndpoint,
        cleanupSessionVolume: (sessionID) => cleanupSessionVolume(sessionID, config, connectionConfig),
      })
    }),
  )

  export const defaultLayer = (Database.dialect === "pg" ? pgLayer : layer).pipe(
    Layer.provide(SandboxConfig.defaultLayer),
  )
}

export namespace NoopSandboxProvider {
  export const layer = Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed(null as unknown as Sandbox),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyAll: () => Effect.void,
      keepAlive: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      runInSession: () => Effect.fail(new Error("Sandbox is disabled")),
      register: () => Effect.void,
      getEndpoint: () => Effect.die(new Error("Sandbox is disabled")),
      cleanupSessionVolume: () => Effect.void,
    }),
  )
}
