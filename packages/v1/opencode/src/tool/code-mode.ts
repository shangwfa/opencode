import * as Tool from "./tool"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Cause, Effect, Schema } from "effect"
import { CodeMode, Tool as SandboxTool, toolError } from "@opencode-ai/codemode"
import { MCP } from "@/mcp"
import { McpCatalog } from "@/mcp/catalog"
import { Agent } from "@/agent/agent"
import { Session } from "@/session/session"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { ToolJsonSchema } from "./json-schema"

export const CODE_MODE_TOOL = "execute"

const DESCRIPTION = "Run a confined orchestration script with access to connected MCP tools."

export const DESCRIPTION_EXTENSIONS = `Execute JavaScript to orchestrate the available tools in a single call. Inside the script, your regular tools are exposed under the \`tools.opencode.*\` namespace and connected MCP servers under \`tools.<server>.*\`.

Use this when a task chains multiple dependent tool calls (write then read then verify), fans out several independent calls (\`Promise.all\`), or transforms large intermediate results in code — it saves model round-trips and keeps bulky outputs out of the conversation. Prefer direct tool calls when a step needs your judgment before the next one, or when a single small call suffices; do not use this merely to force concurrency.`

export const Parameters = Schema.Struct({
  code: Schema.String.annotate({
    description: "Script body executed by the confined interpreter.",
  }),
})

type CallEntry = { tool: string; status: "running" | "completed" | "error"; input?: Record<string, unknown> }

type Metadata = {
  toolCalls: CallEntry[]
  error?: boolean
}

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

type CatalogEntryBase = {
  path: string
  key: string
  server: string
  local: string
}

type McpEntry = CatalogEntryBase & {
  type: "mcp"
  tool: MCP.McpTool
}

export type Extension = {
  id: string
  description: string
  input: SandboxTool.JsonSchema
  output?: SandboxTool.JsonSchema
  run: (args: Record<string, unknown>, callID: string, ctx: Tool.Context) => Effect.Effect<Tool.ExecuteResult, unknown>
}

type ExtensionEntry = CatalogEntryBase & {
  type: "extension"
  extension: Extension
}

type CatalogEntry = McpEntry | ExtensionEntry

function extensionEntries(extensions: readonly Extension[]): ExtensionEntry[] {
  return extensions.map((extension) => ({
    type: "extension",
    path: `opencode.${extension.id}`,
    key: extension.id,
    server: "opencode",
    local: extension.id,
    extension,
  }))
}

function previewExtensions(tools: readonly Tool.Def[]): Extension[] {
  return tools.map((tool) => ({
    id: tool.id,
    description: tool.description,
    input: ToolJsonSchema.fromTool(tool) as SandboxTool.JsonSchema,
    run: () => Effect.fail(toolError("Tool preview is not executable.")),
  }))
}

function groupByServer(mcpTools: Record<string, MCP.McpTool>, servers: readonly string[]): Map<string, McpEntry[]> {
  const byLongest = [...servers].sort((a, b) => b.length - a.length)
  const groups = new Map<string, McpEntry[]>()
  for (const key of Object.keys(mcpTools).sort((a, b) => a.localeCompare(b))) {
    const server =
      byLongest.find((name) => key.startsWith(name + "_")) ?? (key.includes("_") ? key.slice(0, key.indexOf("_")) : key)
    const local = server && key.startsWith(server + "_") ? key.slice(server.length + 1) : key
    const entry: McpEntry = {
      type: "mcp",
      path: `${server}.${local}`,
      key,
      server,
      local,
      tool: mcpTools[key]!,
    }
    groups.set(server, [...(groups.get(server) ?? []), entry])
  }
  return groups
}

export function describeCatalog(
  mcpTools: Record<string, MCP.McpTool>,
  servers: readonly string[],
  extensions: readonly Tool.Def[] = [],
): string {
  const instructions = CodeMode.make({
    tools: toolTree(
      [...[...groupByServer(mcpTools, servers).values()].flat(), ...extensionEntries(previewExtensions(extensions))],
      () => () => Effect.fail(toolError("Tool preview is not executable.")),
    ),
  }).instructions()
  if (extensions.length === 0) return instructions
  return `Note: the \`tools.opencode\` namespace below re-exposes your regular built-in/agent tools (write, edit, read, bash, glob, grep, and others) for use inside the script — they are the same tools, not a separate API.\n\n${instructions}`
}

