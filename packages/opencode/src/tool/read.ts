import { Duration, Effect, Option, Schema } from "effect"
import { PositiveInt } from "@opencode-ai/core/schema"
import * as path from "path"
import * as Tool from "./tool"
import DESCRIPTION from "./read.txt"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import { Instruction } from "../session/instruction"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"
import { ToolAttachment } from "./attachment"
import type { Sandbox } from "@alibaba-group/opensandbox"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`
const MAX_READ_BYTES = 50 * 1024
const FILE_OP_TIMEOUT = Duration.seconds(60)

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file to read" }),
  offset: Schema.optional(PositiveInt).annotate({
    description: "The line number to start reading from (1-indexed)",
  }),
  limit: Schema.optional(PositiveInt).annotate({
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
        return yield* Effect.fail(new Error("Execution environment is not available"))
      }

      const sb = maybeSandbox

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: "file",
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.directory, filepath)],
        always: ["*"],
        metadata: {},
      })

      const info = yield* Effect.tryPromise({
        try: async () => (await sb.files.getFileInfo([sandboxPath]))[sandboxPath],
        catch: () => undefined,
      })
      const header = yield* Effect.tryPromise({
        try: () => sb.files.readBytes(sandboxPath, { range: "bytes=0-65535" }),
        catch: () => undefined,
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

      if (header) {
        const kind = ToolAttachment.classify(sandboxPath, header)
        if (kind.type === "binary") return yield* Effect.fail(new Error(`Cannot read binary file: ${sandboxPath}`))
        if (kind.type === "image" || kind.type === "pdf" || kind.type === "office") {
          const attachment = yield* ToolAttachment.store({
            sandbox: sb,
            sessionID: ctx.sessionID,
            sourcePath: sandboxPath,
            filename: path.posix.basename(sandboxPath),
            mime: kind.mime,
            size: info?.size,
            audience: kind.type === "office" ? "display-only" : "model-and-display",
          })
          const label = kind.type === "image" ? "Image" : kind.type === "pdf" ? "PDF" : "Document"
          return {
            title,
            output:
              kind.type === "office"
                ? "Document read successfully. Text extraction is not available for this format."
                : `${label} read successfully`,
            metadata: {
              kind: kind.type,
              mime: kind.mime,
              size: attachment.metadata.size,
              truncated: false,
              ...(kind.type === "office" ? { textExtracted: false } : {}),
            },
            attachments: [
              {
                type: "file" as const,
                mime: kind.mime,
                filename: attachment.metadata.filename,
                url: attachment.url,
              },
            ],
          }
        }

        const start = (params.offset ?? 1) - 1
        const limit = params.limit ?? DEFAULT_READ_LIMIT
        const page = yield* Effect.tryPromise({
          try: () => readTextPage(sb.files.readBytesStream(sandboxPath), start + 1, limit),
          catch: (cause) => {
            if (cause instanceof BinaryContentError) return new Error(`Cannot read binary file: ${sandboxPath}`)
            if (cause instanceof TypeError) return new Error(`File is not valid UTF-8: ${sandboxPath}`)
            return new Error(cause instanceof Error ? cause.message : String(cause))
          },
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
        const loaded = yield* instruction.resolve(ctx.messages, filepath, ctx.messageID)

        let output = [`<path>${sandboxPath}</path>`, `<type>file</type>`, "<content>\n"].join("\n")
        output += page.lines.map((line, i) => `${i + start + 1}: ${line}`).join("\n")
        if (page.next)
          output += `\n\n(Showing lines ${start + 1}-${start + page.lines.length} of ${page.total}. Use offset=${page.next} to continue.)`
        else output += `\n\n(End of file - total ${page.total} lines)`
        output += "\n</content>"

        if (loaded.length > 0) {
          output += `\n\n<system-reminder>\n${loaded.map((item) => item.content).join("\n\n")}\n</system-reminder>`
        }

        return {
          title,
          output,
          metadata: {
            kind: kind.type,
            mime: kind.mime,
            size: info?.size ?? page.sourceBytes,
            preview: page.lines.slice(0, 20).join("\n"),
            truncated: page.next !== undefined,
            loaded: loaded.map((item) => item.filepath),
          },
        }
      }

      if (info) {
        const quoted = shellQuote(sandboxPath)
        const lsResult = yield* sandboxProvider.runInSession(
          ctx.sandboxSessionID ?? ctx.sessionID,
          `if [ -d ${quoted} ]; then for entry in ${quoted}/* ${quoted}/.[!.]* ${quoted}/..?*; do [ -e "$entry" ] || continue; name="\${entry##*/}"; if [ -d "$entry" ]; then printf '%s/\\n' "$name"; else printf '%s\\n' "$name"; fi; done; else exit 2; fi`,
          { timeoutSeconds: 10 },
        )
        if (lsResult.exitCode !== 0) return yield* Effect.fail(new Error(`Cannot read file: ${sandboxPath}`))
        const items = (
          lsResult.logs.stdout
            .map((line) => line.text)
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

async function readTextPage(stream: AsyncIterable<Uint8Array>, offset: number, limit: number) {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  const lines: string[] = []
  let pending = ""
  let total = 0
  let outputBytes = 0
  let sourceBytes = 0
  let byteLimitReached = false

  const append = (line: string) => {
    total++
    if (total < offset || lines.length >= limit || byteLimitReached) return
    const text = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line
    const size = Buffer.byteLength(text, "utf-8") + (lines.length > 0 ? 1 : 0)
    if (outputBytes + size > MAX_READ_BYTES) {
      byteLimitReached = true
      return
    }
    lines.push(text)
    outputBytes += size
  }
  const consume = (text: string) => {
    pending += text
    while (true) {
      const newline = pending.indexOf("\n")
      if (newline === -1) return
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      append(line.endsWith("\r") ? line.slice(0, -1) : line)
    }
  }

  for await (const chunk of stream) {
    sourceBytes += chunk.length
    if (chunk.includes(0)) throw new BinaryContentError()
    consume(decoder.decode(chunk, { stream: true }))
  }
  consume(decoder.decode())
  if (pending) append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
  if (offset > Math.max(total, 1)) throw new Error(`Offset ${offset} is out of range for this file (${total} lines)`)
  const next = total > offset - 1 + lines.length ? offset + lines.length : undefined
  return { lines, total, sourceBytes, next }
}

class BinaryContentError extends Error {}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
