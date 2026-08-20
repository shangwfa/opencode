import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-callees.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"

export const Parameters = Schema.Struct({
  symbol: Schema.String.annotate({
    description: "要查询被调用者的函数/方法名。",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "同名符号多处定义时，限定目标文件（路径或后缀）",
  }),
  limit: Schema.optional(Schema.Number.annotate({
    description: "最大被调用者数（默认 20，上限 100）",
  })),
})

export const CodegraphCalleesTool = Tool.define(
  "codegraph_callees",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { symbol: string; file?: string; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { scope, guidance } = yield* Effect.promise(() => resolveScopeOrGuide(ctx.sessionID))
          if (!scope) return { title: "codegraph_callees", metadata: {}, output: guidance ?? "" }

          const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
          const note = yield* Effect.promise(() => indexStateNote(scope))
          const all = yield* Effect.promise(() => S.findNodesByName(scope, params.symbol))
          const defs = S.filterNodesByFile(all, params.file)
          if (defs.length === 0) {
            return { title: "codegraph_callees", metadata: {}, output: `${note}未找到 "${params.symbol}"。` }
          }

          const parts: string[] = []
          for (const def of defs) {
            const callees = yield* Effect.promise(() => S.getCallees(scope, def.id, 1))
            parts.push(`${def.qualified_name} @ ${def.file_path}:${def.start_line}`)
            if (callees.length === 0) {
              parts.push(`  无直接被调用者`)
            } else {
              parts.push(`  ${callees.length} 处调用:`)
              for (const c of callees.slice(0, limit)) {
                const via = c.edge.kind === "instantiates" ? " (实例化)" : c.edge.kind === "imports" ? " (import)" : c.edge.kind === "references" ? " (引用)" : ""
                parts.push(`    ${c.node.qualified_name} @ ${c.node.file_path}:${c.node.start_line}${via}`)
              }
              if (callees.length > limit) parts.push(`    …还有 ${callees.length - limit} 个`)
            }
            parts.push("")
          }
          return { title: "codegraph_callees", metadata: {}, output: `${note}${parts.join("\n").trimEnd()}` }
        }),
    }
  }),
)