const lastSegment = (uri: string) => {
  const trimmed = uri.split(/[?#]/, 1)[0]!.replace(/\/+$/, "")
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1)
  return segment.length > 0 ? segment : undefined
}

const dataUrl = (mime: string, base64: string) => `data:${mime};base64,${base64}`

function projectMcpResult(result: CallToolResult, collect: (attachment: Attachment) => void): unknown {
  const text: string[] = []
  let files = 0
  let images = 0
  const push = (attachment: Attachment) => {
    files += 1
    if (attachment.mime.startsWith("image/")) images += 1
    collect(attachment)
  }
  for (const block of result.content) {
    switch (block.type) {
      case "text":
        text.push(block.text)
        break
      case "image":
      case "audio":
        push({ type: "file", mime: block.mimeType, url: dataUrl(block.mimeType, block.data) })
        break
      case "resource": {
        if ("text" in block.resource) {
          text.push(block.resource.text)
          break
        }
        const mime = block.resource.mimeType ?? "application/octet-stream"
        push({ type: "file", mime, url: dataUrl(mime, block.resource.blob), filename: lastSegment(block.resource.uri) })
        break
      }
      case "resource_link":
        // A link is a reference, not fetchable media; hand it to the program instead of the attachment channel.
        text.push(`${block.name}: ${block.uri}`)
        break
    }
  }

  if (result.structuredContent !== undefined && result.structuredContent !== null) return result.structuredContent
  if (text.length > 0) return text.join("\n")
  if (files > 0) {
    const noun = files === images ? "image" : "file"
    return `[${files} ${noun}${files === 1 ? "" : "s"} attached to the result]`
  }
  return null
}

type Run = (input: unknown) => Effect.Effect<unknown, unknown>

function toolTree(catalog: readonly CatalogEntry[], run: (entry: CatalogEntry) => Run) {
  const tree: Record<string, Record<string, SandboxTool.Definition>> = {}
  for (const entry of catalog) {
    const namespace = (tree[entry.server] ??= {})
    namespace[entry.local] = SandboxTool.make({
      description: entry.type === "mcp" ? (entry.tool.def.description ?? "") : entry.extension.description,
      input: entry.type === "mcp" ? (entry.tool.def.inputSchema as SandboxTool.JsonSchema) : entry.extension.input,
      output:
        entry.type === "mcp"
          ? (entry.tool.def.outputSchema as SandboxTool.JsonSchema | undefined)
          : entry.extension.output,
      run: run(entry),
    })
  }
  return tree
}

const invokeChildTool = Effect.fn("CodeMode.invokeChildTool")(function* (input: {
  plugin: Plugin.Interface
  entry: McpEntry
  args: Record<string, unknown>
  callID: string
  ctx: Tool.Context
}) {
  yield* input.plugin.trigger(
    "tool.execute.before",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID },
    { args: input.args },
  )
  const result: CallToolResult = yield* Effect.gen(function* () {
    yield* input.ctx.ask({ permission: input.entry.key, metadata: {}, patterns: ["*"], always: ["*"] })
    // Deliberately mirrors McpCatalog.convertTool's transport call so the MCP service stays free of tool-loop concerns.
    return yield* Effect.promise(async () => {
      const raw = await input.entry.tool.client.callTool(
        { name: input.entry.tool.def.name, arguments: input.args },
        CallToolResultSchema,
        {
          resetTimeoutOnProgress: true,
          signal: input.ctx.abort,
          timeout: input.entry.tool.timeout,
          // The MCP SDK only sends a progress token when this hook is present, enabling timeout resets.
          onprogress: () => {},
        },
      )
      if (raw.isError)
        throw new Error(
          raw.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .filter((text) => text.trim())
            .join("\n\n") || "MCP tool returned an error",
        )
      return raw
    })
  }).pipe(
    Effect.withSpan("Tool.execute", {
      attributes: {
        "tool.name": input.entry.key,
        "tool.call_id": input.callID,
        "session.id": input.ctx.sessionID,
        "message.id": input.ctx.messageID,
      },
    }),
  )
  yield* input.plugin.trigger(
    "tool.execute.after",
    { tool: input.entry.key, sessionID: input.ctx.sessionID, callID: input.callID, args: input.args },
    result,
  )
  return result
})

function contextExtensions(ctx: Tool.Context, fallback: readonly Extension[]) {
  if (!ctx.orchestration) return fallback
  return ctx.orchestration.extensions.filter(
    (item): item is Extension =>
      typeof item === "object" &&
      item !== null &&
      "id" in item &&
      typeof item.id === "string" &&
      "run" in item &&
      typeof item.run === "function",
  )
}

