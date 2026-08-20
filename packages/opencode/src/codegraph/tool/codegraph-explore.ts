import { Effect, Schema } from "effect"
import DESCRIPTION from "./codegraph-explore.txt"
import * as Tool from "../../tool/tool"
import { CodegraphStore as S } from "../store"
import { indexStateNote, resolveScopeOrGuide } from "../scope"
import { isLowConfidenceQuery, isTestFile, kindBonus, nameMatchBonus } from "../search"

export const Parameters = Schema.Struct({
  query: Schema.String.annotate({
    description:
      "符号名、文件名或短代码术语的组合（如 \"AuthService loginUser session-manager\"）。可以是自然语言描述。",
  }),
  maxSymbols: Schema.optional(Schema.Number.annotate({
    description: "最多返回的符号数（默认 30，上限 100）",
  })),
})

// ── Explore output allocation, ported from codegraph's mcp/tools.ts (MIT) ──
//
// The original splits a character envelope across candidate files: relevance
// scores rank the files, a relative cliff prunes peripheral ones, and the rest
// splits in proportion to weight. We render symbol listings, not source bodies,
// so here the budget unit is SYMBOLS and `maxSymbols` plays the envelope's
// role. Ported pieces: RELEVANCE_KIND_WEIGHT (kind weights), the weak-kind
// usage-isolation test, rankPenalty (test/generated dampening), the tiered
// per-project max-files budget, and allocateExploreBudget (cliff + weighted
// split, with spine files boosted and cliff-exempt).

/** How strongly a match on a symbol of this kind corroborates its FILE. */
export const RELEVANCE_KIND_WEIGHT: Readonly<Record<string, number>> = {
  function: 1, method: 1, class: 1, struct: 1, union: 1, interface: 1, trait: 1,
  protocol: 1, component: 1, route: 1, enum: 1, type_alias: 1, constructor: 1,
  namespace: 0.8, module: 0.8,
  property: 0.5, field: 0.5, enum_member: 0.35,
  file: 0.5,
  constant: 0.35, variable: 0.3, parameter: 0.15,
}
const DEFAULT_RELEVANCE_KIND_WEIGHT = 0.5

/** Kinds whose evidentiary value depends on whether anything USES them. */
const WEAK_RELEVANCE_KINDS = new Set(["constant", "variable", "parameter", "field", "property", "enum_member"])

/** Weight for a weak-kind symbol with no usage edge at all. */
const ISOLATED_WEAK_KIND_WEIGHT = 0.08

/** Edges that mean "this symbol is used" (mirrors codegraph RELEVANCE_USAGE_EDGES). */
const USAGE_EDGE_KINDS = [
  "calls", "references", "extends", "implements", "overrides",
  "instantiates", "returns", "type_of", "decorates",
]

const GENERATED_RANK_PENALTY = 0.3
const LOW_VALUE_RANK_PENALTY = 0.5

/**
 * Rank penalty, applied to BOTH the relevance score and the allocation `worth`
 * (generated/test files demoted twice, exactly like codegraph CG-10/CG-12).
 */
export const rankPenalty = (filePath: string, generated: boolean): number =>
  (generated ? GENERATED_RANK_PENALTY : 1) * (isTestFile(filePath) ? LOW_VALUE_RANK_PENALTY : 1)

/** Allocation knobs, in SYMBOL units (original EXPLORE_ALLOCATION was chars). */
export const SYMBOL_ALLOCATION = {
  /** A file under this fraction of the top weight gets no symbols shown. */
  CLIFF_FRACTION: 0.15,
  /**
   * Ceiling on the cliff, in units of one full-strength direct match
   * (nameMatchBonus 80 + kindBonus 10) — a file that clears that is never
   * incidental, so no god-file may silence it.
   */
  CLIFF_MAX: 90,
  /** Every admitted file shows at least this many symbols. */
  MIN_SYMBOLS: 2,
  /** Safety valve: no single file's allowance exceeds this share of the budget. */
  MAX_SHARE: 0.7,
  /** Flow-spine files are weighted up and are exempt from the cliff. */
  SPINE_WEIGHT_BOOST: 2,
} as const

