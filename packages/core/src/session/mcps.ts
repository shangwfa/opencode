export * as SessionMcps from "./mcps.js"

import { and, eq, sql } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import { createHash } from "node:crypto"
import { Cause, Context, Effect, Exit, FiberSet, Layer, Scope } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Mcp } from "@opencode/schema/mcp"
import { SessionMcp } from "@opencode/schema/session-mcp"
import { Database } from "../database/database.js"
import { KeyedMutex } from "../effect/keyed-mutex.js"
import { McpClient } from "../mcp/client.js"
import { SandboxProvider } from "../sandbox/provider.js"
import { SandboxEndpoint } from "../sandbox/endpoint.js"
import { McpHttpBridge } from "./mcp-http-bridge.js"
import { McpInteractions } from "./mcp-interactions.js"
import { SandboxConfig } from "../sandbox/config.js"
import { Environment } from "../environment/index.js"
import type { Session } from "../session.js"
import { SessionMcpTable, SessionTable } from "./sql.js"
import { SessionResourceOwner } from "./resource-owner.js"

export type Info = SessionMcp.Info
export type Payload = SessionMcp.Payload

type Runtime = {
  readonly config: SessionMcp.Config
  readonly scope: Scope.Closeable
  readonly port?: number
  readonly sandboxID?: string | null
  readonly client: McpClient.Connection
  readonly tools: ReadonlyArray<McpClient.Tool>
}

type FailureBackoff = {
  readonly config: SessionMcp.Config
  readonly failures: number
  readonly until: number
}

export type Tool = McpClient.Tool & { readonly server: SessionMcp.Name; readonly codemode?: boolean }

