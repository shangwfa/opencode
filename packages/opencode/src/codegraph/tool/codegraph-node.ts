import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-node.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"

export const Parameters = Schema.Struct({
  symbol: Schema.String.annotate({
    description: "要查询的符号名（函数/类/方法等）。同名符号会全部返回，可用 file 或 line 精确定位。",
  }),
  file: Schema.optional(Schema.String).annotate({
    description: "限定在该文件中的定义（路径或后缀，如 \"harness.rs\"、\"src/auth/session.ts\"）",
  }),
  line: Schema.optional(Schema.Number).annotate({
    description: "限定在该行附近的定义",
  }),
})

const containerKinds = new Set(["class", "struct", "interface", "trait", "protocol", "enum", "namespace", "module"])

const pickByFileLine = (nodes: S.GraphNode[], file?: string, line?: number) => {
  let pool = S.filterNodesByFile(nodes, file)
  if (line !== undefined && pool.length > 1) {
    const at = pool.filter((n) => n.start_line <= line && n.end_line >= line)
    if (at.length > 0) pool = at
  }
  return pool
}

export const CodegraphNodeTool = Tool.define(
  "codegraph_node",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { symbol: string; file?: string; line?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { scope, guidance } = yield* Effect.promise(() => resolveScopeOrGuide(ctx.sessionID))
          if (!scope) return { title: "codegraph_node", metadata: {}, output: guidance ?? "" }

          const note = yield* Effect.promise(() => indexStateNote(scope))
          const all = yield* Effect.promise(() => S.findNodesByName(scope, params.symbol))
          if (all.length === 0) {
            return { title: "codegraph_node", metadata: {}, output: `${note}未找到名为 "${params.symbol}" 的符号。试试 codegraph_search 找相似名。` }
          }
          const defs = pickByFileLine(all, params.file, params.line)
          const parts: string[] = []
          for (const n of defs) {
            const head = `${n.kind} ${n.qualified_name} @ ${n.file_path}:${n.start_line}-${n.end_line}`
            parts.push(head)
            if (n.signature) parts.push(`  签名: ${n.signature}`)
            if (n.docstring) parts.push(`  文档: ${n.docstring.slice(0, 300)}`)
            if (n.visibility) parts.push(`  可见性: ${n.visibility}`)
            if (containerKinds.has(n.kind)) {
              const children = yield* Effect.promise(() => S.getChildren(scope, n.id))
              if (children.length > 0) {
                parts.push(`  成员: ${children.map((c) => `${c.kind} ${c.name}${c.signature ? ` ${c.signature}` : ""} (L${c.start_line})`).slice(0, 30).join(" | ")}${children.length > 30 ? " …" : ""}`)
              }
            }
            const callers = yield* Effect.promise(() => S.getCallers(scope, n.id, 1))
            const callees = yield* Effect.promise(() => S.getCallees(scope, n.id, 1))
            if (callers.length > 0) parts.push(`  被 ${callers.length} 处调用: ${callers.slice(0, 5).map((c) => `${c.node.qualified_name} @ ${c.node.file_path}:${c.node.start_line}`).join(", ")}${callers.length > 5 ? " …" : ""}`)
            if (callees.length > 0) parts.push(`  调用: ${callees.slice(0, 8).map((c) => `${c.node.qualified_name} @ ${c.node.file_path}:${c.node.start_line}`).join(", ")}${callees.length > 8 ? " …" : ""}`)
            parts.push(`  源码: ${n.file_path}:${n.start_line}（用 read 读取正文）`)
            parts.push("")
          }
          return { title: "codegraph_node", metadata: {}, output: `${note}${parts.join("\n").trimEnd()}` }
        }),
    }
  }),
)
