import path from "path"
import { Schema } from "effect"
import { Effect } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import * as Tool from "./tool"
import { Reference } from "@/reference/reference"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

const MAX_LINE_LENGTH = 2000

interface GrepMatch {
  type: "match"
  data: {
    path: { text: string }
    line_number: number
    lines: { text: string }
  }
}

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The regex pattern to search for in file contents" }),
  path: Schema.optional(Schema.String).annotate({
    description: "The directory to search in. Defaults to the current working directory.",
  }),
  include: Schema.optional(Schema.String).annotate({
    description: 'File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")',
  }),
})

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const reference = yield* Reference.Service
    const sandboxProvider = yield* SandboxProvider.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string; include?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const empty = {
            title: params.pattern,
            metadata: { matches: 0, truncated: false },
            output: "No files found",
          }
          if (!params.pattern) {
            throw new Error("pattern is required")
          }

          yield* ctx.ask({
            permission: "grep",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
              include: params.include,
            },
          })

          const ins = yield* InstanceState.context
          const requested = path.isAbsolute(params.path ?? ins.directory)
            ? (params.path ?? ins.directory)
            : path.join(ins.directory, params.path ?? ".")
          yield* reference.ensure(requested)
          yield* assertExternalDirectoryEffect(ctx, requested, {
            bypass: yield* reference.contains(requested),
            kind: "directory",
          })

          const limit = 100

          const sandboxSearchPath = toSandboxPath(requested, ins.directory)
          const escapedPattern = params.pattern.replace(/'/g, "'\\''")
          let cmd = `rg --json '${escapedPattern}' '${sandboxSearchPath}' 2>/dev/null`
          if (params.include) {
            const escapedInclude = params.include.replace(/'/g, "'\\''")
            cmd += ` --glob '${escapedInclude}'`
          }

          const result = yield* sandboxProvider.runInSession(ctx.sessionID, cmd, { timeoutSeconds: 30 })
          const stdout = result.logs.stdout
            .map((l: { text: string }) => l.text)
            .join("")
            .trim()

          if (!stdout) return empty

          const rows: { path: string; line: number; text: string }[] = []
          for (const line of stdout.split("\n")) {
            if (!line.trim()) continue
            try {
              const parsed = JSON.parse(line) as GrepMatch
              if (parsed.type !== "match") continue
              rows.push({
                path: parsed.data.path.text,
                line: parsed.data.line_number,
                text: parsed.data.lines.text,
              })
            } catch {
            }
          }

          if (rows.length === 0) return empty

          const truncated = rows.length > limit
          const final = truncated ? rows.slice(0, limit) : rows
          const total = rows.length
          const output = [`Found ${total} matches${truncated ? ` (showing first ${limit})` : ""}`]

          let current = ""
          for (const match of final) {
            if (current !== match.path) {
              if (current !== "") output.push("")
              current = match.path
              output.push(`${match.path}:`)
            }
            const text =
              match.text.length > MAX_LINE_LENGTH ? match.text.substring(0, MAX_LINE_LENGTH) + "..." : match.text
            output.push(`  Line ${match.line}: ${text}`)
          }

          if (truncated) {
            output.push("")
            output.push(
              `(Results truncated: showing ${limit} of ${total} matches (${total - limit} hidden). Consider using a more specific path or pattern.)`,
            )
          }

          return {
            title: params.pattern,
            metadata: { matches: total, truncated },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