/** One candidate file's allocation inputs, in final rank order. */
export type ExploreFileCandidate = {
  path: string
  /** Post-`rankPenalty` relevance score. */
  score: number
  /** Post-`rankPenalty` byte/symbol worth (penalty applied a second time). */
  worth: number
  /** Carries a symbol on the call-path spine. */
  spine: boolean
}

export type SymbolAllocation = {
  /** path → max symbols it may show. Only holds admitted files. */
  allowances: Map<string, number>
  /** Files the cliff zeroed, in rank order — named, not shown. */
  cliffed: string[]
  /** The weight threshold the cliff fired at (0 when nothing was cliffed). */
  cliffAt: number
  /** Budget actually split among the admitted files. */
  pool: number
}

/** Tiered per-project max-files budget (original getExploreOutputBudget, files dimension only). */
export const getExploreSymbolBudget = (fileCount: number): { defaultMaxFiles: number } => {
  if (fileCount < 150) return { defaultMaxFiles: 4 }
  if (fileCount < 500) return { defaultMaxFiles: 5 }
  if (fileCount < 5000) return { defaultMaxFiles: 8 }
  return { defaultMaxFiles: 8 }
}

/**
 * Split `maxSymbols` across ranked candidates in proportion to relevance, with
 * a hard relative cliff. `candidates` must arrive in FINAL RANK ORDER —
 * `maxFiles` is applied to the survivors of the cliff, in that order, so
 * cliffing hands a slot to the next file down rather than leaving it unused.
 */
export const allocateSymbolBudget = (
  candidates: readonly ExploreFileCandidate[],
  maxSymbols: number,
  maxFiles: number,
): SymbolAllocation => {
  const A = SYMBOL_ALLOCATION
  const empty: SymbolAllocation = { allowances: new Map(), cliffed: [], cliffAt: 0, pool: 0 }
  if (candidates.length === 0) return empty

  // A non-finite weight is no evidence rather than propagated (Infinity would
  // make every share Infinity/Infinity = NaN).
  const weightOf = (c: ExploreFileCandidate) => {
    const w = Math.max(0, c.score) * Math.max(0, Math.min(1, c.worth)) * (c.spine ? A.SPINE_WEIGHT_BOOST : 1)
    return Number.isFinite(w) ? w : 0
  }

  const weights = new Map(candidates.map((c) => [c.path, weightOf(c)]))
  const topWeight = Math.max(...weights.values())
  if (!(topWeight > 0)) return empty

  // Cliff over the WHOLE list before `maxFiles`, so slots freed here are
  // genuinely handed on.
  const cliffAt = Math.min(topWeight * A.CLIFF_FRACTION, A.CLIFF_MAX)
  const cliffed: string[] = []
  let admitted: ExploreFileCandidate[] = []
  for (const c of candidates) {
    if (!c.spine && (weights.get(c.path) ?? 0) < cliffAt) cliffed.push(c.path)
    else admitted.push(c)
  }
  // Never cliff every candidate: an empty response costs a whole round-trip.
  if (admitted.length === 0) {
    admitted = [candidates[0]!]
    const freed = cliffed.indexOf(candidates[0]!.path)
    if (freed >= 0) cliffed.splice(freed, 1)
  }
  // `maxFiles` prunes the tail of the RANKED list — but a spine file is the
  // call-path core, so the file cap must never drop it. Non-spine files still
  // free their slot to the next file down.
  const spineAdmitted = admitted.filter((c) => c.spine)
  const nonSpine = admitted.filter((c) => !c.spine)
  const nonSpineBudget = Math.max(0, maxFiles - spineAdmitted.length)
  for (const c of nonSpine.slice(nonSpineBudget)) cliffed.push(c.path)
  admitted = [...spineAdmitted, ...nonSpine.slice(0, nonSpineBudget)]

  // Serve fewer files well rather than many badly: the budget must afford
  // MIN_SYMBOLS for everything admitted.
  const affordable = Math.max(1, Math.floor(maxSymbols / A.MIN_SYMBOLS))
  if (admitted.length > affordable) {
    const byWeight = [...admitted].sort((a, b) => (weights.get(b.path) ?? 0) - (weights.get(a.path) ?? 0))
    const keep = new Set(byWeight.slice(0, affordable).map((c) => c.path))
    for (const c of admitted) if (c.spine) keep.add(c.path)
    for (const c of admitted) if (!keep.has(c.path)) cliffed.push(c.path)
    admitted = admitted.filter((c) => keep.has(c.path))
  }

  const allowances = new Map<string, number>()
  const pool = Math.max(0, maxSymbols)
  const total = admitted.reduce((s, c) => s + (weights.get(c.path) ?? 0), 0)
  if (total <= 0 || admitted.length === 0) return { allowances, cliffed, cliffAt, pool }
  // Everyone gets MIN_SYMBOLS; the REMAINDER splits by weight — the floor keeps
  // a diffuse query useful, the remainder concentrates a precise one.
  const ceiling = Math.round(maxSymbols * A.MAX_SHARE)
  const floors = Math.min(pool, A.MIN_SYMBOLS * admitted.length)
  const remainder = Math.max(0, pool - floors)
  for (const c of admitted) {
    const share = Math.floor(floors / admitted.length)
      + Math.floor((remainder * (weights.get(c.path) ?? 0)) / total)
    allowances.set(c.path, Math.min(share, ceiling))
  }
  return { allowances, cliffed, cliffAt, pool }
}

