import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-files.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"

export const Parameters = Schema.Struct({
  path: Schema.optional(Schema.String.annotate({
    description: "只显示该目录下的文件（如 \"src/components\"）",
  })),
  format: Schema.optional(Schema.String.annotate({
    description: '输出格式: "tree"(层级,默认) / "flat"(平铺) / "grouped"(按语言)',
  })),
  limit: Schema.optional(Schema.Number.annotate({
    description: "最大显示文件数（默认 100）",
  })),
})

export const CodegraphFilesTool = Tool.define(
  "codegraph_files",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { path?: string; format?: string; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { scope, guidance } = yield* Effect.promise(() => resolveScopeOrGuide(ctx.sessionID))
          if (!scope) return { title: "codegraph_files", metadata: {}, output: guidance ?? "" }

          const limit = Math.min(Math.max(params.limit ?? 100, 1), 500)
          const note = yield* Effect.promise(() => indexStateNote(scope))
          const files = yield* Effect.promise(() => S.listFiles(scope))
          if (files.length === 0) {
            return { title: "codegraph_files", metadata: {}, output: `${note}索引中暂无文件。` }
          }

          let filtered = files
          if (params.path) {
            const p = params.path.replace(/^\.\//, "").replace(/^\/workspace\//, "")
            filtered = files.filter((f) => S.pathMatches(f.path, p) || f.path.includes("/" + p) || f.path.startsWith(p + "/") || f.path.startsWith(p))
            if (filtered.length === 0) {
              return { title: "codegraph_files", metadata: {}, output: `${note}目录 "${params.path}" 下无索引文件。` }
            }
          }

          const fmt = params.format ?? "tree"
          const shown = filtered.slice(0, limit)
          const more = filtered.length - shown.length

          const lines: string[] = []
          if (fmt === "grouped") {
            const byLang = new Map<string, typeof files>()
            for (const f of shown) {
              const list = byLang.get(f.language) ?? []
              list.push(f)
              byLang.set(f.language, list)
            }
            for (const [lang, list] of [...byLang.entries()].sort((a, b) => b[1].length - a[1].length)) {
              lines.push(`## ${lang} (${list.length})`)
              for (const f of list) lines.push(`  ${f.path} (${f.node_count} 符号)`)
            }
          } else if (fmt === "flat") {
            for (const f of shown) lines.push(`${f.path} (${f.language}, ${f.node_count} 符号)`)
          } else {
            const dirs = new Set<string>()
            for (const f of shown) {
              const slash = f.path.lastIndexOf("/")
              if (slash > 0) dirs.add(f.path.slice(0, slash))
            }
            const treeLines: string[] = []
            const indented = new Map<string, string>()
            for (const f of shown) {
              const slash = f.path.lastIndexOf("/")
              const dir = slash > 0 ? f.path.slice(0, slash) : ""
              const base = slash > 0 ? f.path.slice(slash + 1) : f.path
              if (dir && !indented.has(dir)) {
                const depth = dir.split("/").length
                indented.set(dir, `${"  ".repeat(depth - 1)}${dir.split("/").pop()}/`)
              }
              const depth = slash > 0 ? dir.split("/").length : 0
              treeLines.push(`${"  ".repeat(depth)}${base} (${f.node_count})`)
            }
            for (const d of indented.values()) lines.push(d)
            lines.push(...treeLines)
          }

          const header = `${note}${fmt} 格式，${shown.length} 个文件${more > 0 ? `（另有 ${more} 个未显示）` : ""}:`
          return {
            title: "codegraph_files",
            metadata: {},
            output: `${header}\n${lines.join("\n")}`,
          }
        }),
    }
  }),
)
