import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-affected.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"
import { isTestFile } from "../search"

export const Parameters = Schema.Struct({
  files: Schema.Array(Schema.String).annotate({
    description: "被修改的源文件列表（相对路径，如 \"src/service.ts\"），用这些文件的依赖分析找受影响代码。",
  }),
  includeTests: Schema.optional(Schema.Boolean.annotate({
    description: "是否包含测试文件（默认 false——只列生产代码，改代码前自查用）",
  })),
  depth: Schema.optional(Schema.Number.annotate({
    description: "依赖传播深度（默认 2）",
  })),
  limit: Schema.optional(Schema.Number.annotate({
    description: "最大受影响文件数（默认 50）",
  })),
})

export const CodegraphAffectedTool = Tool.define(
  "codegraph_affected",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: { files: string[]; includeTests?: boolean; depth?: number; limit?: number }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const { scope, guidance } = yield* Effect.promise(() => resolveScopeOrGuide(ctx.sessionID))
          if (!scope) return { title: "codegraph_affected", metadata: {}, output: guidance ?? "" }
          if (!params.files?.length) {
            return { title: "codegraph_affected", metadata: {}, output: "files 参数必填（被修改的源文件列表）。" }
          }

          const depth = Math.min(Math.max(params.depth ?? 2, 1), 5)
          const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)
          const note = yield* Effect.promise(() => indexStateNote(scope))

          // Resolve user paths (src/x.ts) → indexed paths (repo/src/x.ts) first.
          const seeds = yield* Effect.promise(() => S.resolveIndexedPaths(scope, params.files))
          if (seeds.length === 0) {
            return {
              title: "codegraph_affected",
              metadata: {},
              output: `${note}未在索引中找到这些文件：${params.files.join(", ")}。可用 codegraph_files 查看已索引路径。`,
            }
          }

          // BFS over file dependents (getDependentFilePaths resolves fragments too).
          const affected = new Map<string, number>()
          const frontier = [...seeds]
          const visited = new Set(frontier)
          let currentDepth = 0
          while (frontier.length > 0 && currentDepth < depth) {
            const next: string[] = []
            for (const fp of frontier) {
              const deps = yield* Effect.promise(() => S.getDependentFilePaths(scope, fp))
              for (const d of deps) {
                if (visited.has(d)) continue
                visited.add(d)
                affected.set(d, currentDepth + 1)
                next.push(d)
              }
            }
            frontier.length = 0
            frontier.push(...next)
            currentDepth++
          }

          const tests = new Map<string, number>()
          const production = new Map<string, number>()
          for (const [f, d] of affected) {
            if (isTestFile(f)) {
              if (params.includeTests) tests.set(f, d)
            } else {
              production.set(f, d)
            }
          }

          const parts: string[] = []
          parts.push(`${note}变更 ${params.files.length} 个文件的影响分析（深度 ${depth}）:`)
          if (production.size === 0 && tests.size === 0) {
            parts.push("  无受影响文件（这些文件未被其他代码引用）。")
            return { title: "codegraph_affected", metadata: {}, output: parts.join("\n") }
          }
          if (production.size > 0) {
            parts.push(`\n生产代码（${production.size} 个）:`)
            for (const [f, d] of [...production.entries()].slice(0, limit)) {
              parts.push(`  [深度${d}] ${f}`)
            }
            if (production.size > limit) parts.push(`  …还有 ${production.size - limit} 个`)
          }
          if (tests.size > 0) {
            parts.push(`\n测试文件（${tests.size} 个）:`)
            for (const [f, d] of [...tests.entries()].slice(0, limit)) {
              parts.push(`  [深度${d}] ${f}`)
            }
            if (tests.size > limit) parts.push(`  …还有 ${tests.size - limit} 个`)
          }
          if (tests.size === 0 && !params.includeTests) {
            parts.push("\n（未发现受影响测试文件；传 includeTests=true 可包含测试文件。）")
          }
          return { title: "codegraph_affected", metadata: {}, output: parts.join("\n") }
        }),
    }
  }),
)
