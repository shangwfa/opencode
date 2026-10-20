import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppMcp, AppMcpError } from "@opencode/connector/adapter/app-mcp"
import { ConnectorMcpNode } from "@opencode/core/connector/mcp-node"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"

const id = "cmcp_" + "a".repeat(32)
const options = {
  app: { version: "test" }, database: { path: ":memory:" }, config: { project: false },
  models: { fetch: false }, fs: { filewatcher: false }, password: "test-password",
} as const

it.live("application MCP raw transport preserves status, headers and body through full server routes", () => Effect.gen(function* () {
  const calls: { id: string; method: string; authorization: string | null; body: string }[] = []
  const unavailable = () => Effect.fail(new AppMcpError("not_used", "Not used in this transport test", 400))
  const service: AppMcp.Interface = {
    list: () => Effect.succeed([]), create: unavailable, update: unavailable, rotate: unavailable,
    remove: () => Effect.void,
    handle: (deploymentId, request) => Effect.gen(function* () {
      if (request.headers.get("authorization") !== "Bearer valid-test-token")
        return yield* Effect.fail(new AppMcpError("unauthorized", "Invalid test credential", 401))
      const body = yield* Effect.promise(() => request.text())
      calls.push({ id: deploymentId, method: request.method, authorization: request.headers.get("authorization"), body })
      if (body.includes("notifications/initialized")) return new Response(null, { status: 202 })
      return Response.json({ jsonrpc: "2.0", id: 7, result: { tools: [] } }, { headers: { "mcp-protocol-version": "2025-06-18" } })
    }),
  }
  const handler = yield* ServerFetch.make(options, { overrides: [ConnectorMcpNode.node.replace(Layer.succeed(AppMcp.Service, service))] })
  const call = (authorization: string, method: string) => Effect.promise(() => handler(new Request(`http://opencode.local/api/connector/mcp/${id}`, {
    method: "POST", headers: { authorization, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method }),
  })))
  const rejected = yield* call("Bearer invalid", "tools/list")
  expect(rejected.status).toBe(401)
  expect(rejected.headers.get("www-authenticate")).toBe("Bearer")
  const response = yield* call("Bearer valid-test-token", "tools/list")
  expect(response.status).toBe(200)
  expect(response.headers.get("mcp-protocol-version")).toBe("2025-06-18")
  expect(yield* Effect.promise(() => response.json())).toEqual({ jsonrpc: "2.0", id: 7, result: { tools: [] } })
  const notification = yield* call("Bearer valid-test-token", "notifications/initialized")
  expect(notification.status).toBe(202)
  expect(yield* Effect.promise(() => notification.text())).toBe("")
  expect(calls).toHaveLength(2)
  expect(calls[0]?.id).toBe(id)
  // Runtime bearer bypass must not open management routes.
  const management = yield* Effect.promise(() => handler(new Request("http://opencode.local/api/session/ses_unknown/connector/mcp-deployments", { headers: { authorization: "Bearer valid-test-token" } })))
  expect(management.status).toBe(401)
}), 60_000)
