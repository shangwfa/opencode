import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-search.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "符号名或部分名，支持驼峰/下划线/点号分段，例如 \"auth\"、\"signIn\"、\"UserService\"、\"Graph.Traverser\"。",
  }),
  kind: Schema.optional(Schema.String).annotate({
    description: '按符号类型过滤（function/method/class/interface/type/variable/route/component 等）',
  }),
  limit: Schema.optional(Schema.Number).annotate({
    description: "最大结果数（默认 10，上限 100）",
  }),
})

export const CodegraphSearchTool = Tool.define(
  "codegraph_search",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { query: string; kind?: string; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { scope, guidance } = yield* Effect.promise(() => resolveScopeOrGuide(ctx.sessionID))
          if (!scope) return { title: "codegraph_search", metadata: {}, output: guidance ?? "" }

          const limit = Math.min(Math.max(params.limit ?? 10, 1), 100)
          const kind = params.kind === "type" ? "type_alias" : params.kind
          const results = yield* Effect.promise(() =>
            S.searchNodes(scope, params.query, { kind, limit }),
          )

          const note = yield* Effect.promise(() => indexStateNote(scope))
          if (results.length === 0) {
            return { title: "codegraph_search", metadata: {}, output: `${note}未找到与 "${params.query}" 匹配的符号。` }
          }

          const lines = results.map((n) => {
            const sig = n.signature ? ` ${n.signature}` : ""
            return `${n.file_path}:${n.start_line}\t${n.kind} ${n.qualified_name}${sig}`
          })
          return {
            title: "codegraph_search",
            metadata: {},
            output: `${note}${lines.join("\n")}\n\n(源码内容请用 read 工具读取；如需查看调用关系用 codegraph_callers。)`,
          }
        }),
    }
  }),
)
