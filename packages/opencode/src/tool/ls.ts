import * as path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./ls.txt"
import * as Tool from "./tool"
import { toSandboxPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

export const IGNORE_PATTERNS = [
  "node_modules/",
  "__pycache__/",
  ".git/",
  "dist/",
  "build/",
  "target/",
  "vendor/",
  "bin/",
  "obj/",
  ".idea/",
  ".vscode/",
  ".zig-cache/",
  "zig-out",
  ".coverage",
  "coverage/",
  "vendor/",
  "tmp/",
  "temp/",
  ".cache/",
  "cache/",
  "logs/",
  ".venv/",
  "venv/",
  "env/",
]

const LIMIT = 100

export const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String).annotate({
    description: "The absolute path to the directory to list (must be absolute, not relative)",
  }),
  ignore: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "List of glob patterns to ignore",
  }),
})

export const ListTool = Tool.define(
  "list",
  Effect.gen(function* () {
    const sandboxProvider = yield* SandboxProvider.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          const search = path.resolve(ins.directory, params.path || ".")
          yield* assertExternalDirectoryEffect(ctx, search, { kind: "directory" })

          yield* ctx.ask({
            permission: "list",
            patterns: [search],
            always: ["*"],
            metadata: {
              path: search,
            },
          })

          const glob = IGNORE_PATTERNS.map((item) => `!${item}*`).concat(
            params.ignore?.map((item) => `!${item}`) || [],
          )

          const sandboxSearchPath = toSandboxPath(search, ins.directory)
          const globArgs = glob.map((g) => `--glob '${g}'`).join(" ")
          const cmd = `rg --files ${globArgs} '${sandboxSearchPath}' 2>/dev/null | head -${LIMIT + 1}`
          const result = yield* sandboxProvider.runDetached(ctx.sandboxSessionID ?? ctx.sessionID, cmd, { timeoutSeconds: 30 })
          const stdout = result.logs.stdout
            .map((l: { text: string }) => l.text)
            .join("\n")
            .trim()
          const lines = stdout ? stdout.split("\n").filter((line: string) => line.length > 0) : []
          const truncated = lines.length > LIMIT
          const files = lines.slice(0, LIMIT).map((line: string) => {
            return path.relative(sandboxSearchPath, line.trim())
          })

          const dirs = new Set<string>()
          const map = new Map<string, string[]>()
          for (const file of files) {
            const dir = path.dirname(file)
            const parts = dir === "." ? [] : dir.split("/")
            for (let i = 0; i <= parts.length; i++) {
              dirs.add(i === 0 ? "." : parts.slice(0, i).join("/"))
            }
            if (!map.has(dir)) map.set(dir, [])
            map.get(dir)!.push(path.basename(file))
          }

          function render(dir: string, depth: number): string {
            const indent = "  ".repeat(depth)
            let output = ""
            if (depth > 0) output += `${indent}${path.basename(dir)}/\n`

            const child = "  ".repeat(depth + 1)
            const dirs2 = Array.from(dirs)
              .filter((item) => path.dirname(item) === dir && item !== dir)
              .sort()
            for (const item of dirs2) {
              output += render(item, depth + 1)
            }

            const dirFiles = map.get(dir) || []
            for (const file of dirFiles.sort()) {
              output += `${child}${file}\n`
            }
            return output
          }

          return {
            title: toSandboxPath(search, ins.worktree === "/" ? ins.directory : ins.worktree),
            metadata: {
              count: files.length,
              truncated,
            },
            output: `${sandboxSearchPath}/\n` + render(".", 0),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
