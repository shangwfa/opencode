import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL, fileURLToPath } from "node:url"
import ts from "typescript"
import type { Tool } from "@opencode/schema/tool"
import { hash, versionHash, HostError } from "../tool-host-protocol"

const acks = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
const controllers = new Map<string, AbortController>()
const send = (frame: unknown) => process.send?.(frame)
const runtime = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "session-tool-runtime.mjs")).href
// User modules and the executor must share one Effect runtime (codec sentinel identity).
const { Effect, SessionTool, definition, execute, isToolDefinition, toToolInfo }: typeof import("./runtime") =
  await import(runtime)
let info: ReturnType<typeof toToolInfo> | undefined
process.on("SIGTERM", () => {
  for (const controller of controllers.values()) controller.abort()
  for (const ack of acks.values()) ack.reject(new Error("Tool worker interrupted"))
  acks.clear()
  setImmediate(() => process.exit(0))
})

process.on("message", async (raw) => {
  const message = raw as Record<string, any>
  try {
    if (message.type === "ack") {
      const ack = acks.get(message.progressID)
      acks.delete(message.progressID)
      if (message.error) ack?.reject(new Error(message.error))
      else ack?.resolve()
      return
    }
    if (message.type === "load") {
      const source = await fs.readFile(message.sourcePath, "utf8")
      if (versionHash(source) !== message.versionHash) throw new Error("source hash mismatch")
      const output = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        transformers: {
          before: [
            (context) => (root) => {
              const visit: ts.Visitor = (node) => {
                if (
                  ts.isImportDeclaration(node) &&
                  ts.isStringLiteral(node.moduleSpecifier) &&
                  ["effect", "@opencode-ai/plugin", "@opencode/plugin"].includes(node.moduleSpecifier.text)
                ) {
                  return context.factory.updateImportDeclaration(
                    node,
                    node.modifiers,
                    node.importClause,
                    context.factory.createStringLiteral(runtime),
                    node.attributes,
                  )
                }
                return ts.visitEachChild(node, visit, context)
              }
              return ts.visitNode(root, visit) as ts.SourceFile
            },
          ],
        },
      })
      const file = path.join(path.dirname(message.sourcePath), `module-${hash(output.outputText)}.mjs`)
      await fs.writeFile(file, output.outputText)
      const module = await import(pathToFileURL(file).href)
      if (!isToolDefinition(module.default)) throw new HostError("source-invalid", "invalid tool export")
      info = toToolInfo(SessionTool.Name.make("session-tool"), module.default, process.cwd())
      const catalog = (() => {
        try {
          return definition(info)
        } catch (error) {
          throw new HostError("unsupported-schema", error instanceof Error ? error.message : String(error))
        }
      })()
      const manifest = {
        versionHash: message.versionHash,
        description: catalog.description,
        inputSchema: catalog.inputSchema,
        outputSchema: catalog.outputSchema,
      }
      send({ type: "manifest", manifest: { ...manifest, manifestHash: hash(JSON.stringify(manifest)) } })
      return
    }
    if (message.type !== "execute" || !info) throw new Error("worker not ready")
    const controller = new AbortController()
    controllers.set(message.executionID, controller)
    const toolContext = {
      ...message.context,
      signal: controller.signal,
      progress: (update: Tool.Metadata) =>
        Effect.tryPromise({
          try: () =>
            new Promise<void>((resolve, reject) => {
              const progressID = crypto.randomUUID()
              acks.set(progressID, { resolve, reject })
              send({ type: "progress", executionID: message.executionID, progressID, update })
            }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        }),
    }
    const result = await Effect.runPromise(execute(info, message.args, toolContext))
    // Validate before IPC so cyclic/BigInt output becomes a terminal error rather than a hanging call.
    try {
      JSON.stringify(result)
    } catch (error) {
      throw new HostError("serialization-failed", error instanceof Error ? error.message : String(error))
    }
    send({ type: "result", executionID: message.executionID, result })
  } catch (error) {
    send({
      type: "error",
      executionID: message.executionID,
      ...(error instanceof HostError ? { code: error.code } : {}),
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    if (typeof message.executionID === "string") controllers.delete(message.executionID)
  }
})
