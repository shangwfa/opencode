import { Duration, Effect, Option, Schema } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"
import { isImageAttachment, sniffAttachmentMime } from "@/util/media"
import type { Sandbox } from "@alibaba-group/opensandbox"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const FILE_OP_TIMEOUT = Duration.seconds(60)

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to read" }),
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
    const sandboxProvider = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))

    const run = Effect.fn("ReadTool.execute")(function* (
      params: Schema.Schema.Type<typeof Parameters>,
      ctx: Tool.Context,
    ) {
      const instance = yield* InstanceState.context
      let filepath = params.filePath
      if (!path.isAbsolute(filepath)) {
        filepath = path.resolve(instance.directory, filepath)
      }
      const title = path.relative(instance.worktree, filepath)

      const sandboxPath = toSandboxPath(filepath, instance.directory)

      const maybeSandbox = ctx.sandbox ? ((yield* Effect.promise(() => ctx.sandbox!)) as Sandbox | null) : null
      if (!maybeSandbox || !sandboxProvider) {
        return yield* Effect.fail(new Error("Sandbox is not available"))
      }

      const sb = maybeSandbox

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: "file",
        managed: true,
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.directory, filepath)],
        always: ["*"],
        metadata: {},
      })

      const fileContent = yield* Effect.promise(async () => {
        try {
          return await sb.files.readFile(sandboxPath)
        } catch {
          return null
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: FILE_OP_TIMEOUT,
          orElse: () =>
            sandboxProvider.destroy(ctx.sandboxSessionID ?? ctx.sessionID).pipe(
              Effect.catchCause(() => Effect.void),
              Effect.andThen(Effect.fail(new Error(`Read timed out: ${sandboxPath}`))),
            ),
        }),
      )

      if (fileContent) {
        const content = fileContent as string
        const bytes = Buffer.from(content, "binary")
        const mime = sniffAttachmentMime(bytes, "")

        if (isImageAttachment(mime)) {
          const base64Content = bytes.toString("base64")
          return {
            title,
            output: "Image read successfully",
            metadata: {},
            attachments: [
              {
                type: "file" as const,
                mime,
                url: `data:${mime};base64,${base64Content}`,
              },
            ],
          }
        }

        const allLines = content.split("\n")
        const start = (params.offset ?? 1) - 1
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const selected = allLines.slice(start, start + limit)
        const truncated = start + selected.length < allLines.length
        const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)

        let output = [`<path>${sandboxPath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
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

        if (loaded.length > 0) {
          output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
        }

        return {
          title,
          output,
          metadata: {
            preview: selected.slice(0, 20).join("\n"),
            truncated,
            loaded: loaded.map((item) => item.filepath),
          },
        }
      }

      // readFile failed — confirm via getFileInfo whether path is a directory.
      const infoResult = yield* Effect.promise(async () => {
        try {
          const result = await sb.files.getFileInfo([sandboxPath])
          return result[sandboxPath] ?? null
        } catch {
          return null
        }
      })

      if (infoResult) {
        // Path exists but readFile failed → it's a directory. List contents.
        const lsResult = yield* sandboxProvider
          .runInSession(ctx.sandboxSessionID ?? ctx.sessionID, `ls -1 "${sandboxPath}"`, { timeoutSeconds: 10 })
          .pipe(Effect.catch(() => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 1 } as any)))
        const items = (
          (lsResult as any).logs?.stdout
            ?.map((l: { text: string }) => l.text)
            .join("\n")
            .trim() || ""
        )
          .split("\n")
          .filter((s: string) => s.length > 0)
          .sort((a: string, b: string) => a.localeCompare(b))

        let output = [`<path>${sandboxPath}</path>`, `<type>directory</type>`, "<contents>"].join("\n")
        output += "\n" + items.map((item: string) => `- ${item}`).join("\n")
        output += "\n</contents>"

        return {
          title,
          output,
          metadata: { count: items.length },
        }
      }

      return yield* Effect.fail(new Error(`File not found: ${sandboxPath}`))
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx).pipe(Effect.orDie) as any, // TODO: Tool Init type mismatch
    }
  }),
)
