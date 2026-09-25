export * as SandboxTools from "./tools.js"

import path from "path"
import { Effect } from "effect"
import { ToolFailure } from "@opencode/ai"
import { FileDiff } from "@opencode/schema/file-diff"
import type { Tool } from "@opencode/schema/tool"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { RelativePath } from "../schema.js"
import { SandboxProvider } from "./provider.js"
import { SandboxPath } from "./path.js"
import { ReadToolFileSystem } from "../tool/read-filesystem.js"
import { ToolAttachment } from "../tool/attachment.js"

/**
 * Sandbox-backed implementations for the file-oriented built-in tools. Each
 * function maps the tool input onto the sandbox `/workspace` mount, keeps the
 * canonical permission check, and returns the tool's declared output shape so
 * the plugin only branches on `provider.enabled`.
 */

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

// Mirrors host-side access.resolve containment: a request outside the
// sandbox workspace is a defect, never a silent fallback — the local
// FileSystem answers the same way ("Path escapes the location").
const resolve = (directory: string, requested?: string) =>
  Effect.gen(function* () {
    const sandboxPath = SandboxPath.toSandboxPath(path.resolve(directory, requested ?? "."), directory)
    if (!SandboxPath.isSandboxPath(sandboxPath))
      return yield* Effect.die(new Error(`Path escapes the location: ${requested ?? "."}`))
    return sandboxPath
  })

const relative = (sandboxPath: string, hostWorkdir: string) =>
  RelativePath.make(path.relative(hostWorkdir, SandboxPath.toHostPath(sandboxPath, hostWorkdir)) || ".")

export interface Deps {
  readonly provider: SandboxProvider.Interface
  readonly location: Location.Interface
  readonly permission: Permission.Interface
}

const exec = (deps: Deps, context: Tool.Context, command: string, timeoutMs: number) =>
  deps.provider.run({
    sessionID: context.sessionID,
    command,
    hostWorkdir: deps.location.directory,
    timeoutMs,
  })

// A sandbox image without ripgrep turns every rg pipeline into an empty result
// ("No matches found") and silently misleads the model into retrying. Probe
// once per session and surface the missing binary as an explicit tool failure.
// Availability is an image-level property, so the probe result is cached for
// the lifetime of the process.
const ripgrepAvailable = new Map<string, boolean>()

export const ensureRipgrep = (deps: Deps, context: Tool.Context) =>
  Effect.gen(function* () {
    const cached = ripgrepAvailable.get(context.sessionID)
    if (cached === false)
      return yield* Effect.fail(
        new ToolFailure({
          message:
            "ripgrep (rg) is not available in the sandbox image. Rebuild the sandbox image with ripgrep installed (see packages/containers/sandbox), or use the shell tool with grep/find instead.",
        }),
      )
    if (cached === true) return
    const probe = yield* exec(deps, context, "command -v rg", 5_000)
    const ok = probe.exitCode === 0 && probe.output.trim().length > 0
    ripgrepAvailable.set(context.sessionID, ok)
    if (!ok)
      return yield* Effect.fail(
        new ToolFailure({
          message:
            "ripgrep (rg) is not available in the sandbox image. Rebuild the sandbox image with ripgrep installed (see packages/containers/sandbox), or use the shell tool with grep/find instead.",
        }),
      )
  })