/**
 * Core explore pipeline: search → relevance-score files → detect call-path
 * spine → budget allocation → markdown listing. Exported as a plain async
 * function so the tool wraps it in Effect and tests can drive it directly.
 */
export const runCodegraphExplore = async (
  scope: S.Scope,
  query: string,
  maxSymbols: number,
): Promise<string> => {
  const note = await indexStateNote(scope)
  const limit = Math.min(Math.max(maxSymbols, 1), 100)
  const results = await S.searchNodes(scope, query, { limit })
  const lowConfidence = isLowConfidenceQuery(query)
  if (results.length === 0) {
    return `${note}未找到与 "${query}" 相关的符号。\n请换用更具体的符号名（如 camelCase/snake_case 的真实符号），或用 codegraph_search 试相似名。`
  }

  // Weak-kind usage-isolation probe (CG-10): a constant/variable/etc that
  // NOTHING uses is a name collision, not evidence. Full-graph probe, cached
  // per node, only paid by weak kinds.
  const weightByNode = new Map<string, number>()
  await Promise.all(
    results.map(async (r) => {
      const weight = RELEVANCE_KIND_WEIGHT[r.kind] ?? DEFAULT_RELEVANCE_KIND_WEIGHT
      if (!WEAK_RELEVANCE_KINDS.has(r.kind)) {
        weightByNode.set(r.id, weight)
        return
      }
      const [ins, outs] = await Promise.all([
        S.incomingEdges(scope, r.id, USAGE_EDGE_KINDS),
        S.outgoingEdges(scope, r.id, USAGE_EDGE_KINDS),
      ])
      weightByNode.set(r.id, ins.length > 0 || outs.length > 0 ? weight : ISOLATED_WEAK_KIND_WEIGHT)
    }),
  )

  // Call-path spine: symbols connected by call edges within the matched set.
  const idSet = new Set(results.map((r) => r.id))
  const calleeByNode = new Map<string, Awaited<ReturnType<typeof S.getCallees>>>()
  await Promise.all(
    results.map(async (r) => {
      calleeByNode.set(r.id, await S.getCallees(scope, r.id, 1))
    }),
  )
  const spineEdges: Array<{ from: S.GraphNode; to: S.GraphNode }> = []
  const spineNodeIds = new Set<string>()
  const seenSpine = new Set<string>()
  for (const r of results) {
    for (const c of calleeByNode.get(r.id) ?? []) {
      if (!idSet.has(c.node.id)) continue
      const key = `${r.id}|${c.node.id}`
      if (seenSpine.has(key)) continue
      seenSpine.add(key)
      spineEdges.push({ from: r, to: c.node })
      spineNodeIds.add(r.id)
      spineNodeIds.add(c.node.id)
    }
  }
  const spineFiles = new Set(results.filter((r) => spineNodeIds.has(r.id)).map((r) => r.file_path))

  // Group by file; each file's score is the sum of matched-symbol evidence
  // (name + kind bonus) scaled by the kind's relevance weight, then rankPenalty.
  const byFile = new Map<string, { nodes: S.GraphNode[]; score: number }>()
  for (const r of results) {
    const evidence = nameMatchBonus(r.name, query) + kindBonus(r.kind)
    const group = byFile.get(r.file_path) ?? { nodes: [], score: 0 }
    group.nodes.push(r)
    group.score += evidence * (weightByNode.get(r.id) ?? 0)
    byFile.set(r.file_path, group)
  }
  for (const [fp, group] of byFile) {
    group.score *= rankPenalty(fp, group.nodes.some((n) => n.is_generated === 1))
  }

  // Budget: tier by project file count, allocate in final rank order (spine
  // files first, then score).
  const idx = await S.getIndex(scope)
  const fileCount = idx?.files_total && idx.files_total > 0 ? idx.files_total : byFile.size
  const { defaultMaxFiles } = getExploreSymbolBudget(fileCount)
  const ranked = [...byFile.entries()].sort((a, b) => {
    const aSpine = spineFiles.has(a[0]) ? 1 : 0
    const bSpine = spineFiles.has(b[0]) ? 1 : 0
    if (aSpine !== bSpine) return bSpine - aSpine
    return b[1].score - a[1].score
  })
  const alloc = allocateSymbolBudget(
    ranked.map(([fp, group]) => ({
      path: fp,
      score: group.score,
      worth: rankPenalty(fp, group.nodes.some((n) => n.is_generated === 1)),
      spine: spineFiles.has(fp),
    })),
    limit,
    defaultMaxFiles,
  )

  const parts: string[] = []
  parts.push(`${note}相关符号（${results.length} 个，分布 ${byFile.size} 个文件）:`)
  parts.push("")
  for (const [fp, group] of ranked) {
    if (!alloc.allowances.has(fp)) continue
    const isSpine = spineFiles.has(fp)
    parts.push(`#### ${fp}${isSpine ? "  [spine]" : ""}`)
    const shown = group.nodes.sort((a, b) => a.start_line - b.start_line).slice(0, isSpine ? group.nodes.length : alloc.allowances.get(fp) ?? 0)
    for (const n of shown) {
      const sig = n.signature ? ` ${n.signature}` : ""
      parts.push(`- L${n.start_line}  ${n.kind} ${n.qualified_name}${sig}`)
    }
    if (shown.length < group.nodes.length) {
      parts.push(`- … 另有 ${group.nodes.length - shown.length} 个符号未展示（peripheral）`)
    }
    parts.push("")
  }
  if (spineEdges.length > 0) {
    parts.push(`调用关系（命中符号之间，调用路径核心）:`)
    parts.push(
      spineEdges
        .slice(0, 40)
        .map((e) => `${e.from.qualified_name} -> ${e.to.qualified_name} (${e.from.file_path}:${e.from.start_line})`)
        .join("\n"),
    )
    parts.push("")
  }
  if (alloc.cliffed.length > 0) {
    parts.push(`以下文件为 peripheral（相关度低于预算门槛，未展示符号，可单独 explore 或 codegraph_search）:`)
    for (const fp of alloc.cliffed) parts.push(`- ${fp}`)
    parts.push("")
  }

  parts.push("(以上仅为符号位置清单；源码正文请按 file:line 用 read 工具读取。若结果似偏靶，改用真实符号名重试。)")
  if (lowConfidence) {
    parts.push("")
    parts.push("⚠️ LOW_CONFIDENCE：本查询仅由常见词构成，命中符号可能与真实目标偏差较大。请改用真实的 camelCase/snake_case 符号名（可用 codegraph_search 先确认）再查一次。")
  }
  return parts.join("\n").trimEnd()
}

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
          const output = yield* Effect.promise(() => runCodegraphExplore(scope, params.query, params.maxSymbols ?? 30))
          return { title: "codegraph_explore", metadata: {}, output }
        }),
    }
  }),
)
