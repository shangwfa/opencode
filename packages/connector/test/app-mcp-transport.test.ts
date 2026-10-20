import { describe, expect, it } from "bun:test"
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client"
import type { AppMcpTool } from "../src/adapter/app-mcp-tools.js"
import { handleAppMcpRequest, type AppMcpTransportOptions } from "../src/adapter/app-mcp-transport.js"

const tool: AppMcpTool = {
  actionId: "example.echo", name: "example__echo", description: "Echo a message", contractHash: "confirmed",
  inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1 } }, required: ["message"], additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}

describe("application MCP standard transport", () => {
  async function connected(options: AppMcpTransportOptions) {
    const client = new Client({ name: "connector-sdk-test", version: "1" })
    const responses: { status: number; body: string; contentType: string }[] = []
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/mcp/test"), {
      fetch: async (url, init) => {
        if (init?.body !== undefined && init.body !== null && typeof init.body !== "string") throw new Error("Expected JSON request body")
        const request = new Request(url.toString(), { method: init?.method, headers: init?.headers, body: init?.body, signal: init?.signal })
        const response = await handleAppMcpRequest(request, options)
        responses.push({ status: response.status, body: await response.clone().text(), contentType: response.headers.get("content-type") ?? "" })
        return response
      },
    })
    try {
      await client.connect(transport)
    } catch (error) {
      await client.close()
      throw error
    }
    return { client, responses }
  }

  it("handshakes with the official client and exposes direct action schemas without an envelope", async () => {
    const { client, responses } = await connected({ name: "example", tools: [tool], execute: async (_tool, input) => ({ ok: true, data: input }) })
    try {
      const listed = await client.listTools()
      expect(listed.tools.map((item) => item.name)).toEqual([tool.name])
      expect(JSON.stringify(listed.tools[0]?.inputSchema)).toBe(JSON.stringify(tool.inputSchema))
      const result = await client.callTool({ name: tool.name, arguments: { message: "hello" } })
      expect(result.isError).toBe(false)
      expect(result.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true, data: { message: "hello" } }) }])
      for (const response of responses.filter((item) => item.body && item.contentType.includes("application/json"))) {
        const body = JSON.parse(response.body)
        expect(body.jsonrpc).toBe("2.0")
        expect(body.status).toBeUndefined()
        expect(body.body).toBeUndefined()
      }
      expect(responses.some((item) => item.status === 202 && item.body === "")).toBe(true)
    } finally { await client.close() }
  })

  it("rejects invalid input and guessed hidden tools before execution", async () => {
    let calls = 0
    const { client } = await connected({ name: "example", tools: [tool], execute: async () => { calls++; return { ok: true } } })
    try {
      const invalid = await client.callTool({ name: tool.name, arguments: { message: 1 } })
      expect(invalid.isError).toBe(true)
      await expect(client.callTool({ name: "hidden_action", arguments: {} })).rejects.toThrow()
      expect(calls).toBe(0)
    } finally { await client.close() }
  })

  it("returns business failures as tool errors, not successful action results", async () => {
    const { client } = await connected({ name: "example", tools: [tool], execute: async () => ({ ok: false, error: { code: "authorization_failed", message: "Missing scope" } }) })
    try {
      const result = await client.callTool({ name: tool.name, arguments: { message: "hello" } })
      expect(result.isError).toBe(true)
    } finally { await client.close() }
  })
})