const makeInit = (extensions: readonly Extension[]) =>
  Effect.gen(function* () {
    const mcp = yield* MCP.Service
    const agents = yield* Agent.Service
    const sessions = yield* Session.Service
    const plugin = yield* Plugin.Service

    const init: Tool.DefWithoutID<typeof Parameters, Metadata> = {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: Effect.fn("CodeMode.execute")(function* (params, ctx) {
        if (ctx.abort.aborted) {
          yield* ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: [], error: true } })
          return yield* Effect.fail(new Tool.ExecutionError("Execution cancelled.", { toolCalls: [], error: true }))
        }
        const agent = yield* agents.get(ctx.agent)
        const session = yield* sessions.get(ctx.sessionID).pipe(Effect.orDie)
        const ruleset = Permission.merge(agent.permission, session.permission ?? [])
        const mcpTools = Permission.visibleTools(yield* mcp.toolsForSession(ctx.sessionID), ruleset)
        const servers = Object.keys(yield* mcp.clients()).map(McpCatalog.sanitize)
        const catalog: CatalogEntry[] = [
          ...[...groupByServer(mcpTools, servers).values()].flat(),
          ...extensionEntries(contextExtensions(ctx, extensions)),
        ]

        const calls: CallEntry[] = []
        const attachments: Attachment[] = []
        const publish = () =>
          ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls.map((c) => ({ ...c })) } })

        let childCalls = 0
        const callTool = (entry: CatalogEntry) => (input: unknown) =>
          Effect.gen(function* () {
            childCalls += 1
            const callID = `${ctx.callID ?? entry.key}/${childCalls}`
            if (entry.type === "mcp") {
              const result = yield* invokeChildTool({
                plugin,
                entry,
                args: (input ?? {}) as Record<string, unknown>,
                callID,
                ctx,
              })
              return projectMcpResult(result, (attachment: Attachment) => void attachments.push(attachment))
            }
            const result = yield* entry.extension.run((input ?? {}) as Record<string, unknown>, callID, ctx)
            for (const attachment of result.attachments ?? []) attachments.push(attachment)
            return result.output
          }).pipe(
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt
              const error = Cause.squash(cause)
              return Effect.fail(toolError(error instanceof Error ? error.message : String(error), error))
            }),
          )

        const runtime = CodeMode.make({
          tools: toolTree(catalog, callTool),
          onToolCallStart: ({ index, name, input }) =>
            Effect.suspend(() => {
              const shown = (() => {
                if (input === null || input === undefined) return
                if (typeof input === "object" && !Array.isArray(input)) {
                  const value = input as Record<string, unknown>
                  return Object.keys(value).length > 0 ? value : undefined
                }
                return { input }
              })()
              calls[index] = { tool: name, status: "running", ...(shown ? { input: shown } : {}) }
              return publish()
            }),
          onToolCallEnd: ({ index, outcome }) =>
            Effect.suspend(() => {
              const current = calls[index]
              if (current) calls[index] = { ...current, status: outcome === "success" ? "completed" : "error" }
              return publish()
            }),
        })

        const abort = Effect.callback<void>((resume) => {
          if (ctx.abort.aborted) return resume(Effect.void)
          const handler = () => resume(Effect.void)
          ctx.abort.addEventListener("abort", handler, { once: true })
          return Effect.sync(() => ctx.abort.removeEventListener("abort", handler))
        })
        const cancelled = (): CodeMode.Result => ({
          ok: false,
          error: { kind: "ExecutionFailure", message: "Execution cancelled." },
          toolCalls: calls.map((call) => ({ name: call.tool })),
        })

        yield* publish()
        const result = yield* Effect.raceFirst(runtime.execute(params.code), abort.pipe(Effect.map(cancelled)))
        const logs = result.logs ?? []
        const withLogs = (text: string) => {
          if (logs.length === 0) return text
          return text.length > 0 ? `${text}\n\nLogs:\n${logs.join("\n")}` : `Logs:\n${logs.join("\n")}`
        }

        if (!result.ok) {
          if (ctx.abort.aborted) {
            yield* ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls, error: true } })
            return yield* Effect.fail(
              new Tool.ExecutionError("Execution cancelled.", { toolCalls: calls, error: true }),
            )
          }
          const hints = (result.error.suggestions ?? []).filter((hint) => !result.error.message.includes(hint))
          const message = withLogs([result.error.message, ...hints].join("\n"))
          yield* ctx.metadata({ title: CODE_MODE_TOOL, metadata: { toolCalls: calls, error: true } })
          return yield* Effect.fail(new Tool.ExecutionError(message, { toolCalls: calls, error: true }))
        }

        // The interpreter validates returned values as plain JSON, so stringify cannot throw;
        // it yields undefined only for a program that returns undefined.
        const output =
          typeof result.value === "string"
            ? result.value
            : (JSON.stringify(result.value, null, 2) ?? String(result.value))

        return {
          title: CODE_MODE_TOOL,
          metadata: { toolCalls: calls },
          output: withLogs(output),
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult<Metadata>
      }, Effect.orDie),
    }
    return init
  })

export const makeCodeModeTool = (extensions: readonly Extension[] = []) =>
  Tool.define(CODE_MODE_TOOL, makeInit(extensions))

export const CodeModeTool = makeCodeModeTool()
