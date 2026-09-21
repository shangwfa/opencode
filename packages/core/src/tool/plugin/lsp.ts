export * as LspTool from "./lsp.js"

import type { Context } from "@opencode/plugin/effect/plugin"
import { ToolFailure } from "@opencode/ai"
import { Cause, Effect, Option, Schema } from "effect"
import { LspAgent } from "../../lsp/agent.js"
import { Location } from "../../location.js"
import { FileAccess } from "../../file-access.js"
import { Permission } from "../../permission.js"

export const name = "lsp"

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

export const Input = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.optional(Schema.Int).annotate({ description: "The line number (1-based)" }),
  character: Schema.optional(Schema.Int).annotate({ description: "The character offset (1-based)" }),
  query: Schema.optional(Schema.String).annotate({ description: "Search query for workspaceSymbol" }),
})

export const Output = Schema.Struct({
  result: Schema.Unknown,
})

export const description = [
  "Interact with Language Server Protocol (LSP) servers to get code intelligence features.",
  "",
  "Supported operations:",
  "- goToDefinition: Find where a symbol is defined",
  "- findReferences: Find all references to a symbol",
  "- hover: Get hover information (documentation, type info) for a symbol",
  "- documentSymbol: Get all symbols (functions, classes, variables) in a document",
  "- workspaceSymbol: List project-wide symbols matching a query string",
  "- goToImplementation: Find implementations of an interface or abstract method",
  "- prepareCallHierarchy: Get call hierarchy item at a position",
  "- incomingCalls: Find all functions/methods that call the function at a position",
  "- outgoingCalls: Find all functions/methods called by the function at a position",
].join("\n")

function toSandboxPath(filePath: string): string {
  // If it starts with /workspace it's already a sandbox path
  if (filePath.startsWith("/workspace")) return filePath
  // If it's absolute, assume it's a host path and map to sandbox
  if (filePath.startsWith("/")) return `/workspace${filePath}`
  return `/workspace/${filePath}`
}

export const Plugin = {
  id: "opencode.tool.lsp",
  effect: Effect.fn("LspTool.Plugin")(function* (ctx: Context) {
    const access = yield* FileAccess.Service
    const permission = yield* Permission.Service
    const location = yield* Location.Service
    const agentOpt = yield* Effect.serviceOption(LspAgent.Service)

    yield* ctx.tool.transform((editor) =>
      editor.add({
        name,
        options: { codemode: true, permission: "lsp" },
        description,
        input: Input,
        output: Output,
        execute: (input, context) => {
            const agent = Option.getOrUndefined(agentOpt)
            if (!agent)
              return Effect.fail(new ToolFailure({ message: "LSP is not available in this environment." }))

            // Permission check
            const meta: Record<string, unknown> = { operation: input.operation }
            if (input.filePath) meta.filePath = input.filePath
            if (input.line !== undefined) meta.line = input.line
            if (input.character !== undefined) meta.character = input.character

            return Effect.gen(function* () {
              yield* permission.assert({
                action: "lsp",
                resources: [input.filePath ?? ""],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
                metadata: meta,
              })

              const sandboxPath = toSandboxPath(input.filePath ?? "")
              const line = (input.line ?? 1) - 1
              const character = (input.character ?? 1) - 1

              let result: unknown
              try {
                result = yield* Effect.gen(function* () {
                  switch (input.operation) {
                    case "hover": return yield* agent.hover(sandboxPath, line, character)
                    case "goToDefinition": return yield* agent.definition(sandboxPath, line, character)
                    case "findReferences": return yield* agent.references(sandboxPath, line, character)
                    case "goToImplementation": return yield* agent.implementation(sandboxPath, line, character)
                    case "documentSymbol": return yield* agent.documentSymbol(sandboxPath)
                    case "workspaceSymbol": return yield* agent.workspaceSymbol(input.query ?? "")
                    case "prepareCallHierarchy": return yield* agent.prepareCallHierarchy(sandboxPath, line, character)
                    case "incomingCalls": return yield* agent.incomingCalls(sandboxPath, line, character)
                    case "outgoingCalls": return yield* agent.outgoingCalls(sandboxPath, line, character)
                  }
                })
              } catch (e) {
                result = { error: e instanceof Error ? e.message : String(e) }
              }

              const output = JSON.stringify(result, null, 2)
              return {
                output: { result },
                content: [{ type: "text" as const, text: output }],
                metadata: { operation: input.operation, result },
              }
            }).pipe(
              Effect.catch(() => Effect.fail(new ToolFailure({ message: `LSP ${input.operation} failed` }))),
            )
          },
      }),
    )
  }),
}