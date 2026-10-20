import { describe, expect, it } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import { ConnectorConnection } from "@opencode/schema/connector-connection"
import { AppMcp } from "../src/adapter/app-mcp.js"
import { Connector } from "../src/adapter/connector.js"
import { ConnectorEngine } from "../src/adapter/engine.js"
import type { RuntimeActionDefinition } from "../src/engine/catalog-store.js"

const action: RuntimeActionDefinition = {
  id: "example.echo", service: "example", name: "echo", description: "Echo", operationType: "read",
  requiredScopes: [], providerPermissions: [], inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
  outputSchema: { type: "object" },
  execution: { locallyExecutable: true, catalogOnly: false, requiredAuthTypes: ["api_key"], noAuthRunnable: false, needsCredential: true },
}
const connectionId = Schema.decodeUnknownSync(ConnectorConnection.ID)("ccon_test")
const limits = { maxDeployments: 2, maxTools: 10, maxToolBytes: 10000, maxTotalBytes: 20000 }
async function payload(response: Response): Promise<unknown> {
  const text = await response.text()
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const message = text.split("\n").filter((line) => line.startsWith("data:")).at(-1)
    if (!message) throw new Error("Missing MCP event")
    return JSON.parse(message.slice(5).trim())
  }
  return JSON.parse(text)
}

