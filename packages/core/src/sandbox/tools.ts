export * as SandboxTools from "./tools.js"

import path from "path"
import { Effect } from "effect"
import type { Tool } from "@opencode/schema/tool"
import { Location } from "../location.js"
import { Permission } from "../permission.js"
import { RelativePath } from "../schema.js"
import { SandboxProvider } from "./provider.js"
import { SandboxPath } from "./path.js"

/**
 * Sandbox-backed implementations for the file-oriented built-in tools. Each
 * function maps the tool input onto the sandbox `/workspace` mount, keeps the
 * canonical permission check, and returns the tool's declared output shape so
 * the plugin only branches on `provider.enabled`.
 */

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

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

export const write = Effect.fn("SandboxTools.write")(
  function* (
    deps: Deps,
    input: { path: string; content: string },
    context: Tool.Context,
    fileDiff: (resource: string, before: string, after: string, change: "added" | "modified") => unknown,
  ) {
    const absolute = path.resolve(deps.location.directory, input.path)
    const sandboxPath = SandboxPath.toSandboxPath(absolute, deps.location.directory)
    const resource = path.relative(deps.location.directory, absolute) || "."
    const stat = yield* deps.provider.fileStat(context.sessionID, sandboxPath)
    const existed = stat !== null
    const preview = fileDiff(resource, "", input.content, "added")
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

export const glob = Effect.fn("SandboxTools.glob")(
  function* (deps: Deps, input: { pattern: string; path?: string; hidden?: boolean; limit?: number }, context: Tool.Context) {
    const limit = input.limit ?? 200
    const absolute = path.resolve(deps.location.directory, input.path ?? ".")
    const sandboxPath = SandboxPath.toSandboxPath(absolute, deps.location.directory)
    yield* deps.permission.assert({
      action: "glob",
      resources: [input.pattern],
      save: ["*"],
      metadata: { root: input.path ?? ".", path: input.path, hidden: input.hidden, limit: input.limit },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
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
  function* (deps: Deps, input: { pattern: string; path?: string; limit?: number }, context: Tool.Context) {
    const limit = input.limit ?? 200
    const absolute = path.resolve(deps.location.directory, input.path ?? ".")
    const sandboxPath = SandboxPath.toSandboxPath(absolute, deps.location.directory)
    yield* deps.permission.assert({
      action: "grep",
      resources: [input.pattern],
      save: ["*"],
      metadata: { pattern: input.pattern, path: input.path },
      sessionID: context.sessionID,
      agent: context.agent,
      source: { type: "tool", messageID: context.messageID, id: context.id },
    })
    const result = yield* exec(
      deps,
      context,
      `rg --json ${shellQuote(input.pattern)} ${shellQuote(sandboxPath)} 2>/dev/null | rg -m ${limit + 1} '"type":"match"' | head -${limit + 1}`,
      30_000,
    )
    const events = result.output
      .split("\n")
      .filter((line) => line.includes('"type":"match"'))
      .slice(0, limit + 1)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as RgMatch]
        } catch {
          return []
        }
      })
    const truncated = events.length > limit
    return {
      matches: events.slice(0, limit).map((event) => ({
        entry: {
          path: relative(event.data.path.text, deps.location.directory),
          type: "file" as const,
        },
        line: event.data.line_number,
        offset: event.data.absolute_offset ?? 0,
        text: event.data.lines.text.replace(/\n$/, ""),
        submatches: event.data.submatches.map((submatch) => ({
          text: submatch.match.text,
          start: submatch.start,
          end: submatch.end,
        })),
      })),
      truncated,
    }
  },
)

type RgMatch = {
  data: {
    path: { text: string }
    lines: { text: string }
    line_number: number
    absolute_offset?: number
    submatches: Array<{ match: { text: string }; start: number; end: number }>
  }
}

export const read = Effect.fn("SandboxTools.read")(
  function* (deps: { provider: SandboxProvider.Interface; location: Location.Interface }, input: { path: string; offset?: number; limit?: number }, context: Tool.Context) {
    const absolute = path.resolve(deps.location.directory, input.path)
    const sandboxPath = SandboxPath.toSandboxPath(absolute, deps.location.directory)
    const stat = yield* deps.provider.fileStat(context.sessionID, sandboxPath)
    if (stat === null) return yield* Effect.fail(new Error(`File not found: ${input.path}`))
    if (stat.isDirectory)
      return yield* Effect.fail(
        new Error(`Path is a directory: ${input.path}. Use the shell tool to list it inside the sandbox.`),
      )
    const content = yield* deps.provider.fileRead(context.sessionID, sandboxPath)
    if (content === null) return yield* Effect.fail(new Error(`File not found: ${input.path}`))
    const offset = input.offset ?? 1
    const limit = input.limit ?? 2000
    const lines = content.split("\n")
    const page = lines.slice(offset - 1, offset - 1 + limit)
    const truncated = offset - 1 + limit < lines.length
    return {
      type: "text-page" as const,
      content: page.join("\n"),
      mime: "text/plain",
      offset,
      truncated,
      ...(truncated ? { next: offset + limit } : {}),
    }
  },
)
