import path from "path"
import z from "zod"
import { Effect, Option } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Ripgrep } from "../file/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./grep.txt"
import { Tool } from "./tool"
import { toSandboxPath, toHostPath } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

const MAX_LINE_LENGTH = 2000

export const GrepTool = Tool.define(
  "grep",
  Effect.gen(function* () {
    const fs = yield* AppFileSystem.Service
    const rg = yield* Ripgrep.Service
    const sandboxProvider = yield* SandboxProvider.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({
        pattern: z.string().describe("The regex pattern to search for in file contents"),
        path: z.string().optional().describe("The directory to search in. Defaults to the current working directory."),
        include: z.string().optional().describe('File pattern to include in the search (e.g. "*.js", "*.{ts,tsx}")'),
      }),
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
          const search = AppFileSystem.resolve(
            path.isAbsolute(params.path ?? ins.directory)
              ? (params.path ?? ins.directory)
              : path.join(ins.directory, params.path ?? "."),
          )
          yield* assertExternalDirectoryEffect(ctx, search)

          // ── Sandbox mode ──
          if (ctx.sandbox !== null) {
            const sb = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(String(e)) })
            const sandboxSearchPath = toSandboxPath(search, ins.directory)

            const escapedPattern = params.pattern.replace(/'/g, "'\\''")
            let cmd = `rg --json -e '${escapedPattern}'`
            if (params.include) cmd += ` --glob '${params.include.replace(/'/g, "'\\''")}'`
            if (file) {
              cmd += ` '${sandboxSearchPath}'`
            } else {
              cmd += ` '${sandboxSearchPath}'`
            }
            cmd += ` 2>/dev/null; true`

            const rgResult = yield* sandboxProvider.runInSession(ctx.sessionID, cmd, { timeoutSeconds: 60 })

            const stdout = rgResult.logs.stdout.map((l: { text: string }) => l.text).join("\n")
            if (!stdout.trim()) return empty

            const rows: Array<{ path: string; line: number; text: string }> = []
            for (const line of stdout.split("\n")) {
              if (!line.trim()) continue
              try {
                const parsed = JSON.parse(line)
                if (parsed.type === "match") {
                  rows.push({
                    path: parsed.data.path.text,
                    line: parsed.data.line_number,
                    text: parsed.data.lines.text.replace(/\n$/, ""),
                  })
                }
              } catch {
                continue
              }
            }
            if (rows.length === 0) return empty

            const uniqueFiles = [...new Set(rows.map((r) => r.path))]
            const fileInfos = yield* Effect.tryPromise({
              try: () => sb.files.search({ path: sandboxSearchPath, pattern: "*" }),
              catch: () => [] as any[],
            })
            const times = new Map<string, number>()
            for (const f of fileInfos as any[]) {
              times.set(f.path, f.modifiedAt ? new Date(f.modifiedAt).getTime() : 0)
            }

            const matches = rows.map((row) => ({
              path: toHostPath(row.path, ins.directory),
              line: row.line,
              text: row.text,
              mtime: times.get(row.path) ?? 0,
            }))

            matches.sort((a, b) => b.mtime - a.mtime)

            const limit = 100
            const truncated = matches.length > limit
            const final = truncated ? matches.slice(0, limit) : matches

            const total = matches.length
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
              metadata: {
                matches: total,
                truncated,
              },
              output: output.join("\n"),
            }
          }

          // ── Local mode ──
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          const cwd = info?.type === "Directory" ? search : path.dirname(search)
          const file = info?.type === "Directory" ? undefined : [path.relative(cwd, search)]
          yield* assertExternalDirectoryEffect(ctx, search, {
            kind: info?.type === "Directory" ? "directory" : "file",
          })

          const result = yield* rg.search({
            cwd,
            pattern: params.pattern,
            glob: params.include ? [params.include] : undefined,
            file,
            signal: ctx.abort,
          })
          if (result.items.length === 0) return empty

          const rows = result.items.map((item) => ({
            path: AppFileSystem.resolve(
              path.isAbsolute(item.path.text) ? item.path.text : path.join(cwd, item.path.text),
            ),
            line: item.line_number,
            text: item.lines.text,
          }))
          const times = new Map(
            (yield* Effect.forEach(
              [...new Set(rows.map((row) => row.path))],
              Effect.fnUntraced(function* (file) {
                const info = yield* fs.stat(file).pipe(Effect.catch(() => Effect.succeed(undefined)))
                if (!info || info.type === "Directory") return undefined
                return [
                  file,
                  info.mtime.pipe(
                    Option.map((time) => time.getTime()),
                    Option.getOrElse(() => 0),
                  ) ?? 0,
                ] as const
              }),
              { concurrency: 16 },
            )).filter((entry): entry is readonly [string, number] => Boolean(entry)),
          )
          const matches = rows.flatMap((row) => {
            const mtime = times.get(row.path)
            if (mtime === undefined) return []
            return [{ ...row, mtime }]
          })

          matches.sort((a, b) => b.mtime - a.mtime)

          const limit = 100
          const truncated = matches.length > limit
          const final = truncated ? matches.slice(0, limit) : matches
          if (final.length === 0) return empty

          const total = matches.length
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

          if (result.partial) {
            output.push("")
            output.push("(Some paths were inaccessible and skipped)")
          }

          return {
            title: params.pattern,
            metadata: {
              matches: total,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
