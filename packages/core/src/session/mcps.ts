export * as SessionMcps from "./mcps.js"

import { and, eq, sql } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Mcp } from "@opencode/schema/mcp"
import { SessionMcp } from "@opencode/schema/session-mcp"
import { Database } from "../database/database.js"
import { McpClient } from "../mcp/client.js"
import { SandboxProvider } from "../sandbox/provider.js"
import { SandboxConfig } from "../sandbox/config.js"
import { Environment } from "../environment/index.js"
import type { Session } from "../session.js"
import { SessionMcpTable } from "./sql.js"
import { SessionResourceOwner } from "./resource-owner.js"

export type Info = SessionMcp.Info
export type Payload = SessionMcp.Payload

type Runtime = {
  readonly config: SessionMcp.Config
  readonly scope: Scope.Closeable
  readonly port?: number
  readonly client: McpClient.Connection
  readonly tools: ReadonlyArray<McpClient.Tool>
}

export type Tool = McpClient.Tool & { readonly server: SessionMcp.Name; readonly codemode?: boolean }

export interface Interface {
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info>
  readonly remove: (session: Session.Info, name: SessionMcp.Name) => Effect.Effect<void>
  readonly clear: (session: Session.Info) => Effect.Effect<void>
  /** Close all live clients before a Session sandbox is destroyed. */
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
/** Close the single-quoted span, emit one literal quote, and reopen it. */
const QUOTE_ESCAPE = "'\\''"
const shellQuote = (value: string) => "'" + value.replaceAll("'", QUOTE_ESCAPE) + "'"
const pathFor = (name: string, port: number) => `/tmp/opencode-mcp/${name}-${port}`

/** Builds the sandbox-side bridge start command; exported for quoting regression tests. */
export function bridgeStartCommand(name: string, config: Mcp.LocalConfig, port: number): string {
  const base = pathFor(name, port)
  const stdio = config.command.map(shellQuote).join(" ")
  const environment = Object.entries(config.environment ?? {})
    .map(([key, value]) => `${shellQuote(key)}=${shellQuote(value)}`)
    .join(" ")
  // supergateway runs the stdio command through its own shell and inherits this
  // process's environment, so no extra `sh -lc` quoting layer is needed.
  const bridge = `${environment ? `env ${environment} ` : ""}supergateway --stdio ${shellQuote(stdio)} --outputTransport streamableHttp --stateful --port ${port} --logLevel none`
  return `mkdir -p /tmp/opencode-mcp; nohup ${bridge} > ${shellQuote(base + ".log")} 2>&1 & echo $! > ${shellQuote(base + ".pid")}`
}

/** Builds the sandbox-side bridge stop command; exported for quoting regression tests. */
export function bridgeStopCommand(name: string, port: number): string {
  const base = pathFor(name, port)
  return `if [ -f ${shellQuote(base + ".pid")} ]; then kill "$(cat ${shellQuote(base + ".pid")})" 2>/dev/null || true; fi; rm -f ${shellQuote(base + ".pid")} ${shellQuote(base + ".log")}`
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
    const root = yield* Effect.scope
    const runtimes = new Map<Session.ID, Map<SessionMcp.Name, Runtime>>()
    const stored = (sessionID: Session.ID) =>
      SessionResourceOwner.id(db, sessionID).pipe(
        Effect.flatMap((ownerID) =>
          db
            .select()
            .from(SessionMcpTable)
            .where(eq(SessionMcpTable.session_id, ownerID))
            .all()
            .pipe(
              Effect.map((rows) => rows.map(fromRow).toSorted((a, b) => a.name.localeCompare(b.name))),
              Effect.orDie,
            ),
        ),
      )

    const stop = Effect.fnUntraced(function* (session: Session.Info, name: SessionMcp.Name, runtime: Runtime) {
      yield* Scope.close(runtime.scope, Exit.void)
      if (runtime.port === undefined || !sandbox.enabled) return
      yield* sandbox
        .run({
          sessionID: session.id,
          hostWorkdir: session.location.directory,
          command: bridgeStopCommand(name, runtime.port),
          timeoutMs: 10_000,
        })
        .pipe(Effect.ignore)
    })

    const connectLocal = Effect.fnUntraced(function* (
      session: Session.Info,
      name: SessionMcp.Name,
      config: Mcp.LocalConfig,
      port: number,
    ) {
      if (!sandbox.enabled) return yield* McpClient.connect(name, config, session.location.directory)
      const started = yield* sandbox.run({
        sessionID: session.id,
        hostWorkdir: session.location.directory,
        command: bridgeStartCommand(name, config, port),
        timeoutMs: 10_000,
      })
      if (started.exitCode !== 0)
        return yield* Effect.fail(new Error(`Failed to start session MCP ${name}: ${started.output}`))
      let failure: Error | undefined
      for (let attempt = 0; attempt < 20; attempt++) {
        // The MCP client runs in the SaaS server, exactly like the session preview proxy.
        // The MCP-specific gateway flag decides this endpoint so cross-network deployments
        // can keep every other channel direct (deployment modes A/B/C).
        const endpoint = yield* sandbox.endpoint(session.id, port, mcpUseServerProxy(sandboxConfig))
        if (endpoint._tag === "resolved") {
          const url = `http://${endpoint.endpoint.replace(/\/$/, "")}/mcp`
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
            codemode: config.codemode,
            timeout: config.timeout,
          })
          const result = yield* McpClient.connect(name, remote, session.location.directory).pipe(Effect.exit)
          if (Exit.isSuccess(result)) return result.value
          const cause = Cause.squash(result.cause)
          failure = cause instanceof Error ? cause : new Error(String(cause))
        }
        yield* Effect.sleep("250 millis")
      }
      return yield* Effect.fail(failure ?? new Error(`Session MCP ${name} did not become reachable`))
    })

    const connect = Effect.fnUntraced(function* (session: Session.Info, info: Info, port: number) {
      const scope = yield* Scope.fork(root)
      const result = yield* (
        info.config.type === "local"
          ? connectLocal(session, info.name, info.config, port)
          : McpClient.connect(info.name, info.config, session.location.directory)
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
      return {
        config: info.config,
        scope,
        ...(info.config.type === "local" && sandbox.enabled ? { port } : {}),
        client: result.value,
        tools,
      } satisfies Runtime
    })

    const reconcile = Effect.fnUntraced(function* (session: Session.Info) {
      const infos = yield* stored(session.id)
      const desired = new Map(infos.filter((info) => !info.config.disabled).map((info) => [info.name, info]))
      const current = runtimes.get(session.id) ?? new Map<SessionMcp.Name, Runtime>()
      for (const [name, runtime] of current) {
        const info = desired.get(name)
        if (info && isDeepStrictEqual(info.config, runtime.config)) continue
        yield* stop(session, name, runtime)
        current.delete(name)
      }
      const usedPorts = new Set(
        Array.from(current.values(), (runtime) => runtime.port).filter((port): port is number => port !== undefined),
      )
      for (const info of desired.values()) {
        if (current.has(info.name)) continue
        let port = BASE_PORT
        while (usedPorts.has(port)) port += 1
        const runtime = yield* connect(session, info, port).pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to connect session MCP", {
              sessionID: session.id,
              server: info.name,
              error: error instanceof Error ? error.message : String(error),
            }).pipe(Effect.as(undefined)),
          ),
        )
        if (runtime) {
          current.set(info.name, runtime)
          if (runtime.port !== undefined) usedPorts.add(runtime.port)
        }
      }
      if (current.size === 0) runtimes.delete(session.id)
      else runtimes.set(session.id, current)
      return current
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
          const current = runtimes.get(session.id)
          const runtime = current?.get(name)
          if (runtime) {
            yield* stop(session, name, runtime)
            current?.delete(name)
          }
          yield* db
            .delete(SessionMcpTable)
            .where(and(eq(SessionMcpTable.session_id, ownerID), eq(SessionMcpTable.name, name)))
            .run()
            .pipe(Effect.orDie)
        }),
      clear: (session) =>
        Effect.gen(function* () {
          const ownerID = yield* SessionResourceOwner.id(db, session.id)
          const current = runtimes.get(session.id)
          if (current) {
            yield* Effect.forEach(current, ([name, runtime]) => stop(session, name, runtime), { discard: true })
            runtimes.delete(session.id)
          }
          yield* db.delete(SessionMcpTable).where(eq(SessionMcpTable.session_id, ownerID)).run().pipe(Effect.orDie)
        }),
      release: (session) =>
        Effect.gen(function* () {
          const current = runtimes.get(session.id)
          if (!current) return
          yield* Effect.forEach(current, ([name, runtime]) => stop(session, name, runtime), { discard: true })
          runtimes.delete(session.id)
        }),
      tools: (session) =>
        reconcile(session).pipe(
          Effect.map((entries) =>
            Array.from(entries, ([server, runtime]) => runtime.tools.map((tool) => ({ ...tool, server }))).flat(),
          ),
        ),
      call: (input) =>
        Effect.gen(function* () {
          const entries = yield* reconcile(input.session)
          const runtime = entries.get(input.server)
          if (!runtime) return yield* Effect.fail(new Error(`Session MCP server is not connected: ${input.server}`))
          return yield* runtime.client.callTool({ name: input.name, args: input.args, sessionID: input.session.id })
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, SandboxProvider.node, Environment.node],
})
