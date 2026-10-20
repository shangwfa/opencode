export * as AppMcp from "./app-mcp.js"

import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { ConnectorMcp } from "@opencode/schema/connector-mcp"
import { Connector } from "./connector.js"
import { ConnectorEngine, EngineError } from "./engine.js"
import { selectAppMcpTools, type AppMcpToolLimits } from "./app-mcp-tools.js"
import { handleAppMcpRequest } from "./app-mcp-transport.js"

export interface Row {
  readonly id: string
  readonly session_id: string
  readonly service: string
  readonly connection_id: string | null
  readonly name: string
  readonly status: string
  readonly revision: number
  readonly tools: string
  readonly token_hash: string
  readonly token_prefix: string
  readonly time_created: number
  readonly time_updated: number
}
export interface StoreInterface {
  readonly get: (id: string) => Effect.Effect<Row | undefined>
  readonly list: (owner: string) => Effect.Effect<readonly Row[]>
  /** Lock owner and check quota in the same transaction. */
  readonly insert: (row: Row, maxDeployments: number) => Effect.Effect<boolean>
  /** Atomic revision CAS. Never mutate binding or owner. */
  readonly replace: (row: Row, expectedRevision: number) => Effect.Effect<boolean>
}
export class Store extends Context.Service<Store, StoreInterface>()("@opencode/ConnectorMcpStore") {}
export class AppMcpError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message) }
}
type Failure = AppMcpError | EngineError
export interface Interface {
  readonly list: (sessionId: string) => Effect.Effect<readonly ConnectorMcp.Info[], Failure>
  readonly create: (sessionId: string, input: ConnectorMcp.Create) => Effect.Effect<typeof ConnectorMcp.Issued.Type, Failure>
  readonly update: (sessionId: string, id: string, input: ConnectorMcp.Update) => Effect.Effect<ConnectorMcp.Info, Failure>
  readonly rotate: (sessionId: string, id: string, revision: number) => Effect.Effect<typeof ConnectorMcp.Issued.Type, Failure>
  readonly remove: (sessionId: string, id: string) => Effect.Effect<void, Failure>
  readonly handle: (id: string, request: Request) => Effect.Effect<Response, Failure>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/ConnectorAppMcp") {}
export interface Options extends AppMcpToolLimits { readonly maxDeployments: number }
const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const issue = () => {
  const token = `ocm_${randomBytes(32).toString("base64url")}`
  return { token, token_hash: hash(token), token_prefix: token.slice(0, 12) }
}
const selections = (row: Row) => Effect.try({
  try: () => Schema.decodeUnknownSync(ConnectorMcp.Selections)(JSON.parse(row.tools)),
  catch: () => new AppMcpError("invalid_manifest", "Stored MCP tool manifest is invalid.", 503),
})
const info = (row: Row) => selections(row).pipe(Effect.map((tools) => ({
  id: row.id, name: row.name, service: row.service, connectionId: row.connection_id, status: row.status,
  revision: row.revision, tools, tokenPrefix: row.token_prefix, timeCreated: row.time_created, timeUpdated: row.time_updated,
})))

export const layer = (options: Options) => Layer.effect(Service, Effect.gen(function* () {
  const store = yield* Store
  const connections = yield* Connector.Store
  const engine = yield* ConnectorEngine.Service
  const configured = () => Effect.try({
    try: () => {
      if (Object.values(options).some((value) => !Number.isSafeInteger(value) || value <= 0)) throw new Error()
    },
    catch: () => new AppMcpError("mcp_limits_missing", "Application MCP limits must be configured before use.", 503),
  })
  const owned = (sessionId: string, id: string) => Effect.gen(function* () {
    const owner = yield* connections.resolveOwner(sessionId)
    const row = yield* store.get(id)
    if (!row || row.session_id !== owner || row.status === "deleted")
      return yield* Effect.fail(new AppMcpError("not_found", "MCP deployment was not found.", 404))
    return row
  })
  const target = (row: Pick<Row, "session_id" | "connection_id" | "service">) => Effect.gen(function* () {
    if (row.connection_id === null) return undefined
    const rows = yield* connections.listBySession(row.session_id)
    const connection = rows.find((item) => item.id === row.connection_id && item.service === row.service && item.status === "active")
    if (!connection || !connection.engine_connection_id.trim())
      return yield* Effect.fail(new AppMcpError("connection_unavailable", "The bound connector account is unavailable.", 409))
    const detail = yield* engine.getConnection(connection.engine_connection_id)
    if (detail.status !== "active" || detail.service !== row.service || detail.id !== connection.engine_connection_id)
      return yield* Effect.fail(new AppMcpError("connection_unavailable", "The bound connector account requires authorization.", 409))
    return connection.engine_connection_id
  })
  const toolsFor = (service: string, ids: readonly string[], noAuth: boolean) => Effect.gen(function* () {
    yield* configured()
    const actions = yield* engine.actionsForService(service)
    const tools = yield* Effect.try({
      try: () => selectAppMcpTools(service, ids, actions, options),
      catch: (error) => new AppMcpError("invalid_tools", error instanceof Error ? error.message : "Invalid MCP tools.", 400),
    })
    if (noAuth && tools.some((tool) => !actions.find((action) => action.id === tool.actionId)?.execution.noAuthRunnable))
      return yield* Effect.fail(new AppMcpError("connection_required", "Selected actions require an authorized connector account.", 400))
    return tools
  })
  const save = (row: Row, expectedRevision: number) => Effect.gen(function* () {
    if (!(yield* store.replace(row, expectedRevision)))
      return yield* Effect.fail(new AppMcpError("revision_conflict", "MCP configuration changed. Refresh before saving.", 409))
    return yield* info(row)
  })
  const checkName = (name: string) => Effect.try({
    try: () => { if (!name.trim() || name.trim().length > 100) throw new Error(); return name.trim() },
    catch: () => new AppMcpError("invalid_name", "MCP name must contain 1 to 100 characters.", 400),
  })
  const authenticate = (id: string, request: Request) => Effect.gen(function* () {
    const authorization = request.headers.get("authorization") ?? ""
    const token = /^Bearer (ocm_[A-Za-z0-9_-]{43})$/i.exec(authorization)?.[1]
    const row = yield* store.get(id)
    const supplied = Buffer.from(hash(token ?? ""))
    const expected = Buffer.from(row?.token_hash ?? "")
    if (!token || !row || row.status !== "active" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return yield* Effect.fail(new AppMcpError("unauthorized", "MCP credentials are invalid or inactive.", 401))
    return row
  })
  return Service.of({
    list: (sessionId) => Effect.gen(function* () {
      const owner = yield* connections.resolveOwner(sessionId)
      return yield* Effect.forEach((yield* store.list(owner)).filter((row) => row.status !== "deleted"), info)
    }),
    create: (sessionId, input) => Effect.gen(function* () {
      yield* configured()
      const name = yield* checkName(input.name)
      const owner = yield* connections.resolveOwner(sessionId)
      const binding = { session_id: owner, service: input.service, connection_id: input.connectionId ?? null }
      yield* target(binding)
      const tools = yield* toolsFor(input.service, input.actionIds, binding.connection_id === null)
      const issued = issue()
      const now = Date.now()
      const row: Row = { ...binding, id: `cmcp_${randomUUID().replaceAll("-", "")}`, name, status: "active", revision: 1,
        tools: JSON.stringify(tools.map(({ actionId, name, contractHash }) => ({ actionId, name, contractHash }))),
        token_hash: issued.token_hash, token_prefix: issued.token_prefix, time_created: now, time_updated: now }
      if (!(yield* store.insert(row, options.maxDeployments)))
        return yield* Effect.fail(new AppMcpError("deployment_quota", "MCP deployment quota exceeded.", 409))
      return { deployment: yield* info(row), token: issued.token }
    }),
    update: (sessionId, id, input) => Effect.gen(function* () {
      const row = yield* owned(sessionId, id)
      const old = yield* selections(row)
      const next = input.actionIds ? yield* toolsFor(row.service, input.actionIds, row.connection_id === null) : undefined
      if (next && !input.confirmContracts && next.some((tool) => {
        const previous = old.find((item) => item.actionId === tool.actionId)
        return previous && previous.contractHash !== tool.contractHash
      })) return yield* Effect.fail(new AppMcpError("contract_confirmation", "Confirm the changed action contracts before saving.", 409))
      return yield* save({ ...row, name: input.name === undefined ? row.name : yield* checkName(input.name),
        status: input.status ?? row.status, revision: row.revision + 1, time_updated: Date.now(),
        tools: next ? JSON.stringify(next.map(({ actionId, name, contractHash }) => ({ actionId, name, contractHash }))) : row.tools }, input.revision)
    }),
    rotate: (sessionId, id, revision) => Effect.gen(function* () {
      const row = yield* owned(sessionId, id)
      const issued = issue()
      const deployment = yield* save({ ...row, token_hash: issued.token_hash, token_prefix: issued.token_prefix,
        revision: row.revision + 1, time_updated: Date.now() }, revision)
      return { deployment, token: issued.token }
    }),
    remove: (sessionId, id) => Effect.gen(function* () {
      const owner = yield* connections.resolveOwner(sessionId)
      const row = yield* store.get(id)
      if (!row || row.session_id !== owner || row.status === "deleted") return
      yield* save({ ...row, status: "deleted", token_hash: "", revision: row.revision + 1, time_updated: Date.now() }, row.revision)
    }),
    handle: (id, request) => Effect.gen(function* () {
      const row = yield* authenticate(id, request)
      yield* target(row)
      const selected = yield* selections(row)
      const actions = yield* engine.actionsForService(row.service)
      const existing = new Set(actions.map((action) => action.id))
      const eligible = selected.filter((item) => existing.has(item.actionId))
      const current = eligible.length ? yield* toolsFor(row.service, eligible.map((item) => item.actionId), row.connection_id === null) : []
      const available = current.filter((tool) => selected.some((item) => item.actionId === tool.actionId && item.name === tool.name && item.contractHash === tool.contractHash))
      return yield* Effect.tryPromise({
        try: () => handleAppMcpRequest(request, { name: row.name, tools: available, execute: async (tool, input, signal) => {
          const admission = Effect.gen(function* () {
            const latest = yield* authenticate(id, request)
            const allowed = yield* selections(latest)
            if (!allowed.some((item) => item.actionId === tool.actionId && item.name === tool.name && item.contractHash === tool.contractHash))
              return { ok: false, error: { code: "tool_not_allowed", message: "This MCP tool is no longer allowed." } }
            const latestTools = yield* toolsFor(latest.service, [tool.actionId], latest.connection_id === null)
            if (!latestTools.some((item) => item.contractHash === tool.contractHash))
              return { ok: false, error: { code: "contract_changed", message: "This action contract requires confirmation." } }
            const connectionId = yield* target(latest)
            const result = yield* engine.executeScopedAction({ service: latest.service, actionId: tool.actionId, connectionId,
              noAuth: latest.connection_id === null, input, signal })
            if (!result) return { ok: false, error: { code: "unknown_action", message: "The selected action is unavailable." } }
            return result.result.ok ? { ok: true, data: result.result.output } : { ok: false, error: result.result.error }
          })
          return Effect.runPromise(admission)
        } }),
        catch: () => new AppMcpError("transport_failed", "Application MCP transport failed.", 502),
      })
    }),
  })
}))
