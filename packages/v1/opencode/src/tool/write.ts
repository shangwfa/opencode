import { Duration, Effect, Option, Schema } from "effect"
import * as path from "path"
import * as Tool from "./tool"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { EventV2Bridge } from "@/event-v2-bridge"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Watcher } from "@opencode-ai/core/filesystem/watcher"
import { Format } from "../format"
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
import * as Bom from "@/util/bom"
import { SandboxApiException, type Sandbox } from "@alibaba-group/opensandbox"

const writeLog = Log.create({ service: "write-tool" })
const FILE_WRITE_TIMEOUT = Duration.seconds(60)
const FORMAT_TIMEOUT_SECONDS = 60
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
    const fs = yield* FSUtil.Service
    const lsp = Option.getOrUndefined(yield* Effect.serviceOption(LSP.Service))
    const format = Option.getOrUndefined(yield* Effect.serviceOption(Format.Service))

    const reportDiagnostics = (
      filepath: string,
      diagnostics: Record<string, LSPClient.Diagnostic[]>,
      output: string,
    ) => {
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
      return output
    }

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

          const maybeSandbox = ctx.sandbox ? ((yield* Effect.promise(() => ctx.sandbox!)) as Sandbox | null) : null
          if (maybeSandbox === null && ctx.sandbox) {
            return yield* Effect.fail(new Error("Initialization failed"))
          }

          if (!maybeSandbox) {
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
            if (format && (yield* format.file(filepath))) {
              yield* Bom.syncFile(fs, filepath, desiredBom)
            }
            yield* events.publish(FileSystem.Event.Edited, { file: filepath })
            yield* events.publish(Watcher.Event.Updated, {
              file: filepath,
              event: exists ? "change" : "add",
            })

            let output = "Wrote file successfully."
            let diagnostics: Record<string, LSPClient.Diagnostic[]> = {}
            if (lsp) {
              yield* lsp.touchFile(filepath, "document")
              diagnostics = yield* lsp.diagnostics()
              output = reportDiagnostics(filepath, diagnostics, output)
            }

            return {
              title: path.relative(instance.worktree, filepath),
              metadata: {
                diagnostics,
                filepath,
                exists,
              },
              output,
            }
          }

          const sb = maybeSandbox
          const sandboxPath = toSandboxPath(filepath, instance.directory)

          const previous = yield* Effect.tryPromise({
            try: async () => ({ exists: true, raw: await (sb.files.readFile(sandboxPath) as Promise<string>) }),
            catch: (cause) => cause instanceof Error ? cause : new Error(String(cause)),
          }).pipe(
            Effect.catch((error) =>
              error instanceof SandboxApiException && error.statusCode === 404
                ? Effect.succeed({ exists: false, raw: "" })
                : Effect.fail(error),
            ),
            Effect.timeoutOrElse({
              duration: FILE_WRITE_TIMEOUT,
              orElse: () => Effect.fail(new Error(`Read before write timed out: ${sandboxPath}`)),
            }),
          )
          const exists = previous.exists
          const source = exists ? Bom.split(previous.raw) : { bom: false, text: "" }
          const next = Bom.split(params.content)
          const desiredBom = source.bom || next.bom
          const contentOld = source.text
          const contentNew = next.text

          const diff = trimDiff(createTwoFilesPatch(filepath, filepath, contentOld, contentNew))
          yield* ctx.ask({
            permission: "edit",
            patterns: [path.relative(instance.directory, filepath)],
            always: ["*"],
            metadata: { filepath, diff },
          })

          const data = Bom.join(contentNew, desiredBom)
          yield* Effect.tryPromise(() => sb.files.writeFiles([{ path: sandboxPath, data }])).pipe(
            Effect.catch((error) => {
              writeLog.warn("writeFiles failed, retrying once", { sandboxPath, error: error.message })
              return Effect.tryPromise(() => sb.files.writeFiles([{ path: sandboxPath, data }]))
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

          if (format) {
            const commands = yield* format.command(filepath).pipe(Effect.catch(() => Effect.succeed([] as string[][])))
            const sandboxProvider = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
            if (sandboxProvider && commands.length > 0) {
              // Formatting rewrites the file on disk before the tool returns,
              // so the published watcher event and diagnostics below describe
              // the final state. Run it synchronously; a background fork on a
              // tool-scoped fiber would be interrupted as soon as the tool
              // returns, silently skipping formatting.
              for (const cmd of commands) {
                const replaced = cmd.map((x) => x.replace("$FILE", sandboxPath))
                const shell = replaced.map((x) => `'${x.replaceAll("'", "'\\''")}'`).join(" ")
                yield* sandboxProvider
                  .runInSession(ctx.sandboxSessionID ?? ctx.sessionID, shell, {
                    timeoutSeconds: FORMAT_TIMEOUT_SECONDS,
                  })
                  .pipe(Effect.catchCause(() => Effect.void))
              }
            }
          }

          yield* events.publish(FileSystem.Event.Edited, { file: filepath })
          yield* events.publish(Watcher.Event.Updated, { file: filepath, event: exists ? "change" : "add" })

          let output = "Wrote file successfully."
          let diagnostics: Record<string, LSPClient.Diagnostic[]> = {}
          const agentOpt = yield* Effect.serviceOption(LspAgent.Service)
          if (agentOpt._tag === "Some") {
            const sid = ctx.sandboxSessionID ?? ctx.sessionID
            const result = yield* agentOpt.value.diagnostics(sid, filepath, instance.directory).pipe(
              Effect.catchCause(() => Effect.succeed(null)),
            )
            if (result) {
              for (const [sp, diags] of Object.entries(result.diagnostics)) {
                const hp = toHostPath(sp, instance.directory)
                diagnostics[FSUtil.normalizePath(hp)] = diags as LSPClient.Diagnostic[]
              }
              output = reportDiagnostics(filepath, diagnostics, output)
            }
          }

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: { diagnostics, filepath, exists },
            output,
          }
        }).pipe(Effect.orDie) as any, // TODO: Tool Init type mismatch (LSP diagnostics R=HttpClient)
    }
  }),
)
