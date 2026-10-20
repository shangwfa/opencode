import { describe, expect, it } from "bun:test"
import type { RuntimeActionDefinition } from "../src/engine/catalog-store.js"
import type { ConnectionSummary } from "../src/engine/connection-service.js"
import type { RunActionInput } from "../src/engine/server/actions/action-runner.js"
import { ActionPolicyService, emptyPolicyRules } from "../src/engine/core/action-policy.js"
import { createScopedActionExecutor } from "../src/engine/server/actions/scoped-action.js"
import { appMcpContractHash, appMcpToolName, selectAppMcpTools } from "../src/adapter/app-mcp-tools.js"

const action: RuntimeActionDefinition = {
  id: "example.echo", service: "example", name: "echo", description: "Echo input", operationType: "read",
  requiredScopes: [], providerPermissions: [], inputSchema: { type: "object", properties: { message: { type: "string" } } },
  outputSchema: { type: "object" },
  execution: { locallyExecutable: true, catalogOnly: false, requiredAuthTypes: ["api_key"], noAuthRunnable: false, needsCredential: true },
}
const limits = { maxTools: 10, maxToolBytes: 10000, maxTotalBytes: 20000 }
const connection: ConnectionSummary = {
  id: "eng_account", service: "example", connectionName: "account", authType: "api_key", configured: true,
  virtual: false, default: false, profile: { accountId: "account", displayName: "Account", grantedScopes: [] },
}

describe("application MCP tools", () => {
  it("selects only explicit actions and retains input constraints", () => {
    const tools = selectAppMcpTools("example", [action.id], [action, { ...action, id: "example.other" }], limits)
    expect(tools).toHaveLength(1)
    expect(tools[0]?.inputSchema).toEqual(action.inputSchema)
    expect(tools[0]?.annotations.readOnlyHint).toBe(true)
  })
  it("uses stable legal names without normalization aliases", () => {
    expect(appMcpToolName(action.id)).toBe(appMcpToolName(action.id))
    expect(appMcpToolName("a.b")).not.toBe(appMcpToolName("a__b"))
    expect(appMcpToolName("应用." + "a".repeat(100))).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(() => appMcpToolName("example.*")).toThrow()
  })
  it("rejects empty, duplicate, unknown and cross-application actions", () => {
    for (const ids of [[], [action.id, action.id], ["missing"], [action.id]]) {
      expect(() => selectAppMcpTools(ids.length === 1 && ids[0] === action.id ? "other" : "example", ids, [action], limits)).toThrow()
    }
  })
  it("enforces count, per-tool and manifest limits with no silent truncation", () => {
    expect(() => selectAppMcpTools("example", [action.id], [action], { ...limits, maxTools: 0 })).toThrow()
    expect(() => selectAppMcpTools("example", [action.id], [action], { ...limits, maxToolBytes: 1 })).toThrow()
    expect(() => selectAppMcpTools("example", [action.id], [action], { ...limits, maxTotalBytes: 1 })).toThrow()
    expect(() => selectAppMcpTools("example", [action.id], [{ ...action, inputSchema: { type: "string" } }], limits)).toThrow()
  })
  it("ignores documentation but invalidates changed parameters, scopes and risk", () => {
    const hash = appMcpContractHash(action)
    expect(appMcpContractHash({ ...action, description: "New documentation" })).toBe(hash)
    expect(appMcpContractHash({ ...action, inputSchema: { ...action.inputSchema, description: "Help" } })).toBe(hash)
    expect(appMcpContractHash({ ...action, requiredScopes: ["write"] })).not.toBe(hash)
    expect(appMcpContractHash({ ...action, operationType: "write" })).not.toBe(hash)
    expect(appMcpContractHash({ ...action, inputSchema: { type: "object", properties: { description: { type: "string" } } } })).not.toBe(hash)
    const withDefault = { ...action, inputSchema: { type: "object", default: { description: "a" } } }
    expect(appMcpContractHash(withDefault)).not.toBe(appMcpContractHash({ ...withDefault, inputSchema: { type: "object", default: { description: "b" } } }))
  })
})

describe("internal scoped MCP execution", () => {
  function setup(options: { public?: boolean; connection?: ConnectionSummary; blocked?: boolean; policyFails?: boolean } = {}) {
    const calls: RunActionInput[] = []
    const target = options.public ? { ...action, execution: { ...action.execution, noAuthRunnable: true } } : action
    const execute = createScopedActionExecutor({
      catalog: { actionsById: new Map([[target.id, target]]) },
      policy: new ActionPolicyService(),
      runtimePolicy: {
        get: async () => {
          if (options.policyFails) throw new Error("PG unavailable")
          return { rules: { ...emptyPolicyRules(), blockedActions: options.blocked ? [action.id] : [] }, updatedAt: "now" }
        },
        set: async () => {},
      },
      connections: { getConnectionSummary: async () => options.connection },
      actions: { run: async (input) => { calls.push(input); return undefined } },
    })
    return { execute, calls }
  }
  const input = { service: "example", actionId: action.id, connectionId: connection.id, noAuth: false, input: {} }
  it("pins action and connection and preserves runtime policy without a token", async () => {
    const { execute, calls } = setup({ connection, blocked: true })
    await execute(input)
    const run = calls[0]
    expect(run?.connectionId).toBe(connection.id)
    expect(run?.runtimeTokenId).toBeUndefined()
    expect(run?.policy.evaluate(action).allowed).toBe(false)
    expect(run?.policy.evaluateConnection("other").allowed).toBe(false)
  })
  it("fails closed for missing or wrong connection and cross-service actions", async () => {
    for (const invalid of [{ ...input, connectionId: undefined }, { ...input, service: "other" }, input]) {
      const { execute, calls } = setup()
      await expect(execute(invalid)).rejects.toThrow()
      expect(calls).toHaveLength(0)
    }
    const { execute } = setup({ connection: { ...connection, id: "other" } })
    await expect(execute(input)).rejects.toThrow()
  })
  it("does not fall back to public execution or ignore policy storage failures", async () => {
    await expect(setup({ connection }).execute({ ...input, noAuth: true, connectionId: undefined })).rejects.toThrow()
    const { execute, calls } = setup({ connection, policyFails: true })
    await expect(execute(input)).rejects.toThrow("PG unavailable")
    expect(calls).toHaveLength(0)
  })
  it("allows no-auth only with an eligible public action and public connection", async () => {
    const publicInput = { ...input, noAuth: true, connectionId: undefined }
    const { execute, calls } = setup({ public: true, connection: { ...connection, authType: "no_auth", virtual: true } })
    await execute(publicInput)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.connectionId).toBe(connection.id)
    expect(calls[0]?.policy.evaluateConnection("unrelated-account").allowed).toBe(false)
    await expect(setup({ public: true, connection }).execute(publicInput)).rejects.toThrow()
  })
})
