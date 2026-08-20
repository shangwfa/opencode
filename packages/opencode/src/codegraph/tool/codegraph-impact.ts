import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-impact.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"

export const Parameters = Schema.Struct({
  symbol: Schema.String.annotate({
    description: "要评估变更影响的符号名。",
  }),
  file: Schema.optional(Schema.String.annotate({
    description: "同名符号多处定义时，限定目标文件（路径或后缀）",
  })),
  depth: Schema.optional(Schema.Number.annotate({
    description: "影响传播深度（默认 2）",
  })),
})

export const CodegraphImpactTool = Tool.define(
  "codegraph_impact",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { symbol: string; file?: string; depth?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { scope, guidance } = yield* Effect.promise(() => resolveScopeOrGuide(ctx.sessionID))
          if (!scope) return { title: "codegraph_impact", metadata: {}, output: guidance ?? "" }

          const depth = Math.min(Math.max(params.depth ?? 2, 1), 5)
          const note = yield* Effect.promise(() => indexStateNote(scope))
          const all = yield* Effect.promise(() => S.findNodesByName(scope, params.symbol))
          const defs = S.filterNodesByFile(all, params.file)
          if (defs.length === 0) {
            return { title: "codegraph_impact", metadata: {}, output: `${note}未找到 "${params.symbol}"。` }
          }

          const parts: string[] = []
          for (const def of defs) {
            const impact = yield* Effect.promise(() => S.getImpact(scope, def.id, depth))
            parts.push(`${def.qualified_name} @ ${def.file_path}:${def.start_line}`)
            if (impact.length === 0) {
              parts.push(`  无下游依赖（变更风险低）`)
            } else {
              parts.push(`  ${impact.length} 个直接/间接依赖者:`)
              for (const c of impact.slice(0, 50)) {
                parts.push(`    ${c.node.qualified_name} @ ${c.node.file_path}:${c.node.start_line}${c.edge.kind !== "calls" ? ` (${c.edge.kind})` : ""}`)
              }
              if (impact.length > 50) parts.push(`    …还有 ${impact.length - 50} 个`)
            }
            parts.push("")
          }
          return { title: "codegraph_impact", metadata: {}, output: `${note}${parts.join("\n").trimEnd()}` }
        }),
    }
  }),
)