export const write = Effect.fn("SandboxTools.write")(
  function* (
    deps: Deps,
    input: { path: string; content: string },
    context: Tool.Context,
    fileDiff: (resource: string, before: string, after: string, change: "added" | "modified") => unknown,
  ) {
    const absolute = path.resolve(deps.location.directory, input.path)
    const sandboxPath = yield* resolve(deps.location.directory, input.path)
    const resource = path.relative(deps.location.directory, absolute) || "."
    const stat = yield* deps.provider.fileStat(context.sessionID, sandboxPath)
    const existed = stat !== null
    const current = existed
      ? (yield* deps.provider.fileRead(context.sessionID, sandboxPath)) ?? ""
      : ""
    const preview = fileDiff(resource, current, input.content, existed ? "modified" : "added")
    yield* deps.permission.assert({
      action: "edit",
      resources: [resource],
      save: ["*"],
      metadata: { files: [preview] },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    yield* deps.provider.fileWrite(context.sessionID, sandboxPath, input.content)
    return { operation: "write" as const, target: input.path, resource, existed }
  },
)

export const edit = Effect.fn("SandboxTools.edit")(
  function* (
    deps: Deps,
    input: { path: string; oldString: string; newString: string; replaceAll?: boolean },
    context: Tool.Context,
    fileDiff: (resource: string, before: string, after: string) => FileDiff.Info,
    replaceText: (
      source: string,
      input: { path: string; oldString: string; newString: string; replaceAll?: boolean },
    ) => { matches: number; replacements: number; replaced: string },
  ) {
    const absolute = path.resolve(deps.location.directory, input.path)
    const sandboxPath = yield* resolve(deps.location.directory, input.path)
    const resource = path.relative(deps.location.directory, absolute) || "."
    const stat = yield* deps.provider.fileStat(context.sessionID, sandboxPath)
    if (stat === null) return yield* Effect.fail(new Error(`File not found: ${input.path}`))
    if (stat.isDirectory) return yield* Effect.fail(new Error(`Path is a directory, not a file: ${input.path}`))
    const source = yield* deps.provider.fileRead(context.sessionID, sandboxPath)
    if (source === null) return yield* Effect.fail(new Error(`File not found: ${input.path}`))

    const { matches, replacements, replaced } = replaceText(source, input)
    const preview = matches === 1 || (matches > 0 && input.replaceAll) ? fileDiff(resource, source, replaced) : undefined

    yield* deps.permission.assert({
      action: "edit",
      resources: [resource],
      save: ["*"],
      metadata: preview ? { files: [preview] } : undefined,
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })

    if (matches === 0)
      return yield* Effect.fail(
        new Error(`Could not find oldString in ${input.path}. It must match exactly, including whitespace and indentation.`),
      )
    if (matches > 1 && input.replaceAll !== true)
      return yield* Effect.fail(
        new Error(
          `Found ${matches} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`,
        ),
      )

    yield* deps.provider.fileWrite(context.sessionID, sandboxPath, replaced)
    return { files: [fileDiff(resource, source, replaced)], replacements }
  },
)

export const glob = Effect.fn("SandboxTools.glob")(
  function* (deps: Deps, input: { pattern: string; path?: string; hidden?: boolean; limit?: number }, context: Tool.Context) {
    const limit = input.limit ?? 200
    const sandboxPath = yield* resolve(deps.location.directory, input.path)
    yield* deps.permission.assert({
      action: "glob",
      resources: [input.pattern],
      save: ["*"],
      metadata: { root: input.path ?? ".", path: input.path, hidden: input.hidden, limit: input.limit },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    yield* ensureRipgrep(deps, context)
    const flags = [`--glob ${shellQuote(input.pattern)}`, input.hidden ? "--hidden" : "", "--sortr modified"]
      .filter(Boolean)
      .join(" ")
    const result = yield* exec(
      deps,
      context,
      `rg --files ${flags} ${shellQuote(sandboxPath)} 2>/dev/null | head -${limit + 1}`,
      30_000,
    )
    const lines = result.output.split("\n").filter((line) => line.length > 0)
    const truncated = lines.length > limit
    return {
      entries: lines.slice(0, limit).map((line) => ({ path: relative(line.trim(), deps.location.directory), type: "file" as const })),
      truncated,
    }
  },
)

export const grep = Effect.fn("SandboxTools.grep")(
  function* (
    deps: Deps,
    input: { pattern: string; path?: string; include?: string; literal?: boolean; caseSensitive?: boolean; limit?: number },
    context: Tool.Context,
  ) {
    const limit = input.limit ?? 200
    const sandboxPath = yield* resolve(deps.location.directory, input.path)
    yield* deps.permission.assert({
      action: "grep",
      resources: [input.pattern],
      save: ["*"],
      metadata: { pattern: input.pattern, path: input.path, include: input.include },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    yield* ensureRipgrep(deps, context)
    const flags = [
      input.include ? `--glob ${shellQuote(input.include)}` : "",
      input.literal ? "-F" : "",
      input.caseSensitive === false ? "-i" : "",
    ]
      .filter(Boolean)
      .join(" ")
    const result = yield* exec(
      deps,
      context,
      `rg --json ${flags} ${shellQuote(input.pattern)} ${shellQuote(sandboxPath)} 2>/dev/null | rg -m ${limit + 1} '"type":"match"' | head -${limit + 1}`,
      30_000,
    )
    // Parse and validate in one pass: binary matches carry no line number
    // or text and would fail the Match schema, so only complete line
    // matches pass through.
    type ParsedMatch = {
      path: string
      line: number
      offset: number
      text: string
      submatches: Array<{ text: string; start: number; end: number }>
    }
    const events: ParsedMatch[] = result.output
      .split("\n")
      .filter((line) => line.includes('"type":"match"'))
      .slice(0, limit + 1)
      .flatMap<ParsedMatch>((line) => {
        try {
          const data = (JSON.parse(line) as RgMatch).data
          if (data.line_number === undefined || !data.path?.text || !data.lines?.text || !data.submatches) return []
          return [
            {
              path: data.path.text,
              line: data.line_number,
              offset: data.absolute_offset ?? 0,
              text: data.lines.text.replace(/\n$/, ""),
              submatches: data.submatches.map((submatch) => ({
                text: submatch.match.text,
                start: submatch.start,
                end: submatch.end,
              })),
            },
          ]
        } catch {
          return []
        }
      })
    const truncated = events.length > limit
    return {
      matches: events.slice(0, limit).map((event) => ({
        entry: {
          path: relative(event.path, deps.location.directory),
          type: "file" as const,
        },
        line: event.line,
        offset: event.offset,
        text: event.text,
        submatches: event.submatches,
      })),
      truncated,
    }
  },
)

type RgMatch = {
  data: {
    path?: { text?: string }
    lines?: { text?: string }
    line_number?: number
    absolute_offset?: number
    submatches?: Array<{ match: { text: string }; start: number; end: number }>
  }
}

export const read = Effect.fn("SandboxTools.read")(
  function* (
    deps: { provider: SandboxProvider.Interface; location: Location.Interface },
    input: { path: string; offset?: number; limit?: number },
    context: Tool.Context,
  ) {
    const sandboxPath = yield* resolve(deps.location.directory, input.path)
    const stat = yield* deps.provider.fileStat(context.sessionID, sandboxPath)
    if (stat === null) return yield* Effect.fail(new Error(`File not found: ${input.path}`))
    const offset = input.offset ?? 1
    const limit = input.limit ?? 2000
    if (stat.isDirectory) {
      const entries = yield* deps.provider.fileList(context.sessionID, sandboxPath)
      const mapped = entries.map((entry) => ({
        path: relative(
          sandboxPath.endsWith("/") ? `${sandboxPath}${entry.name}` : `${sandboxPath}/${entry.name}`,
          deps.location.directory,
        ),
        type: entry.isDirectory ? ("directory" as const) : ("file" as const),
      }))
      const page = mapped.slice(offset - 1, offset - 1 + limit)
      const truncated = offset - 1 + limit < mapped.length
      return new ReadToolFileSystem.ListPage({
        type: "list-page" as const,
        entries: page,
        truncated,
        ...(truncated ? { next: offset + limit } : {}),
      })
    }
    const header = yield* deps.provider.fileReadBytes(context.sessionID, sandboxPath, { range: `bytes=0-${64 * 1024 - 1}` })
    if (!header) return yield* Effect.fail(new Error(`File not found: ${input.path}`))
    const kind = ToolAttachment.classify(path.basename(input.path), header)
    if (kind.type === "binary") return yield* Effect.fail(new ReadToolFileSystem.BinaryFileError({ resource: input.path }))
    if (kind.type === "image" || kind.type === "pdf" || kind.type === "office") {
      if (stat.size !== undefined && stat.size > ToolAttachment.MAX_BYTES)
        return yield* Effect.fail(
          new ReadToolFileSystem.MediaIngestLimitError({
            resource: input.path,
            maximumBytes: ToolAttachment.MAX_BYTES,
          }),
        )
      const stored = yield* ToolAttachment.store({
        provider: deps.provider,
        sessionID: context.sessionID,
        sourcePath: sandboxPath,
        filename: path.basename(input.path),
      }).pipe(
        Effect.catchTag("ToolAttachment.TooLargeError", () =>
          Effect.fail(
            new ReadToolFileSystem.MediaIngestLimitError({
              resource: input.path,
              maximumBytes: ToolAttachment.MAX_BYTES,
            }),
          ),
        ),
      )
      return new ReadToolFileSystem.AttachmentResult({
        type: "attachment",
        output: kind.type === "image" ? "Image read successfully" : kind.type === "pdf" ? "PDF read successfully" : "Document",
        kind: kind.type,
        uri: stored.url,
        mime: stored.metadata.mime,
        filename: stored.metadata.filename,
        size: stored.metadata.size,
        audience: stored.metadata.audience,
      })
    }
    const content = yield* deps.provider.fileRead(context.sessionID, sandboxPath)
    if (content === null) return yield* Effect.fail(new Error(`File not found: ${input.path}`))
    // The local reader rejects non-text payloads before they reach the model;
    // the files API returns decoded text, so a NUL byte marks binary content.
    if (content.includes("\u0000"))
      return yield* Effect.fail(new Error(`Unable to read ${input.path}: binary file is not supported yet`))
    // The files API decodes leniently and replaces invalid UTF-8 bytes. Reject
    // files dominated by replacement characters before returning them as text.
    if (ReadToolFileSystem.hasExcessiveInvalidUtf8(content))
      return yield* Effect.fail(new ReadToolFileSystem.InvalidUtf8Error({ resource: input.path }))
    const lines = content.split("\n")
    const page = lines.slice(offset - 1, offset - 1 + limit)
    const truncated = offset - 1 + limit < lines.length
    return new ReadToolFileSystem.TextPage({
      type: "text-page" as const,
      content: page.join("\n"),
      mime: "text/plain",
      offset,
      truncated,
      ...(stat.size === undefined ? {} : { size: stat.size }),
      ...(truncated ? { next: offset + limit } : {}),
    })
  },
)