function fixture() {
  const rows = new Map<string, AppMcp.Row>()
  let catalog = [action]
  let connectionAvailable = true
  const executed: string[] = []
  const store: AppMcp.StoreInterface = {
    get: (id) => Effect.sync(() => rows.get(id)),
    list: (owner) => Effect.sync(() => [...rows.values()].filter((row) => row.session_id === owner)),
    insert: (row, max) => Effect.sync(() => {
      if ([...rows.values()].filter((item) => item.session_id === row.session_id && item.status !== "deleted").length >= max) return false
      rows.set(row.id, row); return true
    }),
    replace: (row, revision) => Effect.sync(() => {
      const old = rows.get(row.id)
      if (!old || old.session_id !== row.session_id || old.revision !== revision || old.status === "deleted") return false
      rows.set(row.id, row); return true
    }),
  }
  const connections: Connector.StoreInterface = {
    resolveOwner: (id) => Effect.succeed(id === "child" ? "owner" : id),
    listBySession: (owner) => Effect.succeed(connectionAvailable && owner === "owner" ? [{
      id: connectionId, session_id: owner, engine_connection_id: "eng_test", engine_connection_name: "fixed", service: "example",
      alias: "Test", auth_type: "api_key", status: "active", time_created: 1, time_updated: 1,
    }] : []),
    insert: () => Effect.void, delete: () => Effect.void, deleteBySession: () => Effect.void,
    listAllEngineConnectionIds: () => Effect.succeed([]), insertOAuthRequest: () => Effect.succeed(true),
    updateOAuthRequestState: () => Effect.void, listOAuthRequestsBySession: () => Effect.succeed([]),
  }
  const engine = Layer.effect(ConnectorEngine.Service, Effect.gen(function* () {
    const disabled = yield* ConnectorEngine.Service
    return ConnectorEngine.Service.of({ ...disabled,
      actionsForService: () => Effect.succeed(catalog),
      getConnection: (id) => Effect.succeed({ id, engineConnectionName: "fixed", service: "example", authType: "api_key", status: connectionAvailable ? "active" : "reauth_required", profile: { accountId: "test", displayName: "Test" } }),
      executeScopedAction: (input) => Effect.sync(() => {
        executed.push(input.connectionId ?? "public")
        return { executionId: "run_test", auditPersisted: true, result: { ok: true, output: input.input } }
      }),
    })
  })).pipe(Layer.provide(ConnectorEngine.layer({ enabled: false, dataDir: "", publicOrigin: "http://localhost", encryptionKey: "", adminToken: "" })))
  const layer = AppMcp.layer(limits).pipe(Layer.provide(Layer.mergeAll(
    Layer.succeed(AppMcp.Store, store), Layer.succeed(Connector.Store, connections), engine,
  )))
  const run = <A, E>(effect: Effect.Effect<A, E, AppMcp.Service>) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const create = (owner = "owner") => run(Effect.flatMap(AppMcp.Service, (service) => service.create(owner, { name: "Example", service: "example", connectionId, actionIds: [action.id] })))
  const request = (id: string, token: string, method: string, params?: unknown) => run(Effect.flatMap(AppMcp.Service, (service) => service.handle(id, new Request(`http://localhost/mcp/${id}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }))))
  return { rows, run, create, request, executed, setCatalog: (value: RuntimeActionDefinition[]) => { catalog = value }, removeConnection: () => { connectionAvailable = false } }
}

describe("application MCP deployment service", () => {
  it("stores only a hash and never lists the credential", async () => {
    const f = fixture(); const issued = await f.create()
    expect(issued.token).toMatch(/^ocm_[A-Za-z0-9_-]{43}$/)
    expect(JSON.stringify([...f.rows.values()])).not.toContain(issued.token)
    const listed = await f.run(Effect.flatMap(AppMcp.Service, (service) => service.list("child")))
    expect(listed).toHaveLength(1)
    expect(JSON.stringify(listed)).not.toContain("token_hash")
    expect(JSON.stringify(listed)).not.toContain(issued.token)
  })
  it("isolates owners, accounts and the deployment path", async () => {
    const f = fixture(); const a = await f.create(); const b = await f.create()
    await expect(f.run(Effect.flatMap(AppMcp.Service, (service) => service.rotate("other", a.deployment.id, 1)))).rejects.toThrow("not found")
    expect(await f.run(Effect.flatMap(AppMcp.Service, (service) => service.list("other")))).toEqual([])
    await expect(f.request(b.deployment.id, a.token, "tools/list")).rejects.toThrow("invalid or inactive")
    await expect(f.create("other")).rejects.toThrow("unavailable")
  })
  it("enforces deployment quota and revision CAS", async () => {
    const f = fixture(); const issued = await f.create(); await f.create()
    await expect(f.create()).rejects.toThrow("quota")
    await f.run(Effect.flatMap(AppMcp.Service, (service) => service.update("owner", issued.deployment.id, { revision: 1, name: "Changed" })))
    await expect(f.run(Effect.flatMap(AppMcp.Service, (service) => service.rotate("owner", issued.deployment.id, 1)))).rejects.toThrow("changed")
  })
  it("rotates only this MCP and invalidates its old token", async () => {
    const f = fixture(); const a = await f.create(); const b = await f.create()
    const rotated = await f.run(Effect.flatMap(AppMcp.Service, (service) => service.rotate("owner", a.deployment.id, 1)))
    await expect(f.request(a.deployment.id, a.token, "tools/list")).rejects.toThrow("invalid or inactive")
    expect((await f.request(a.deployment.id, rotated.token, "tools/list")).status).toBe(200)
    expect((await f.request(b.deployment.id, b.token, "tools/list")).status).toBe(200)
  })
  it("disables and deletes without affecting other MCPs", async () => {
    const f = fixture(); const a = await f.create(); const b = await f.create()
    await f.run(Effect.flatMap(AppMcp.Service, (service) => service.update("owner", a.deployment.id, { revision: 1, status: "disabled" })))
    await expect(f.request(a.deployment.id, a.token, "tools/list")).rejects.toThrow("invalid or inactive")
    await f.run(Effect.flatMap(AppMcp.Service, (service) => service.remove("owner", a.deployment.id)))
    await f.run(Effect.flatMap(AppMcp.Service, (service) => service.remove("owner", a.deployment.id)))
    expect((await f.run(Effect.flatMap(AppMcp.Service, (service) => service.list("owner")))).map((item) => item.id)).toEqual([b.deployment.id])
  })
  it("does not automatically authorize new actions and blocks removed tools", async () => {
    const f = fixture(); const a = await f.create(); f.setCatalog([action, { ...action, id: "example.extra" }])
    const response = await f.request(a.deployment.id, a.token, "tools/list")
    const body = await payload(response)
    expect(JSON.stringify(body)).not.toContain("example.extra")
    f.setCatalog([])
    const removed = await f.request(a.deployment.id, a.token, "tools/list")
    expect(await payload(removed)).toMatchObject({ result: { tools: [] } })
  })
  it("requires explicit confirmation when execution contracts change", async () => {
    const f = fixture(); const a = await f.create(); f.setCatalog([{ ...action, requiredScopes: ["write"] }])
    expect(await payload(await f.request(a.deployment.id, a.token, "tools/list"))).toMatchObject({ result: { tools: [] } })
    await expect(f.run(Effect.flatMap(AppMcp.Service, (service) => service.update("owner", a.deployment.id, { revision: 1, actionIds: [action.id] })))).rejects.toThrow("Confirm")
    await f.run(Effect.flatMap(AppMcp.Service, (service) => service.update("owner", a.deployment.id, { revision: 1, actionIds: [action.id], confirmContracts: true })))
    expect(JSON.stringify(await payload(await f.request(a.deployment.id, a.token, "tools/list")))).toContain("example__echo")
  })
  it("fails closed after the bound account disappears", async () => {
    const f = fixture(); const a = await f.create(); f.removeConnection()
    await expect(f.request(a.deployment.id, a.token, "tools/list")).rejects.toThrow("unavailable")
    expect(f.executed).toEqual([])
  })
  it("executes a direct action through the official MCP client using the fixed account", async () => {
    const f = fixture(); const a = await f.create()
    const client = new Client({ name: "deployment-test", version: "1" })
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost/mcp/${a.deployment.id}`), {
      fetch: async (url, init) => {
        if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("Expected JSON")
        return f.run(Effect.flatMap(AppMcp.Service, (service) => service.handle(a.deployment.id, new Request(url.toString(), {
          method: init?.method, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${a.token}` }, body: init?.body, signal: init?.signal,
        }))))
      },
    })
    try {
      await client.connect(transport)
      const tools = await client.listTools(); const tool = tools.tools[0]
      if (!tool) throw new Error("Missing tool")
      const result = await client.callTool({ name: tool.name, arguments: { message: "APP_MCP_OK" } })
      expect(result.isError).toBe(false)
      expect(f.executed).toEqual(["eng_test"])
      expect(JSON.stringify(result)).toContain("APP_MCP_OK")
    } finally { await client.close() }
  })
})
