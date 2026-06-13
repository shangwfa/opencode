import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { LSP } from "@/lsp/lsp"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import * as Bom from "@/util/bom"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"
import { Agent as LspAgent } from "@/lsp/agent"
import * as LSPClient from "@/lsp/client"
import { toHostPath } from "./sandbox-path"

const writeLog = {
  warn(msg: string, data?: Record<string, unknown>) { console.warn(`[write-tool] ${msg}`, data ?? "") },
}

const MAX_PROJECT_DIAGNOSTICS_FILES = 5

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const fs = yield* FSUtil.Service
    const events = yield* EventV2Bridge.Service
    const format = yield* Format.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { content: string; filePath: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const filepath = path.isAbsolute(params.filePath)
            ? params.filePath
            : path.join(instance.directory, params.filePath)
          yield* assertExternalDirectoryEffect(ctx, filepath)

          // Sandbox branch: if a sandbox is available, write through it
          const sandboxProviderOpt = yield* Effect.serviceOption(SandboxProvider.Service)
          if (sandboxProviderOpt._tag === "Some") {
            const sb: any = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(`Failed to initialize: ${e instanceof Error ? e.message : String(e)}`) })
            const sandboxPath = toSandboxPath(filepath, instance.directory)

            let contentOld = ""
            const readResult = yield* Effect.tryPromise(() => sb.files.readFile(sandboxPath)).pipe(
              Effect.catch(() => Effect.succeed("")),
            )
            contentOld = readResult as string

            const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
            yield* ctx.ask({
              permission: "edit",
              patterns: [path.relative(instance.worktree, filepath)],
              always: ["*"],
              metadata: { filepath, diff },
            })

            yield* Effect.tryPromise({
              try: () => sb.files.writeFiles([{ path: sandboxPath, data: params.content }]),
              catch: (e) => {
                const msg = e instanceof Error ? e.message : String(e)
                writeLog.warn("writeFiles failed, retrying once", { sandboxPath, error: msg })
                return sb.files.writeFiles([{ path: sandboxPath, data: params.content }])
              },
            })

            yield* events.publish(FileSystem.Event.Edited, { file: filepath })
            yield* events.publish(Watcher.Event.Updated, { file: filepath, event: contentOld ? "change" : "add" })

            let output = "Wrote file successfully."
            const diagnostics: Record<string, LSPClient.Diagnostic[]> = {}
            const agentOpt = yield* Effect.serviceOption(LspAgent.Service)
            if (agentOpt._tag === "Some") {
              const sid = ctx.sandboxSessionID ?? ctx.sessionID
              yield* agentOpt.value.touch(sid, filepath, instance.directory).pipe(
                Effect.catchCause(() => Effect.void),
              )
              const result = yield* agentOpt.value.diagnostics(sid, filepath, instance.directory).pipe(
                Effect.catchCause(() => Effect.succeed(null)),
              )
              if (result) {
                for (const [sandboxPath, diags] of Object.entries(result.diagnostics)) {
                  const hostPath = toHostPath(sandboxPath, instance.directory)
                  const normalizedFilepath = FSUtil.normalizePath(hostPath)
                  diagnostics[normalizedFilepath] = diags as LSPClient.Diagnostic[]
                }
                const normalizedFilepath = FSUtil.normalizePath(filepath)
                let projectDiagnosticsCount = 0
                for (const [file, issues] of Object.entries(diagnostics)) {
                  const current = file === normalizedFilepath
                  if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
                  const block = LSP.Diagnostic.report(current ? filepath : file, issues)
                  if (!block) continue
                  if (current) {
                    output += `\n\nLSP errors detected in this file, please fix:\n${block}`
                    continue
                  }
                  projectDiagnosticsCount++
                  output += `\n\nLSP errors detected in other files:\n${block}`
                }
              }
            }

            return {
              title: path.relative(instance.worktree, filepath),
              metadata: { diagnostics, filepath, exists: !!contentOld },
              output,
            }
          }

          const exists = yield* fs.existsSafe(filepath)
          const source = exists ? yield* Bom.readFile(fs, filepath) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.worktree, filepath)],
            always: ["*"],
            metadata: {
              filepath,
              diff,
            },
          })

          yield* fs.writeWithDirs(filepath, Bom.join(contentNew, desiredBom))
          if (yield* format.file(filepath)) {
            yield* Bom.syncFile(fs, filepath, desiredBom)
          }
          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, {
            file: filepath,
            event: exists ? "change" : "add",
          })

          let output = "Wrote file successfully."
          yield* lsp.touchFile(filepath, "document")
          const diagnostics = yield* lsp.diagnostics()
          const normalizedFilepath = FSUtil.normalizePath(filepath)
          let projectDiagnosticsCount = 0
          for (const [file, issues] of Object.entries(diagnostics)) {
            const current = file === normalizedFilepath
            if (!current && projectDiagnosticsCount >= MAX_PROJECT_DIAGNOSTICS_FILES) continue
            const block = LSP.Diagnostic.report(current ? filepath : file, issues)
            if (!block) continue
            if (current) {
              output += `\n\nLSP errors detected in this file, please fix:\n${block}`
              continue
            }
            projectDiagnosticsCount++
            output += `\n\nLSP errors detected in other files:\n${block}`
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: {
              diagnostics,
              filepath,
              exists: exists,
            },
            output,
          }
        }).pipe(Effect.orDie),
    }
  }),
)
