import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-explore.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"
import { isLowConfidenceQuery } from "../search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "符号名、文件名或短代码术语的组合（如 \"AuthService loginUser session-manager\"）。可以是自然语言描述。",
  }),
  maxSymbols: Schema.optional(Schema.Number.annotate({
    description: "最多返回的符号数（默认 30，上限 100）",
  })),
})

export const CodegraphExploreTool = Tool.define(
  "codegraph_explore",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { query: string; maxSymbols?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { scope, guidance } = yield* Effect.promise(() => resolveScopeOrGuide(ctx.sessionID))
          if (!scope) return { title: "codegraph_explore", metadata: {}, output: guidance ?? "" }

          const limit = Math.min(Math.max(params.maxSymbols ?? 30, 1), 100)
          const note = yield* Effect.promise(() => indexStateNote(scope))
          const results = yield* Effect.promise(() => S.searchNodes(scope, params.query, { limit }))
          const lowConfidence = isLowConfidenceQuery(params.query)
          if (results.length === 0) {
            return {
              title: "codegraph_explore",
              metadata: {},
              output: `${note}未找到与 "${params.query}" 相关的符号。\n请换用更具体的符号名（如 camelCase/snake_case 的真实符号），或用 codegraph_search 试相似名。`,
            }
          }

          // Group by file, keep per-file order by line.
          const byFile = new Map<string, S.GraphNode[]>()
          for (const r of results) {
            const list = byFile.get(r.file_path) ?? []
            list.push(r)
            byFile.set(r.file_path, list)
          }
          const files = [...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0]))

          const parts: string[] = []
          parts.push(`${note}相关符号（${results.length} 个，分布 ${files.length} 个文件）:`)
          parts.push("")

          for (const [filePath, nodes] of files) {
            parts.push(`#### ${filePath}`)
            for (const n of nodes.sort((a, b) => a.start_line - b.start_line)) {
              const sig = n.signature ? ` ${n.signature}` : ""
              parts.push(`- L${n.start_line}  ${n.kind} ${n.qualified_name}${sig}`)
            }
            parts.push("")
          }

          // Call-path edges among the selected subgraph.
          const idSet = new Set(results.map((r) => r.id))
          const relParts: string[] = []
          for (const r of results) {
            const callees = yield* Effect.promise(() => S.getCallees(scope, r.id, 1))
            for (const c of callees) {
              if (idSet.has(c.node.id)) {
                relParts.push(`${r.qualified_name} -> ${c.node.qualified_name} (${r.file_path}:${r.start_line})`)
              }
            }
          }
          if (relParts.length > 0) {
            parts.push(`调用关系（命中符号之间）:`)
            parts.push(relParts.slice(0, 40).join("\n"))
            parts.push("")
          }

          parts.push("(以上仅为符号位置清单；源码正文请按 file:line 用 read 工具读取。若结果似偏靶，改用真实符号名重试。)")
          if (lowConfidence) {
            parts.push("")
            parts.push("⚠️ LOW_CONFIDENCE：本查询仅由常见词构成，命中符号可能与真实目标偏差较大。请改用真实的 camelCase/snake_case 符号名（可用 codegraph_search 先确认）再查一次。")
          }
          return { title: "codegraph_explore", metadata: {}, output: parts.join("\n").trimEnd() }
        }),
    }
  }),
)
