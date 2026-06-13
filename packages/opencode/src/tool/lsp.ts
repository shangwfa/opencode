import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import path from "path"
import { LSP } from "@/lsp/lsp"
import { Agent as LspAgent } from "@/lsp/agent"
import DESCRIPTION from "./lsp.txt"
import { InstanceState } from "@/effect/instance-state"
import { pathToFileURL } from "url"
import { assertExternalDirectoryEffect } from "./external-directory"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

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

export const Parameters = Schema.Struct({
  operation: Schema.Literals(operations).annotate({ description: "The LSP operation to perform" }),
  filePath: Schema.String.annotate({ description: "The absolute or relative path to the file" }),
  line: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The line number (1-based, as shown in editors)",
  }),
  character: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
    description: "The character offset (1-based, as shown in editors)",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "Search query for workspaceSymbol. Empty string requests all symbols.",
  }),
})

export const LspTool = Tool.define(
  "lsp",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (args: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(instance.directory, args.filePath)
          const displayPath = toSandboxPath(file, instance.worktree === "/" ? instance.directory : instance.worktree)
          yield* assertExternalDirectoryEffect(ctx, file)
          const meta =
            args.operation === "workspaceSymbol"
              ? { operation: args.operation }
              : args.operation === "documentSymbol"
                ? { operation: args.operation, filePath: file }
                : { operation: args.operation, filePath: file, line: args.line, character: args.character }
          yield* ctx.ask({
            permission: "lsp",
            patterns: ["*"],
            always: ["*"],
            metadata: meta,
          })

          const sandboxProviderOpt = yield* Effect.serviceOption(SandboxProvider.Service)
          if (sandboxProviderOpt._tag === "Some") {
            const agentOpt = yield* Effect.serviceOption(LspAgent.Service)
            if (agentOpt._tag === "Some") {
              const sid = ctx.sandboxSessionID ?? ctx.sessionID
              const agent = agentOpt.value
              const sandboxRelPath = path.relative(instance.worktree, file)
              const sandboxDetail =
                args.operation === "workspaceSymbol" || args.operation === "documentSymbol"
                  ? sandboxRelPath
                  : `${sandboxRelPath}:${args.line}:${args.character}`
              const sandboxTitle = `${args.operation} ${sandboxDetail}`

              yield* agent.touch(sid, file, instance.directory).pipe(
                Effect.catchCause(() => Effect.void),
              )

              switch (args.operation) {
                case "hover": {
                  const result = yield* agent.hover(sid, file, instance.directory, args.line - 1, args.character - 1).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || !result.contents) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No hover information available." }
                  }
                  return { title: sandboxTitle, metadata: { result: result.contents }, output: JSON.stringify(result.contents, null, 2) }
                }
                case "goToDefinition": {
                  const result = yield* agent.definition(sid, file, instance.directory, args.line - 1, args.character - 1).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.locations.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No definitions found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.locations }, output: JSON.stringify(result.locations, null, 2).replaceAll(worktree, "/workspace") }
                }
                case "findReferences": {
                  const result = yield* agent.references(sid, file, instance.directory, args.line - 1, args.character - 1).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.locations.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No references found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.locations }, output: JSON.stringify(result.locations, null, 2).replaceAll(worktree, "/workspace") }
                }
                case "goToImplementation": {
                  const result = yield* agent.implementation(sid, file, instance.directory, args.line - 1, args.character - 1).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.locations.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No implementations found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.locations }, output: JSON.stringify(result.locations, null, 2).replaceAll(worktree, "/workspace") }
                }
                case "documentSymbol": {
                  const result = yield* agent.documentSymbol(sid, file, instance.directory).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.symbols.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No document symbols found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.symbols }, output: JSON.stringify(result.symbols, null, 2).replaceAll(worktree, "/workspace") }
                }
                case "workspaceSymbol": {
                  const result = yield* agent.workspaceSymbol(sid, args.query ?? "").pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.symbols.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No workspace symbols found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.symbols }, output: JSON.stringify(result.symbols, null, 2).replaceAll(worktree, "/workspace") }
                }
                case "prepareCallHierarchy": {
                  const result = yield* agent.prepareCallHierarchy(sid, file, instance.directory, args.line - 1, args.character - 1).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.items.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No call hierarchy items found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.items }, output: JSON.stringify(result.items, null, 2).replaceAll(worktree, "/workspace") }
                }
                case "incomingCalls": {
                  const result = yield* agent.incomingCalls(sid, file, instance.directory, args.line - 1, args.character - 1).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.calls.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No incoming calls found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.calls }, output: JSON.stringify(result.calls, null, 2).replaceAll(worktree, "/workspace") }
                }
                case "outgoingCalls": {
                  const result = yield* agent.outgoingCalls(sid, file, instance.directory, args.line - 1, args.character - 1).pipe(
                    Effect.catchCause(() => Effect.succeed(null)),
                  )
                  if (!result || result.calls.length === 0) {
                    return { title: sandboxTitle, metadata: { result: [] }, output: "No outgoing calls found." }
                  }
                  const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
                  return { title: sandboxTitle, metadata: { result: result.calls }, output: JSON.stringify(result.calls, null, 2).replaceAll(worktree, "/workspace") }
                }
                default:
                  return { title: sandboxTitle, metadata: { result: [] }, output: `${args.operation} is not yet supported in sandbox mode.` }
              }
            }
          }

          // ── Local branch ──
          const uri = pathToFileURL(file).href
          const position = { file, line: args.line - 1, character: args.character - 1 }
          const relPath = path.relative(instance.worktree, file)
          const detail =
            args.operation === "workspaceSymbol"
              ? ""
              : args.operation === "documentSymbol"
                ? relPath
                : `${relPath}:${args.line}:${args.character}`
          const title = detail ? `${args.operation} ${detail}` : args.operation

          const exists = yield* fs.existsSafe(file)
          if (!exists) throw new Error(`File not found: ${displayPath}`)

          const available = yield* lsp.hasClients(file)
          if (!available) throw new Error("No LSP server available for this file type.")

          yield* lsp.touchFile(file, "document")

          const result: unknown[] = yield* (() => {
            switch (args.operation) {
              case "goToDefinition":
                return lsp.definition(position)
              case "findReferences":
                return lsp.references(position)
              case "hover":
                return lsp.hover(position)
              case "documentSymbol":
                return lsp.documentSymbol(uri)
              case "workspaceSymbol":
                return lsp.workspaceSymbol(args.query ?? "")
              case "goToImplementation":
                return lsp.implementation(position)
              case "prepareCallHierarchy":
                return lsp.prepareCallHierarchy(position)
              case "incomingCalls":
                return lsp.incomingCalls(position)
              case "outgoingCalls":
                return lsp.outgoingCalls(position)
            }
          })()

          const worktree = instance.worktree === "/" ? instance.directory : instance.worktree
          const mappedOutput = result.length === 0
            ? `No results found for ${args.operation}`
            : JSON.stringify(result, null, 2).replaceAll(worktree, "/workspace")
          return {
            title,
            metadata: { result },
            output: mappedOutput,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
