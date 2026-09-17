import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"
import { IGNORE_PATTERNS } from "./ls"

export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const sandboxProvider = yield* SandboxProvider.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          let search = params.path ?? ins.directory
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)

          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
            managed: true,
          })

          const limit = 100
          const sandboxSearchPath = toSandboxPath(search, ins.directory)
          const escapedPattern = params.pattern.replace(/'/g, "'\\''")
          const excludeArgs = IGNORE_PATTERNS.map((item) => `--glob '!${item}'`).join(" ")
          const gitignoreArgs = `$(test -f '${sandboxSearchPath}/.gitignore' && echo --ignore-file ${sandboxSearchPath}/.gitignore)`
          const cmd = `rg --files --glob '${escapedPattern}' ${excludeArgs} ${gitignoreArgs} --sortr modified '${sandboxSearchPath}' 2>/dev/null | head -${limit + 1}`
          const result = yield* sandboxProvider.runDetached(ctx.sandboxSessionID ?? ctx.sessionID, cmd, { timeoutSeconds: 30 })
          const stdout = result.logs.stdout.map((l: { text: string }) => l.text).join("\n").trim()
          const lines = stdout ? stdout.split("\n").filter((line: string) => line.length > 0) : []

          const truncated = lines.length > limit
          const files = lines.slice(0, limit).map((line: string) => line.trim())

          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files)
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
