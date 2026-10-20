import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"
import { Validator, type Schema } from "@cfworker/json-schema"
import type { AppMcpTool } from "./app-mcp-tools.js"

/** The host authenticates the request and loads the current deployment before calling this transport. */
export interface AppMcpTransportOptions {
  readonly name: string
  readonly tools: readonly AppMcpTool[]
  /** Recheck deployment, token, connection, whitelist and contract at execution admission. */
  readonly execute: (tool: AppMcpTool, input: unknown, signal: AbortSignal) => Promise<{
    readonly ok: boolean
    readonly data?: unknown
    readonly error?: { readonly code: string; readonly message: string }
  }>
}

export async function handleAppMcpRequest(request: Request, options: AppMcpTransportOptions): Promise<Response> {
  const handler = createMcpHandler(() => {
    const server = new McpServer({ name: options.name, version: "1.0.0" })
    if (options.tools.length === 0) {
      // The SDK otherwise omits the tools capability when every selected contract is invalidated.
      server.server.registerCapabilities({ tools: {} })
      server.server.setRequestHandler("tools/list", async () => ({ tools: [] }))
    }
    for (const tool of options.tools) {
      const validator = new Validator(tool.inputSchema as Schema, "2020-12", false)
      const inputSchema = {
        "~standard": {
          version: 1 as const,
          vendor: "opencode-connector",
          jsonSchema: {
            input: () => tool.inputSchema,
            output: () => tool.inputSchema,
          },
          validate: (value: unknown) => {
            const result = validator.validate(value)
            return result.valid ? { value } : { issues: result.errors.map((error) => ({ message: error.error })) }
          },
        },
      }
      server.registerTool(tool.name, {
        description: tool.description,
        inputSchema,
        annotations: tool.annotations,
      }, async (input) => {
        const result = await options.execute(tool, input, request.signal)
        return {
          isError: !result.ok,
          content: [{ type: "text", text: JSON.stringify(result) }],
        }
      })
    }
    return server
  }, { legacy: "stateless", responseMode: "json" })
  try {
    return await handler.fetch(request)
  } finally {
    await handler.close()
  }
}
