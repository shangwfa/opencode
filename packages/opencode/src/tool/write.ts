import { Duration, Effect, Option, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import { toSandboxPath, toHostPath } from "./sandbox-path"
import * as Log from "@opencode-ai/core/util/log"
import { SandboxProvider } from "./sandbox-provider"
import { LSP } from "@/lsp/lsp"
import * as LSPClient from "@/lsp/client"
import { Agent as LspAgent } from "@/lsp/agent"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { Sandbox } from "@alibaba-group/opensandbox"

const writeLog = Log.create({ service: "write-tool" })
const FILE_WRITE_TIMEOUT = Duration.seconds(60)
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
    const events = yield* EventV2Bridge.Service

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
          const sandboxPath = toSandboxPath(filepath, instance.directory)

          const maybeSandbox = ctx.sandbox ? (yield* Effect.promise(() => ctx.sandbox!)) as Sandbox | null : null
          if (maybeSandbox === null && ctx.sandbox) {
            return yield* Effect.fail(new Error("Sandbox initialization failed"))
          }
          if (!maybeSandbox) {
            return yield* Effect.fail(new Error("Sandbox is not available"))
          }

          const contentOld = (yield* Effect.tryPromise(() => maybeSandbox.files.readFile(sandboxPath)).pipe(
            Effect.timeoutOrElse({
              duration: FILE_WRITE_TIMEOUT,
              orElse: () => Effect.succeed(""),
            }),
            Effect.catch(() => Effect.succeed("")),
          )) as string

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, params.content))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.directory, filepath)],
            always: ["*"],
            metadata: { filepath, diff },
          })

          yield* Effect.tryPromise(() => maybeSandbox.files.writeFiles([{ path: sandboxPath, data: params.content }])).pipe(
            Effect.catch((error) => {
              writeLog.warn("writeFiles failed, retrying once", { sandboxPath, error: error.message })
              return Effect.tryPromise(() => maybeSandbox.files.writeFiles([{ path: sandboxPath, data: params.content }]))
            }),
            Effect.timeoutOrElse({
              duration: FILE_WRITE_TIMEOUT,
              orElse: () =>
                Effect.gen(function* () {
                  const sandboxProvider = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
                  if (sandboxProvider) {
                    yield* sandboxProvider.destroy(ctx.sandboxSessionID ?? ctx.sessionID).pipe(Effect.catchCause(() => Effect.void))
                  }
                  return yield* Effect.fail(new Error(`Write timed out: ${sandboxPath}`))
                }),
            }),
          )

          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: contentOld ? "change" : "add" })

          let output = "Wrote file successfully."
          const agentOpt = yield* Effect.serviceOption(LspAgent.Service)
          if (agentOpt._tag === "Some") {
            const sid = ctx.sandboxSessionID ?? ctx.sessionID
            const result = yield* agentOpt.value.diagnostics(sid, filepath, instance.directory).pipe(
              Effect.catchCause(() => Effect.succeed(null)),
            )
            if (result) {
              const diagnostics: Record<string, LSPClient.Diagnostic[]> = {}
              for (const [sp, diags] of Object.entries(result.diagnostics)) {
                const hp = toHostPath(sp, instance.directory)
                diagnostics[FSUtil.normalizePath(hp)] = diags as LSPClient.Diagnostic[]
              }
              const normalizedFilePath = FSUtil.normalizePath(filepath)
              let projectDiagnosticsCount = 0
              for (const [file, issues] of Object.entries(diagnostics)) {
                const current = file === normalizedFilePath
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
            metadata: { filepath, exists: !!contentOld },
            output,
          }
        }).pipe(Effect.orDie) as any, // TODO: Tool Init type mismatch (LSP diagnostics R=HttpClient)
    }
  }),
)
