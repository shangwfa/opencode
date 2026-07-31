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
const MAX_READ_BYTES_LABEL = `${MAX_READ_BYTES / 1024} KB`
const FILE_OP_TIMEOUT = Duration.seconds(60)

export const Parameters = Schema.Struct({
  filePath: Schema.String.annotate({ description: "The absolute path to the file or directory to read" }),
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

      // [fix 2] Use getFileInfo to determine directory vs file *before* attempting
      // readBytes — readBytes on a directory throws a socket error that corrupts
      // the sandbox connection state.
      const info = yield* Effect.tryPromise({
        try: async () => (await sb.files.getFileInfo([sandboxPath]))[sandboxPath],
        catch: () => undefined,
      })

      const isDirectory = typeof info?.mode === "number" && (info.mode & 0o170000) === 0o040000

      yield* assertExternalDirectoryEffect(ctx, filepath, {
        bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
        kind: isDirectory ? "directory" : "file",
        managed: true,
      })

      yield* ctx.ask({
        permission: "read",
        patterns: [path.relative(instance.directory, filepath)],
        always: ["*"],
        metadata: {},
      })

      if (!info) {
        // [fix 3] Suggest similar filenames when the requested path doesn't exist.
        const dir = path.posix.dirname(sandboxPath)
        const base = path.posix.basename(sandboxPath).toLowerCase()
        const lsResult = yield* sandboxProvider
          .runInSession(ctx.sandboxSessionID ?? ctx.sessionID, `ls -1 ${shellQuote(dir)} 2>/dev/null`, {
            timeoutSeconds: 5,
          })
          .pipe(
            Effect.catchCause(() =>
              Effect.succeed({ logs: { stdout: [] as { text: string }[] }, exitCode: 1 }),
            ),
          )
        const matches = lsResult.logs.stdout
          .map((line) => line.text)
          .filter((name) => name.toLowerCase().includes(base) || base.includes(name.toLowerCase()))
          .slice(0, 3)
        if (matches.length > 0) {
          return yield* Effect.fail(
            new Error(`File not found: ${sandboxPath}\n\nDid you mean one of these?\n${matches.join("\n")}`),
          )
        }
        return yield* Effect.fail(new Error(`File not found: ${sandboxPath}`))
      }

      // [fix 2] Directory path: list contents directly via shell, skip readBytes entirely.
      if (isDirectory) {
        const quoted = shellQuote(sandboxPath)
        const lsResult = yield* sandboxProvider
          .runInSession(
            ctx.sandboxSessionID ?? ctx.sessionID,
            `if [ -d ${quoted} ]; then for entry in ${quoted}/* ${quoted}/.[!.]* ${quoted}/..?*; do [ -e "$entry" ] || continue; name="\${entry##*/}"; if [ -d "$entry" ]; then printf '%s/\\n' "$name"; else printf '%s\\n' "$name"; fi; done; else exit 2; fi`,
            { timeoutSeconds: 10 },
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.fail(
                new Error(
                  `Failed to list directory ${sandboxPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
                ),
              ),
            ),
          )
        if (lsResult.exitCode === 2) return yield* Effect.fail(new Error(`Cannot read file: ${sandboxPath}`))
        if (lsResult.exitCode !== 0)
          return yield* Effect.fail(new Error(`Failed to list directory ${sandboxPath} (exit ${lsResult.exitCode})`))
        const allItems = (
          lsResult.logs.stdout
            .map((line) => line.text)
            .join("\n")
            .trim() || ""
        )
          .split("\n")
          .filter((s: string) => s.length > 0)
          .sort((a: string, b: string) => a.localeCompare(b))

        // [fix 4] Directory listing pagination (offset/limit).
        const dirOffset = params.offset ?? 1
        const dirLimit = params.limit ?? DEFAULT_READ_LIMIT
        const dirStart = dirOffset - 1
        const sliced = allItems.slice(dirStart, dirStart + dirLimit)
        const dirTruncated = dirStart + sliced.length < allItems.length

        let output = [`<path>${sandboxPath}</path>`, `<type>directory</type>`, "<contents>"].join("\n")
        output += "\n" + sliced.map((item: string) => `- ${item}`).join("\n")
        if (dirTruncated)
          output += `\n\n(Showing ${sliced.length} of ${allItems.length} entries. Use offset=${dirOffset + sliced.length} to continue.)`
        else output += `\n\n(${allItems.length} entries)`
        output += "\n</contents>"

        return {
          title,
          output,
          metadata: { count: allItems.length, truncated: dirTruncated },
        }
      }

      // File path: read header bytes for classification.
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
        const last = start + page.lines.length
        const next = page.next
        if (page.byteCapped)
          output += `\n\n(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${start + 1}-${last}. Use offset=${next} to continue.)`
        else if (next)
          output += `\n\n(Showing lines ${start + 1}-${last} of ${page.total}. Use offset=${next} to continue.)`
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
            truncated: page.byteCapped || next !== undefined,
            loaded: loaded.map((item) => item.filepath),
          },
        }
      }

      return yield* Effect.fail(new Error(`Cannot read file: ${sandboxPath}`))
    })

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        run(params, ctx) as any,
    }
  }),
)

async function readTextPage(stream: AsyncIterable<Uint8Array>, offset: number, limit: number) {
  // Use non-fatal TextDecoder so files with occasional bad bytes are still
  // readable — the bad byte becomes U+FFFD instead of throwing.
  const decoder = new TextDecoder("utf-8", { fatal: false })
  const lines: string[] = []
  let pending = ""
  let total = 0
  let outputBytes = 0
  let sourceBytes = 0
  // byteCapped: output exceeded MAX_READ_BYTES → break immediately (like upstream ReadStop)
  // hasMore: line-count limit reached but stream continues to count total lines
  let byteCapped = false

  const append = (line: string) => {
    total++
    if (total < offset || byteCapped) return
    if (lines.length >= limit) return
    const text = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line
    const size = Buffer.byteLength(text, "utf-8") + (lines.length > 0 ? 1 : 0)
    if (outputBytes + size > MAX_READ_BYTES) {
      byteCapped = true
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
      // Byte cap reached → stop reading the stream immediately, like upstream's
      // ReadStop tagged error. Unlike line-count limit (where we keep reading to
      // get an accurate total), byte cap means we don't care about the total.
      if (byteCapped) return
    }
  }

  for await (const chunk of stream) {
    sourceBytes += chunk.length
    if (chunk.includes(0)) throw new BinaryContentError()
    consume(decoder.decode(chunk, { stream: true }))
    if (byteCapped) break
  }
  if (!byteCapped) consume(decoder.decode())
  if (pending && !byteCapped) append(pending.endsWith("\r") ? pending.slice(0, -1) : pending)
  if (offset > Math.max(total, 1)) throw new Error(`Offset ${offset} is out of range for this file (${total} lines)`)
  const hasMore = byteCapped || total > offset - 1 + lines.length
  const next = hasMore ? offset + lines.length : undefined
  return { lines, total, sourceBytes, next, byteCapped, hasMore }
}

class BinaryContentError extends Error {}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