export interface Interface {
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info>
  readonly remove: (session: Session.Info, name: SessionMcp.Name) => Effect.Effect<void>
  readonly clear: (session: Session.Info) => Effect.Effect<void>
  /** Close the owner's shared live clients before a Session sandbox is destroyed; child sessions release nothing. */
  readonly release: (session: Session.Info) => Effect.Effect<void>
  /** Connect enabled definitions and return their currently advertised MCP tools. */
  readonly tools: (session: Session.Info) => Effect.Effect<ReadonlyArray<Tool>>
  readonly call: (input: {
    readonly session: Session.Info
    readonly server: SessionMcp.Name
    readonly name: string
    readonly args: Record<string, unknown>
  }) => Effect.Effect<McpClient.CallToolResult, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionMcps") {}

const BASE_PORT = 9100
/** Bridge readiness polling cadence: exponential backoff capped at the V1-verified 2s ceiling. */
export const BRIDGE_RETRY_BASE_MS = 250
export const BRIDGE_RETRY_MAX_MS = 2_000
/** Default single-server readiness budget (~60s, matching V1's 30 × 2s window). */
export const BRIDGE_RETRY_BUDGET_MS = 60_000
/** Total budget one reconcile pass may spend connecting missing servers (V1 describeCodeMode gate). */
export const RECONCILE_BUDGET_MS = 30_000
/**
 * Failure backoff for servers whose connect failed. Without it, a broken definition that sorts
 * first consumes the whole reconcile budget on every select — starving later servers and adding
 * the full budget as latency to every request. One failure enters backoff; a config change
 * invalidates the entry so a fixed definition retries immediately. Exported for tests.
 */
export const CONNECT_BACKOFF_BASE_MS = 30_000
export const CONNECT_BACKOFF_MAX_MS = 300_000
export const connectBackoffMs = (failures: number) =>
  Math.min(CONNECT_BACKOFF_BASE_MS * 2 ** (failures - 1), CONNECT_BACKOFF_MAX_MS)
export const bridgeRetryDelay = (attempt: number) => Math.min(BRIDGE_RETRY_BASE_MS * 2 ** attempt, BRIDGE_RETRY_MAX_MS)
/** Close the single-quoted span, emit one literal quote, and reopen it. */
const QUOTE_ESCAPE = "'\\''"
const shellQuote = (value: string) => "'" + value.replaceAll("'", QUOTE_ESCAPE) + "'"
const pathFor = (name: string, port: number) => `/tmp/opencode-mcp/${name}-${port}`

/** Builds the sandbox-side bridge start command; exported for quoting regression tests. */
const bridgeFingerprint = (config: Mcp.LocalConfig, generation: string) => createHash("sha256").update(JSON.stringify([
  generation, config.command, Object.entries(config.environment ?? {}).sort(([a], [b]) => a.localeCompare(b)), McpHttpBridge.script,
])).digest("hex")

export function bridgeStartCommand(name: string, config: Mcp.LocalConfig, port: number, generation?: string): string {
  return McpHttpBridge.startCommand({
    base: pathFor(name, port),
    name,
    port,
    stdio: config.command.map(shellQuote).join(" "),
    environment: config.environment,
    ...(generation === undefined ? {} : { fingerprint: bridgeFingerprint(config, generation) }),
  })
}

/** Builds the sandbox-side bridge stop command; exported for quoting regression tests. */
export function bridgeStopCommand(name: string, port: number, fingerprint?: string): string {
  const base = pathFor(name, port)
  const stop = `if [ -f ${shellQuote(base + ".pid")} ]; then kill "$(cat ${shellQuote(base + ".pid")})" 2>/dev/null || true; fi; rm -f ${shellQuote(base + ".pid")} ${shellQuote(base + ".log")} ${shellQuote(base + ".meta")}`
  if (!fingerprint) return `mkdir -p /tmp/opencode-mcp; flock --close -x /tmp/opencode-mcp/.registry.lock -c ${shellQuote(stop)}`
  return `flock --close -x /tmp/opencode-mcp/.registry.lock -c ${shellQuote(`if [ "$(cat ${shellQuote(base + ".meta")} 2>/dev/null)" = ${shellQuote(fingerprint)} ]; then ${stop}; fi`)}`
}

export const canReplayCall = (error: Error) => error instanceof McpClient.SessionExpiredError && error.rejected === true

/**
 * Initialize bridge ownership once per physical generation and bridge revision.
 * The sandbox-side marker and flock, not a Pod's empty runtime cache, decide
 * whether existing daemons are stale. The parameterless form is a legacy helper.
 */
export function bridgeSweepCommand(generation?: string): string {
  const sweep = `for pidfile in /tmp/opencode-mcp/*.pid; do [ -f "$pidfile" ] && kill "$(cat "$pidfile")" 2>/dev/null; done; rm -f /tmp/opencode-mcp/*.pid; pkill -f ${shellQuote("mcp-http-bridg[e].*--stdio")} 2>/dev/null || true; pkill -f ${shellQuote("supergatewa[y].*--stdio")} 2>/dev/null || true`
  if (generation === undefined) return sweep
  const marker = createHash("sha256").update(generation).update(McpHttpBridge.script).digest("hex")
  return `mkdir -p /tmp/opencode-mcp; flock --close -x /tmp/opencode-mcp/.registry.lock -c ${shellQuote(`if [ "$(cat /tmp/opencode-mcp/.generation 2>/dev/null)" = ${shellQuote(marker)} ]; then exit 0; fi; ${sweep}; printf %s ${shellQuote(marker)} > /tmp/opencode-mcp/.generation`)}`
}

/**
 * MCP endpoint mode. The MCP-specific flag wins unless the global flag already
 * forces the gateway, matching the documented A/B/C deployment matrix:
 * A direct (`useServerProxy=false, mcpServerProxy=false`), B MCP-only gateway
 * (`false, true`), C full gateway (`true, *`). Exported for deterministic tests.
 */
export function mcpUseServerProxy(config: {
  readonly useServerProxy: boolean
  readonly mcpServerProxy: boolean
}): boolean {
  return config.useServerProxy || config.mcpServerProxy
}

function fromRow(row: typeof SessionMcpTable.$inferSelect): Info {
  return SessionMcp.Info.make({
    id: row.id,
    name: row.name,
    config: row.config,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const sandbox = yield* SandboxProvider.Service
    const sandboxConfig = SandboxConfig.load()
    const environment = yield* Environment.Service
    const interactions = yield* McpInteractions.Service
    const root = yield* Effect.scope
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    // Runtimes are keyed by resource owner, not by session: child sessions share the owner's
    // definitions AND connections, so one bridge serves the whole resource domain (one sandbox).
    // Per-session keys used to collide on BASE_PORT inside the shared sandbox.
    const runtimes = new Map<Session.ID, Map<SessionMcp.Name, Runtime>>()
    // Serializes reconcile per resource owner (parent and children share one key), closing
    // the gap where concurrent selects double-connected one server and pkilled each other.
    const locks = KeyedMutex.makeUnsafe<Session.ID>()
    // Per-owner connect-failure backoff, guarded by the same lock as runtimes. Config-keyed so
    // an upsert that fixes a broken definition retries immediately instead of waiting out the TTL.
    const backoffs = new Map<Session.ID, Map<SessionMcp.Name, FailureBackoff>>()
    // Local shortcut only; the sandbox generation marker arbitrates across Pods/restarts.
    const swept = new Set<Session.ID>()
    // stop() is idempotent: connection callbacks (onClose) fire synchronously during
    // Scope.close, and the eviction path must not re-run teardown for a stopped runtime.
    const stopped = new WeakSet<Runtime>()
    const storedByOwner = (ownerID: Session.ID) =>
      db
        .select()
        .from(SessionMcpTable)
        .where(eq(SessionMcpTable.session_id, ownerID))
        .all()
        .pipe(
          Effect.map((rows) => rows.map(fromRow).toSorted((a, b) => a.name.localeCompare(b.name))),
          Effect.orDie,
        )
    const stored = (sessionID: Session.ID) => SessionResourceOwner.id(db, sessionID).pipe(Effect.flatMap(storedByOwner))
    const localPorts = (ownerID: Session.ID) => db.transaction((tx) => Effect.gen(function* () {
      yield* tx.update(SessionTable).set({ time_updated: sql`${SessionTable.time_updated}` })
        .where(eq(SessionTable.id, ownerID)).run()
      const rows = yield* tx.select().from(SessionMcpTable).where(eq(SessionMcpTable.session_id, ownerID)).all()
      const used = new Set(rows.flatMap((row) => row.runtime_port === null ? [] : [row.runtime_port]))
      const ports = new Map<SessionMcp.Name, number>()
      for (const row of rows.toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (row.config.type !== "local" || row.config.disabled) continue
        let port = row.runtime_port ?? BASE_PORT
        if (row.runtime_port === null) {
          while (used.has(port)) port++
          yield* tx.update(SessionMcpTable).set({ runtime_port: port, time_updated: sql`${SessionMcpTable.time_updated}` })
            .where(eq(SessionMcpTable.id, row.id)).run()
          used.add(port)
        }
        ports.set(row.name, port)
      }
      return ports
    })).pipe(Effect.orDie)
    const stopStored = (session: Session.Info, rows: ReadonlyArray<typeof SessionMcpTable.$inferSelect>) => Effect.gen(function* () {
      if (!sandbox.enabled || !(yield* sandbox.sandboxId(session.id))) return
      for (const row of rows) {
        if (row.runtime_port === null) continue
        yield* sandbox.run({ sessionID: session.id, hostWorkdir: session.location.directory,
          command: bridgeStopCommand(row.name, row.runtime_port), timeoutMs: 10000 }).pipe(Effect.ignore)
      }
    })

    const stop = Effect.fnUntraced(function* (session: Session.Info, name: SessionMcp.Name, runtime: Runtime, stopDaemon = true) {
      if (stopped.has(runtime)) return
      stopped.add(runtime)
      yield* Scope.close(runtime.scope, Exit.void)
      if (!stopDaemon || runtime.port === undefined || !sandbox.enabled) return
      // A stale runtime must not stop a daemon in the replacement workspace.
      if (runtime.sandboxID !== (yield* sandbox.sandboxId(session.id))) return
      yield* sandbox
        .run({
          sessionID: session.id,
          hostWorkdir: session.location.directory,
           command: bridgeStopCommand(name, runtime.port, runtime.config.type === "local" && runtime.sandboxID
             ? bridgeFingerprint(runtime.config, runtime.sandboxID) : undefined),
          timeoutMs: 10_000,
        })
        .pipe(Effect.ignore)
    })

    // Drop a dead runtime from the owner's map so the next reconcile reconnects it. Runs from
    // connection callbacks (forked) and from the call retry path; the identity check keeps a
    // replacement runtime installed by a concurrent reconcile intact.
    const evict = Effect.fnUntraced(function* (
      session: Session.Info,
      ownerID: Session.ID,
      name: SessionMcp.Name,
      runtime: Runtime,
    ) {
           // Eviction closes only this Pod's client, never another Pod's shared daemon.
      yield* locks.withLock(ownerID)(
        Effect.gen(function* () {
          yield* stop(session, name, runtime, false)
          const current = runtimes.get(ownerID)
          if (current?.get(name) === runtime) {
            current.delete(name)
            if (current.size === 0) runtimes.delete(ownerID)
          }
        }),
      )
    })

    const connectLocal = Effect.fnUntraced(function* (
      session: Session.Info,
      name: SessionMcp.Name,
      config: Mcp.LocalConfig,
      port: number,
      budgetMs: number,
    ) {
      if (!sandbox.enabled) return yield* McpClient.connect(name, config, session.location.directory)
      // Materialize the bridge before launching it: the stock Vercel image has no
      // bridge tooling, and a snapshot restore keeps the workspace copy.
      const installed = yield* sandbox
        .fileRead(session.id, McpHttpBridge.path)
        .pipe(Effect.catch(() => Effect.succeed(null)))
      if (installed !== McpHttpBridge.script)
        yield* sandbox.fileWrite(session.id, McpHttpBridge.path, McpHttpBridge.script)
      const started = yield* sandbox.run({
        sessionID: session.id,
        hostWorkdir: session.location.directory,
        command: bridgeStartCommand(name, config, port, (yield* sandbox.sandboxId(session.id)) ?? undefined),
        timeoutMs: 10_000,
      })
      if (started.exitCode !== 0)
        return yield* Effect.fail(new Error(`Failed to start session MCP ${name}: ${started.output}`))
      let failure: Error | undefined
      const deadline = Date.now() + budgetMs
      for (let attempt = 0; Date.now() < deadline; attempt++) {
        // The MCP client runs in the SaaS server, exactly like the session preview proxy.
        // The MCP-specific gateway flag decides this endpoint so cross-network deployments
        // can keep every other channel direct (deployment modes A/B/C).
        const endpoint = yield* sandbox.endpoint(session.id, port, mcpUseServerProxy(sandboxConfig))
        if (endpoint._tag === "resolved") {
          const url = `${SandboxEndpoint.httpUrl(endpoint.endpoint.replace(/\/$/, ""))}/mcp`
          yield* Effect.logInfo("session MCP endpoint resolved", {
            sessionID: session.id,
            server: name,
            url,
            useServerProxy: mcpUseServerProxy(sandboxConfig),
          })
          const remote = Mcp.RemoteConfig.make({
            type: "remote",
            url,
            oauth: false,
            headers: endpoint.headers ? { ...endpoint.headers } : undefined,
            codemode: config.codemode,
            timeout: config.timeout,
          })
          const result = yield* McpClient.connect(
            name,
            remote,
            session.location.directory,
            undefined,
            interactions.elicitation,
            undefined,
            interactions.sampling,
          ).pipe(Effect.exit)
          if (Exit.isSuccess(result)) return result.value
          const cause = Cause.squash(result.cause)
          failure = cause instanceof Error ? cause : new Error(String(cause))
        }
        yield* Effect.sleep(`${bridgeRetryDelay(attempt)} millis`)
      }
      return yield* Effect.fail(failure ?? new Error(`Session MCP ${name} did not become reachable`))
    })

    const connect = Effect.fnUntraced(function* (
      session: Session.Info,
      ownerID: Session.ID,
      info: Info,
      port: number,
      budgetMs: number,
    ) {
      const scope = yield* Scope.fork(root)
      const result = yield* (
        info.config.type === "local"
          ? connectLocal(session, info.name, info.config, port, budgetMs)
          : McpClient.connect(
              info.name,
              info.config,
              session.location.directory,
              undefined,
              interactions.elicitation,
              undefined,
              interactions.sampling,
            )
      ).pipe(Effect.provideService(Environment.Service, environment), Scope.provide(scope), Effect.exit)
      if (result._tag === "Failure") {
        yield* Scope.close(scope, Exit.void)
        const cause = Cause.squash(result.cause)
        return yield* Effect.fail(
          new Error(
            `Failed to connect session MCP ${info.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
            {
              cause,
            },
          ),
        )
      }
      const tools = yield* result.value.tools().pipe(
        Scope.provide(scope),
        Effect.mapError(
          (cause) =>
            new Error(
              `Failed to list session MCP tools for ${info.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
              { cause },
            ),
        ),
      )
      const runtime = {
        config: info.config,
        scope,
        ...(info.config.type === "local" && sandbox.enabled ? { port, sandboxID: yield* sandbox.sandboxId(session.id) } : {}),
        client: result.value,
        tools,
      } satisfies Runtime
      // Half-open connections must not linger in the map until the next config change: the
      // client module reserves exactly these callbacks for this, and the global MCP service
      // watches the same signals. onClose also fires during a normal stop teardown; the
      // idempotent stop() inside evict makes that a no-op. Forked, because the callbacks run
      // synchronously inside Scope.close while this owner's reconcile lock may be held.
      runtime.client.onSessionExpired(() => fork(evict(session, ownerID, info.name, runtime)))
      runtime.client.onClose(() => fork(evict(session, ownerID, info.name, runtime)))
      return runtime
    })

    const reconcile = Effect.fnUntraced(function* (session: Session.Info) {
      const ownerID = yield* SessionResourceOwner.id(db, session.id)
      return yield* locks.withLock(ownerID)(
        Effect.gen(function* () {
          const infos = yield* storedByOwner(ownerID)
          const desired = new Map(infos.filter((info) => !info.config.disabled).map((info) => [info.name, info]))
          const current = runtimes.get(ownerID) ?? new Map<SessionMcp.Name, Runtime>()
          const hasLocal = desired.values().some((info) => info.config.type === "local")
          const sandboxID = sandbox.enabled ? hasLocal ? yield* sandbox.boot(session.id).pipe(
            Effect.tapError((error) => Effect.logWarning("session MCP sandbox is unavailable", { sessionID: session.id, error: error.message })),
            Effect.catch(() => Effect.succeed(null)),
          ) : yield* sandbox.sandboxId(session.id) : null
          if (sandbox.enabled && hasLocal && !sandboxID) return new Map<SessionMcp.Name, Runtime>()
          const ports = sandbox.enabled && hasLocal ? yield* localPorts(ownerID) : new Map<SessionMcp.Name, number>()
          if (sandboxID) {
            const inactive = yield* db.select().from(SessionMcpTable).where(eq(SessionMcpTable.session_id, ownerID)).all().pipe(Effect.orDie)
            yield* stopStored(session, inactive.filter((row) => row.config.disabled || row.config.type !== "local"))
          }
          for (const [name, runtime] of current) {
            const info = desired.get(name)
            const stale = runtime.port !== undefined && runtime.sandboxID !== sandboxID
            if (!stale && info && isDeepStrictEqual(info.config, runtime.config)) continue
            yield* stop(session, name, runtime)
            current.delete(name)
            if (stale) { swept.delete(ownerID); backoffs.delete(ownerID) }
          }
          const usedPorts = new Set(
            Array.from(current.values(), (runtime) => runtime.port).filter(
              (port): port is number => port !== undefined,
            ),
          )
          // Reusing a healthy daemon after a Pod restart preserves in-flight calls on peers.
          // Only a changed physical generation or bridge revision authorizes a global sweep.
          if (
            !swept.has(ownerID) &&
            sandbox.enabled &&
            usedPorts.size === 0 &&
            desired.values().some((info) => info.config.type === "local")
          ) {
            yield* sandbox
              .run({
                sessionID: session.id,
                hostWorkdir: session.location.directory,
                command: bridgeSweepCommand(sandboxID ?? undefined),
                timeoutMs: 10_000,
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("session MCP stale sweep failed", { sessionID: session.id, cause: String(cause) }),
                ),
              )
            swept.add(ownerID)
          }
          // Soft gate (V1 describeCodeMode semantics): one reconcile pass never spends more than
          // RECONCILE_BUDGET_MS connecting missing servers. Servers deferred here simply miss this
          // pass; the next tools()/call() retries them with a fresh budget. Checking before each
          // connect (instead of hard-interrupting) keeps already-forked scopes from leaking.
          const deadline = Date.now() + RECONCILE_BUDGET_MS
          const backed = backoffs.get(ownerID) ?? new Map<SessionMcp.Name, FailureBackoff>()
          for (const info of desired.values()) {
            if (current.has(info.name)) continue
            // Failure backoff: skip a server whose connect failed until its backoff expires, so
            // it cannot re-consume the whole budget (and starve later servers) on every select.
            // A config change invalidates the entry — a fixed definition retries immediately.
            const record = backed.get(info.name)
            if (record && isDeepStrictEqual(record.config, info.config) && Date.now() < record.until) continue
            const remaining = deadline - Date.now()
            if (remaining <= 0) {
              yield* Effect.logWarning("session MCP reconcile budget exhausted; deferring server", {
                sessionID: session.id,
                server: info.name,
              })
              continue
            }
            const port = ports.get(info.name) ?? BASE_PORT
            const outcome = yield* connect(
              session,
              ownerID,
              info,
              port,
              Math.min(remaining, BRIDGE_RETRY_BUDGET_MS),
            ).pipe(Effect.exit)
            if (Exit.isSuccess(outcome)) {
              current.set(info.name, outcome.value)
              if (outcome.value.port !== undefined) usedPorts.add(outcome.value.port)
              backed.delete(info.name)
            } else {
              const cause = Cause.squash(outcome.cause)
              const prior = record && isDeepStrictEqual(record.config, info.config) ? record.failures : 0
              const delay = connectBackoffMs(prior + 1)
              backed.set(info.name, { config: info.config, failures: prior + 1, until: Date.now() + delay })
              yield* Effect.logWarning("failed to connect session MCP; backing off", {
                sessionID: session.id,
                server: info.name,
                error: cause instanceof Error ? cause.message : String(cause),
                failures: prior + 1,
                retryInMs: delay,
              })
            }
          }
          if (current.size === 0) runtimes.delete(ownerID)
          else runtimes.set(ownerID, current)
          if (backed.size === 0) backoffs.delete(ownerID)
          else backoffs.set(ownerID, backed)
          return current
        }),
      )
    })

    return Service.of({
      list: stored,
      create: (requestedSessionID, input) =>
        Effect.gen(function* () {
          const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
          const now = Date.now()
          yield* db
            .insert(SessionMcpTable)
            .values({
              id: SessionMcp.ID.create(),
              session_id: sessionID,
              name: input.name,
              config: input.config,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: [SessionMcpTable.session_id, SessionMcpTable.name],
              set: { config: input.config, time_updated: sql`max(${now}, ${SessionMcpTable.time_updated} + 1)` },
            })
            .run()
            .pipe(Effect.orDie)
          const row = yield* db
            .select()
            .from(SessionMcpTable)
            .where(and(eq(SessionMcpTable.session_id, sessionID), eq(SessionMcpTable.name, input.name)))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.die(new Error(`Session MCP upsert disappeared: ${input.name}`))
          return fromRow(row)
        }),
      remove: (session, name) =>
        Effect.gen(function* () {
          const ownerID = yield* SessionResourceOwner.id(db, session.id)
          const rows = yield* db.select().from(SessionMcpTable).where(and(eq(SessionMcpTable.session_id, ownerID), eq(SessionMcpTable.name, name))).all().pipe(Effect.orDie)
          // Removing a definition stops the owner's shared runtime inside the reconcile lock,
          // so a concurrent reconcile cannot resurrect it between the stop and the row delete.
          yield* locks.withLock(ownerID)(
            Effect.gen(function* () {
              const current = runtimes.get(ownerID)
              const runtime = current?.get(name)
              if (runtime) {
                yield* stop(session, name, runtime)
                current?.delete(name)
              }
              // A removed definition must not keep a backoff entry either.
              backoffs.get(ownerID)?.delete(name)
            }),
          )
          yield* stopStored(session, rows)
          yield* db
            .delete(SessionMcpTable)
            .where(and(eq(SessionMcpTable.session_id, ownerID), eq(SessionMcpTable.name, name)))
            .run()
            .pipe(Effect.orDie)
        }),
      clear: (session) =>
        Effect.gen(function* () {
          const ownerID = yield* SessionResourceOwner.id(db, session.id)
          const rows = yield* db.select().from(SessionMcpTable).where(eq(SessionMcpTable.session_id, ownerID)).all().pipe(Effect.orDie)
          yield* locks.withLock(ownerID)(
            Effect.gen(function* () {
              const current = runtimes.get(ownerID)
              if (current) {
                yield* Effect.forEach(current, ([name, runtime]) => stop(session, name, runtime), { discard: true })
                runtimes.delete(ownerID)
              }
              backoffs.delete(ownerID)
            }),
          )
          yield* stopStored(session, rows)
          yield* db.delete(SessionMcpTable).where(eq(SessionMcpTable.session_id, ownerID)).run().pipe(Effect.orDie)
        }),
      release: (session) =>
        Effect.gen(function* () {
          const ownerID = yield* SessionResourceOwner.id(db, session.id)
          // Runtimes belong to the resource owner; a child session's teardown must not drop
          // connections its siblings and parent still use. Children release nothing — the
          // owner's own teardown (which runs last) closes the shared set before the sandbox dies.
          if (ownerID !== session.id) return
          yield* locks.withLock(ownerID)(
            Effect.gen(function* () {
              const current = runtimes.get(ownerID)
              if (!current) return
              yield* Effect.forEach(current, ([name, runtime]) => stop(session, name, runtime), { discard: true })
              runtimes.delete(ownerID)
            }),
          )
        }),
      tools: (session) =>
        reconcile(session).pipe(
          Effect.map((entries) =>
            Array.from(entries, ([server, runtime]) =>
              // Mirror the global MCP service's toTool: codemode lives on the config, not on
              // McpClient.Tool, so it must be carried onto each tool for the registry's
              // direct-vs-catalog split (options.codemode === false) to see it.
              runtime.tools.map((tool) => ({
                ...tool,
                server,
                ...(runtime.config.codemode === undefined ? {} : { codemode: runtime.config.codemode }),
              })),
            ).flat(),
          ),
        ),
      call: (input) => {
        const ownerID = SessionResourceOwner.id(db, input.session.id)
        // Only an explicit protocol session rejection proves the call was not
        // accepted. A reset/5xx after dispatch may already have side effects.
        const ready = (runtime: Runtime) => runtime.port === undefined ? Effect.succeed(true) : sandbox.run({
          sessionID: input.session.id, hostWorkdir: input.session.location.directory,
          command: McpHttpBridge.healthCommand(pathFor(input.server, runtime.port), runtime.port), timeoutMs: 5000,
        }).pipe(Effect.flatMap((result) => result.exitCode === 0 && !result.timedOut ? Effect.succeed(true)
          : result.exitCode === 1 && !result.timedOut ? Effect.succeed(false)
          : Effect.fail(new Error(`Session MCP health is unknown; tool was not dispatched: ${input.server}`))))
        const attempt = (retry: boolean): Effect.Effect<McpClient.CallToolResult, Error> =>
          Effect.gen(function* () {
            const entries = yield* reconcile(input.session)
            let runtime = entries.get(input.server)
            if (!runtime) return yield* Effect.fail(new Error(`Session MCP server is not connected: ${input.server}`))
            if (!(yield* ready(runtime))) {
              const dead = runtime
              yield* ownerID.pipe(Effect.flatMap((owner) => evict(input.session, owner, input.server, dead)))
              runtime = (yield* reconcile(input.session)).get(input.server)
              if (!runtime || !(yield* ready(runtime)))
                return yield* Effect.fail(new Error(`Session MCP did not recover before dispatch: ${input.server}`))
            }
            const connected = runtime
            return yield* connected.client
              .callTool({ name: input.name, args: input.args, sessionID: input.session.id })
              .pipe(
                Effect.catchIf(
                  (error) => error instanceof Error,
                  (error) =>
                    ownerID.pipe(
                      Effect.flatMap((owner) =>
                        evict(input.session, owner, input.server, connected).pipe(
                          Effect.tap(() =>
                            Effect.logWarning(
                                retry && canReplayCall(error)
                                ? "session MCP connection failed; evicted and retrying once"
                                : "session MCP call failed; evicted without replay",
                              {
                                sessionID: input.session.id,
                                server: input.server,
                                error: error.message,
                              },
                            ),
                          ),
                           Effect.andThen(retry && canReplayCall(error) ? attempt(false) : Effect.fail(error)),
                        ),
                      ),
                    ),
                ),
              )
          })
        return attempt(true)
      },
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, SandboxProvider.node, Environment.node, McpInteractions.node],
})
