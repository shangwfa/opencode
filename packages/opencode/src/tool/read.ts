import { Effect, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { Reference } from "@/reference/reference"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"
import type { Sandbox } from "@alibaba-group/opensandbox"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
  offset: Schema.optional(NonNegativeInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(NonNegativeInt).annotate({
    description: "The maximum number of lines to read (defaults to 2000)",
  }),
})

export const ReadTool = Tool.define(
  "read",
  Effect.gen(function* () {
    const instruction = yield* Instruction.Service
    const reference = yield* Reference.Service
    const sandboxProvider = yield* SandboxProvider.Service

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      yield* reference.ensure(filepath)
      const title = path.relative(instance.worktree, filepath)

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]) || (yield* reference.contains(filepath)),
        kind: "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.worktree, filepath)],
        always: ["*"],
        metadata: {},
      })

      const sb = (yield* Effect.tryPromise({
        try: () => ctx.sandbox!,
        catch: (e) => new Error(`Initialization failed: ${e instanceof Error ? e.message : String(e)}`),
      }).pipe(Effect.orDie)) as unknown as Sandbox
      const sandboxPath = toSandboxPath(filepath, instance.directory)

      const dirCheck = yield* sandboxProvider.runInSession(
        ctx.sessionID,
        `test -d "${sandboxPath}" && echo "DIR" || echo "FILE"`,
        { timeoutSeconds: 5 },
      ).pipe(Effect.catch(() => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 1 } as any)))
      const isDirOutput = (dirCheck as any).logs?.stdout?.map((l: { text: string }) => l.text).join("").trim()
      const isDirectory = isDirOutput.includes("DIR")

      if (isDirectory) {
        const lsResult = yield* sandboxProvider.runInSession(
          ctx.sessionID,
          `ls -1 "${sandboxPath}"`,
          { timeoutSeconds: 10 },
        ).pipe(Effect.catch(() => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 1 } as any)))
        const items = ((lsResult as any).logs?.stdout ?? [])
          .map((l: { text: string }) => l.text.trim())
          .filter(Boolean)
          .sort()
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const offset = params.offset || 1
        const start = offset - 1
        const sliced = items.slice(start, start + limit)
        const truncated = start + sliced.length < items.length

        return {
          title,
          output: [
            `<path>${filepath}</path>`,
            `<type>directory</type>`,
            `<entries>`,
            sliced.join("\n"),
            truncated
              ? `\n(Showing ${sliced.length} of ${items.length} entries)`
              : `\n(${items.length} entries)`,
            `</entries>`,
          ].join("\n"),
          metadata: { preview: sliced.slice(0, 20).join("\n"), truncated, loaded: [] as string[] },
        }
      }

      const content = yield* Effect.tryPromise({
        try: () => sb.files.readFile(sandboxPath),
        catch: () => new Error(`File not found: ${filepath}`),
      })
      const allLines = (content as string).split("\n")
      const start = (params.offset ?? 1) - 1
      const limit = params.limit ?? DEFAULT_READ_LIMIT
      const selected = allLines.slice(start, start + limit)
      const truncated = start + selected.length < allLines.length
      const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)

      let output = [`<path>${filepath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
      output += selected
        .map(
          (line, i) =>
            `${i + start + 1}: ${line.length > MAX_LINE_LENGTH ? line.substring(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line}`,
        )
        .join("\n")
      if (truncated)
        output += `\n\n(Showing lines ${start + 1}-${start + selected.length} of ${allLines.length}. Use offset=${start + selected.length + 1} to continue.)`
      else output += `\n\n(End of file - total ${allLines.length} lines)`
      output += "\n</content>"
      if (loaded.length > 0)
        output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`

      return {
        title,
        output,
        metadata: {
          preview: selected.slice(0, 20).join("\n"),
          truncated,
          loaded: loaded.map((item) => item.filepath),
        },
      }
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie),
    }
  }),
)
