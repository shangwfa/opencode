import { Schema } from "effect"
import * as path from "path"
import { Effect } from "effect"
import * as Tool from "./tool"
import { createTwoFilesPatch } from "diff"
import DESCRIPTION from "./write.txt"
import { Bus } from "../bus"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { InstanceState } from "@/effect/instance-state"
import { trimDiff } from "./edit"
import { assertExternalDirectoryEffect } from "./external-directory"
import { toSandboxPath } from "./sandbox-path"
import * as Log from "@opencode-ai/core/util/log"

const writeLog = Log.create({ service: "write-tool" })

export const Parameters = Schema.Struct({
  content: Schema.String.annotate({ description: "The content to write to the file" }),
  filePath: Schema.String.annotate({
    description: "The absolute path to the file to write (must be absolute, not relative)",
  }),
})

export const WriteTool = Tool.define(
  "write",
  Effect.gen(function* () {
    const bus = yield* Bus.Service

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
            patterns: [path.relative(instance.directory, filepath)],
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

          yield* bus.publish(File.Event.Edited, { file: filepath })
          yield* bus.publish(FileWatcher.Event.Updated, { file: filepath, event: contentOld ? "change" : "add" })

          return {
            title: path.relative(instance.worktree, filepath),
            metadata: { diagnostics: {}, filepath, exists: !!contentOld },
            output: "Wrote file successfully.",
          }
        }).pipe(Effect.orDie),
    }
  }),
)
