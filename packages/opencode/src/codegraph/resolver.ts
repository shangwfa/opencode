import { CodegraphStore as S } from "./store"
import type { ExtractEdge, GraphNode, GraphRef, Scope } from "./store"

/**
 * Async reference resolver: turns `codegraph_ref` rows into `codegraph_edge`
 * edges by porting the core name-matcher strategies (codegraph's
 * resolution/name-matcher.ts) onto the PG store. The original is synchronous
 * over in-memory SQLite tables; here every lookup is an async PG query, so the
 * matching functions are async and the context methods return Promises.
 *
 * Strategy pipeline per ref (resolveOne), in confidence order:
 *   1. function-ref   — `function_ref` kind ONLY (function/method/class
 *      targets, same-file first, unique-only cross-file)
 *   2. file-path      — path-like names ("a/b.liquid", `Foo.h`) → file nodes
 *   3. qualified-name — reference_name containing `::`/`.` matched against
 *      qualified_name (call-site-file preference on ties)
 *   4. exact-name     — language-gated name match; single candidate hits, else
 *      findBestMatch path-proximity scoring
 *
 * Edge kinds follow the extraction mapping: calls→calls, references→references,
 * imports→imports, extends→extends, instantiates→instantiates,
 * implements→implements, decorates→decorates, function_ref→references.
 * All resolver edges carry provenance='resolver' and the ref's line/col.
 */

export type ResolveContext = {
  getNodesByName(name: string): Promise<GraphNode[]>
  getNodeById(id: string): Promise<GraphNode | null>
  getNodesByQualifiedName(qn: string): Promise<GraphNode[]>
}

export type ResolvedRef = {
  targetNodeId: string
  confidence: number
  resolvedBy: "exact-match" | "qualified-name" | "file-path" | "function-ref"
}

const DEFAULT_AMBIGUOUS_NAME_CEILING = 500
const parsedCeiling = Number.parseInt(process.env.CODEGRAPH_AMBIGUOUS_NAME_CEILING ?? "", 10)
const AMBIGUOUS_NAME_CEILING = Number.isFinite(parsedCeiling) && parsedCeiling > 0 ? parsedCeiling : DEFAULT_AMBIGUOUS_NAME_CEILING

const KIND_MAP: Record<string, string> = {
  calls: "calls",
  references: "references",
  imports: "imports",
  extends: "extends",
  instantiates: "instantiates",
  implements: "implements",
  decorates: "decorates",
  function_ref: "references",
}

export const REF_BATCH = 500

// ---------------------------------------------------------------------------
// Language families (name-matcher.ts L140)
// ---------------------------------------------------------------------------

const LANGUAGE_FAMILY: Record<string, string> = {
  java: "jvm", kotlin: "jvm", scala: "jvm",
  swift: "apple", objc: "apple",
  typescript: "web", tsx: "web", javascript: "web", jsx: "web", arkts: "web",
  c: "c", cpp: "c",
  csharp: "dotnet", razor: "dotnet",
}

export const sameLanguageFamily = (a: string, b: string): boolean => {
  if (a === b) return true
  const fa = LANGUAGE_FAMILY[a]
  return fa !== undefined && fa === LANGUAGE_FAMILY[b]
}

export const isKnownLanguageFamily = (lang: string): boolean => LANGUAGE_FAMILY[lang] !== undefined

export const crossesKnownFamily = (a: string, b: string): boolean =>
  isKnownLanguageFamily(a) && isKnownLanguageFamily(b) && !sameLanguageFamily(a, b)

const applyLanguageGate = (candidates: GraphNode[], ref: GraphRef): GraphNode[] => {
  if (ref.reference_kind === "references" || ref.reference_kind === "function_ref") {
    return candidates.filter((c) => sameLanguageFamily(c.language, ref.language))
  }
  if (ref.reference_kind === "imports") {
    return candidates.filter((c) => !crossesKnownFamily(c.language, ref.language))
  }
  return candidates
}

// ---------------------------------------------------------------------------
// Path proximity scoring (name-matcher.ts findBestMatch / computePathProximity)
// ---------------------------------------------------------------------------

const pathProximityFromDirs = (dir1: string[], filePath2: string): number => {
  const dir2 = filePath2.split("/")
  dir2.pop()
  let shared = 0
  const limit = Math.min(dir1.length, dir2.length)
  for (let i = 0; i < limit; i++) {
    if (dir1[i] === dir2[i]) shared++
    else break
  }
  return Math.min(shared * 15, 80)
}

export const computePathProximity = (filePath1: string, filePath2: string): number => {
  const dir1 = filePath1.split("/")
  dir1.pop()
  return pathProximityFromDirs(dir1, filePath2)
}

const preferCallSiteFile = (nodes: GraphNode[], callSiteFile: string): GraphNode[] => {
  if (nodes.length < 2) return nodes
  const same: GraphNode[] = []
  const other: GraphNode[] = []
  for (const n of nodes) {
    if (n.file_path === callSiteFile) same.push(n)
    else other.push(n)
  }
  return same.length ? [...same, ...other] : nodes
}

const findBestMatch = (ref: GraphRef, candidates: GraphNode[]): GraphNode | null => {
  let bestScore = -1
  let bestNode: GraphNode | null = null
  const refDirs = ref.file_path.split("/")
  refDirs.pop()

  const hasSameLanguage = candidates.some((c) => c.language === ref.language)

  for (const candidate of candidates) {
    if (hasSameLanguage && candidate.language !== ref.language) continue

    let score = 0
    if (candidate.file_path === ref.file_path) score += 100
    score += pathProximityFromDirs(refDirs, candidate.file_path)
    if (candidate.language === ref.language) score += 50
    else score -= 80

    if (ref.reference_kind === "calls" && (candidate.kind === "function" || candidate.kind === "method")) score += 25
    if (ref.reference_kind === "instantiates" && (candidate.kind === "class" || candidate.kind === "struct" || candidate.kind === "union" || candidate.kind === "interface")) score += 25
    if (ref.reference_kind === "decorates") {
      if (candidate.kind === "function" || candidate.kind === "method") score += 25
      else if (candidate.kind === "class" || candidate.kind === "interface") score += 15
    }
    if (candidate.is_exported) score += 10
    if (candidate.file_path === ref.file_path && candidate.start_line) {
      const distance = Math.abs(candidate.start_line - ref.line)
      score += Math.max(0, 20 - distance / 10)
    }

    if (score > bestScore) {
      bestScore = score
      bestNode = candidate
    }
  }
  return bestNode
}

const pickClosestFileNode = (candidates: GraphNode[], ref: GraphRef): GraphNode => {
  const dirOf = (p: string): string => {
    const i = p.lastIndexOf("/")
    return i >= 0 ? p.slice(0, i) : ""
  }
  const refDir = dirOf(ref.file_path)
  const sameDir = candidates.filter((c) => dirOf(c.file_path) === refDir)
  const pool = sameDir.length > 0 ? sameDir : candidates
  let best = pool[0]!
  let bestScore = -Infinity
  for (const c of pool) {
    const score = computePathProximity(ref.file_path, c.file_path) + (sameLanguageFamily(c.language, ref.language) ? 5 : 0)
    if (score > bestScore) {
      bestScore = score
      best = c
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Strategy: file-path match (name-matcher.ts matchByFilePath)
// ---------------------------------------------------------------------------

const matchByFilePath = async (ref: GraphRef, ctx: ResolveContext): Promise<ResolvedRef | null> => {
  if (!ref.reference_name.includes("/") && !/\.[A-Za-z][A-Za-z0-9]{0,3}$/.test(ref.reference_name)) return null
  const fileName = ref.reference_name.split("/").pop()
  if (!fileName) return null
  const fileNodes = (await ctx.getNodesByName(fileName)).filter((n) => n.kind === "file")
  if (fileNodes.length === 0) return null

  const exact = fileNodes.find((n) => n.qualified_name === ref.reference_name || n.file_path === ref.reference_name)
  if (exact) return { targetNodeId: exact.id, confidence: 0.95, resolvedBy: "file-path" }

  const suffix = fileNodes.filter((n) => n.qualified_name.endsWith(ref.reference_name) || n.file_path.endsWith(ref.reference_name))
  if (suffix.length > 0) return { targetNodeId: pickClosestFileNode(suffix, ref).id, confidence: 0.85, resolvedBy: "file-path" }

  if (fileNodes.length === 1) return { targetNodeId: fileNodes[0].id, confidence: 0.7, resolvedBy: "file-path" }
  return null
}

// ---------------------------------------------------------------------------
// Strategy: qualified-name match (name-matcher.ts matchByQualifiedName)
// ---------------------------------------------------------------------------

const matchByQualifiedName = async (ref: GraphRef, ctx: ResolveContext): Promise<ResolvedRef | null> => {
  if (!ref.reference_name.includes("::") && !ref.reference_name.includes(".")) return null

  const keepForRef = (nodes: GraphNode[]): GraphNode[] =>
    ref.reference_kind === "calls"
      ? nodes.filter((n) => !(n.kind === "constant" && (n.language === "yaml" || n.language === "properties")))
      : nodes

  const candidates = keepForRef(await ctx.getNodesByQualifiedName(ref.reference_name))
  if (candidates.length === 1) return { targetNodeId: candidates[0].id, confidence: 0.95, resolvedBy: "qualified-name" }

  if (candidates.length > 1) {
    const ordered = preferCallSiteFile(candidates, ref.file_path)
    if (ordered[0]!.file_path === ref.file_path) return { targetNodeId: ordered[0]!.id, confidence: 0.95, resolvedBy: "qualified-name" }
  }

  const parts = ref.reference_name.split(/[:.]/)
  const lastName = parts[parts.length - 1]
  if (lastName) {
    const partial = preferCallSiteFile(
      keepForRef(await ctx.getNodesByName(lastName)).filter((c) => c.qualified_name.endsWith(ref.reference_name)),
      ref.file_path,
    )[0]
    if (partial) return { targetNodeId: partial.id, confidence: 0.85, resolvedBy: "qualified-name" }
  }
  return null
}

// ---------------------------------------------------------------------------
// Strategy: lexical reachability of nested locals (name-matcher.ts
// isLexicallyReachable) — a candidate function nested inside another function
// is only callable from within its container's line range.
// ---------------------------------------------------------------------------

const isLexicallyReachable = async (candidate: GraphNode, ref: GraphRef, ctx: ResolveContext): Promise<boolean> => {
  if (candidate.kind !== "function") return true
  const qn = candidate.qualified_name
  if (!qn || !qn.includes("::")) return true
  const parentQn = qn.slice(0, qn.lastIndexOf("::"))
  const containers = (await ctx.getNodesByQualifiedName(parentQn)).filter(
    (p) =>
      p.file_path === candidate.file_path &&
      (p.kind === "function" || p.kind === "method") &&
      p.start_line <= candidate.start_line &&
      p.end_line >= candidate.end_line,
  )
  if (containers.length === 0) return true
  return ref.file_path === candidate.file_path && containers.some((p) => ref.line >= p.start_line && ref.line <= p.end_line)
}

// ---------------------------------------------------------------------------
// Strategy: exact-name match (name-matcher.ts matchByExactName)
// ---------------------------------------------------------------------------

const matchByExactName = async (ref: GraphRef, ctx: ResolveContext): Promise<ResolvedRef | null> => {
  const gated = applyLanguageGate(await ctx.getNodesByName(ref.reference_name), ref).filter((n) => n.kind !== "import")
  const candidates: GraphNode[] = []
  for (const n of gated) {
    if (await isLexicallyReachable(n, ref, ctx)) candidates.push(n)
  }
  if (candidates.length === 0) return null

  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0].language !== ref.language
    return { targetNodeId: candidates[0].id, confidence: isCrossLanguage ? 0.5 : 0.9, resolvedBy: "exact-match" }
  }

  if (candidates.length > AMBIGUOUS_NAME_CEILING) return null

  const bestMatch = findBestMatch(ref, candidates)
  if (!bestMatch) return null
  const proximity = computePathProximity(ref.file_path, bestMatch.file_path)
  return { targetNodeId: bestMatch.id, confidence: proximity >= 30 ? 0.7 : 0.4, resolvedBy: "exact-match" }
}

// ---------------------------------------------------------------------------
// Strategy: function-as-value reference (name-matcher.ts matchFunctionRef) —
// used ONLY for `function_ref` kind. Function/method targets, bareFnOnly per
// language, same-file first, unique-or-drop cross-file.
// ---------------------------------------------------------------------------

const matchFunctionRef = async (ref: GraphRef, ctx: ResolveContext): Promise<ResolvedRef | null> => {
  if (ref.reference_name.startsWith("this.")) return null

  const bareFnOnly =
    ref.language === "typescript" || ref.language === "tsx" ||
    ref.language === "javascript" || ref.language === "jsx" ||
    ref.language === "arkts" || ref.language === "cpp" ||
    ref.language === "python" || ref.language === "php"
  const bareClassOk = ref.language === "python"

  if (ref.reference_name.includes("::")) {
    const memberName = ref.reference_name.slice(ref.reference_name.lastIndexOf("::") + 2)
    const scoped = (await ctx.getNodesByName(memberName)).filter(
      (n) =>
        (n.kind === "function" || n.kind === "method") &&
        sameLanguageFamily(n.language, ref.language) &&
        n.id !== ref.from_node_id &&
        (n.qualified_name === ref.reference_name || n.qualified_name.endsWith(`::${ref.reference_name}`)),
    )
    if (scoped.length === 0) return null
    const sameFileScoped = scoped.filter((n) => n.file_path === ref.file_path)
    const pool = sameFileScoped.length > 0 ? sameFileScoped : scoped
    if (sameFileScoped.length === 0 && scoped.length > 1) return null
    const target = pool.reduce((a, b) => (a.start_line <= b.start_line ? a : b))
    return { targetNodeId: target.id, confidence: 0.9, resolvedBy: "function-ref" }
  }

  let candidates = (await ctx.getNodesByName(ref.reference_name)).filter(
    (n) =>
      (n.kind === "function" || (!bareFnOnly && n.kind === "method") || (bareClassOk && n.kind === "class")) &&
      sameLanguageFamily(n.language, ref.language) &&
      n.id !== ref.from_node_id,
  )
  if (candidates.length === 0) return null

  if (ref.language === "swift" && candidates.some((n) => n.kind === "method")) {
    const fromNode = await ctx.getNodeById(ref.from_node_id)
    const sep = fromNode ? fromNode.qualified_name.lastIndexOf("::") : -1
    const classPrefix = fromNode && sep > 0 ? fromNode.qualified_name.slice(0, sep) : null
    candidates = candidates.filter((n) => {
      if (n.kind !== "method") return true
      if (!classPrefix) return false
      const mSep = n.qualified_name.lastIndexOf("::")
      if (mSep <= 0) return false
      const methodPrefix = n.qualified_name.slice(0, mSep)
      return methodPrefix === classPrefix || methodPrefix.endsWith(`::${classPrefix}`) || classPrefix.endsWith(`::${methodPrefix}`)
    })
    if (candidates.length === 0) return null
  }

  const sameFile = candidates.filter((n) => n.file_path === ref.file_path)
  if (sameFile.length > 0) {
    if (ref.language === "swift" && sameFile.length > 1 && sameFile.every((n) => n.kind === "method")) return null
    const target = sameFile.reduce((a, b) => (a.start_line <= b.start_line ? a : b))
    return { targetNodeId: target.id, confidence: sameFile.length === 1 ? 0.95 : 0.9, resolvedBy: "function-ref" }
  }

  if (candidates.length === 1) return { targetNodeId: candidates[0].id, confidence: 0.8, resolvedBy: "function-ref" }
  return null
}

// ---------------------------------------------------------------------------
// resolveOne: strategy pipeline
// ---------------------------------------------------------------------------

export const resolveOne = async (ref: GraphRef, ctx: ResolveContext): Promise<ResolvedRef | null> => {
  if (ref.reference_kind === "function_ref") return matchFunctionRef(ref, ctx)
  const byPath = await matchByFilePath(ref, ctx)
  if (byPath) return byPath
  const byQn = await matchByQualifiedName(ref, ctx)
  if (byQn) return byQn
  return matchByExactName(ref, ctx)
}

// ---------------------------------------------------------------------------
// resolveRefs: batch entry point
// ---------------------------------------------------------------------------

type Memoized = { getNodesByName(name: string): Promise<GraphNode[]>; getNodeById(id: string): Promise<GraphNode | null>; getNodesByQualifiedName(qn: string): Promise<GraphNode[]> }

/**
 * Context memoized by exact query argument — a large scope has far fewer
 * DISTINCT reference names than ref rows, so each unique name/qualified-name/
 * node-id is fetched once and shared across every ref that needs it. This is
 * what keeps an 80k-ref run at a few thousand PG round-trips instead of
 * hundreds of thousands.
 */
const memoizedContext = (scope: Scope): Memoized => {
  const byName = new Map<string, Promise<GraphNode[]>>()
  const byQn = new Map<string, Promise<GraphNode[]>>()
  const byId = new Map<string, Promise<GraphNode | null>>()
  return {
    getNodesByName: (name) => {
      const hit = byName.get(name)
      if (hit) return hit
      const p = S.findNodesByName(scope, name)
      byName.set(name, p)
      return p
    },
    getNodeById: (id) => {
      const hit = byId.get(id)
      if (hit) return hit
      const p = S.getNodeById(scope, id).then((n) => n ?? null)
      byId.set(id, p)
      return p
    },
    getNodesByQualifiedName: (qn) => {
      const hit = byQn.get(qn)
      if (hit) return hit
      const p = S.getNodesByQualifiedName(scope, qn)
      byQn.set(qn, p)
      return p
    },
  }
}

const edgeFromResolved = (scope: Scope, ref: GraphRef, result: ResolvedRef): ExtractEdge | null => {
  if (ref.from_node_id === result.targetNodeId) return null // self-loop is not a dependency edge
  return {
    scope,
    source: ref.from_node_id,
    target: result.targetNodeId,
    kind: KIND_MAP[ref.reference_kind] ?? ref.reference_kind,
    metadata: { resolvedBy: result.resolvedBy, confidence: result.confidence },
    line: ref.line,
    col: ref.col,
    provenance: "resolver",
  }
}

const mapLimit = async <A, B>(items: A[], limit: number, fn: (a: A) => Promise<B>): Promise<B[]> => {
  const out = new Array<B>(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
  return out
}

export type ResolveStats = {
  total: number
  resolved: number
  failed: number
  edges: number
  byMethod: Record<string, number>
}

/**
 * Resolve every pending ref in `scope` (or only those of `filePaths`, for the
 * incremental case) and persist the resulting edges. Idempotent per scope:
 * resolver edges are replaced wholesale (scope-wide or per-file for
 * incremental) inside one advisory-locked transaction, so re-running never
 * duplicates edges.
 */
export const resolveRefs = async (scope: Scope, filePaths?: string[]): Promise<ResolveStats> => {
  const ctx = memoizedContext(scope)
  const stats: ResolveStats = { total: 0, resolved: 0, failed: 0, edges: 0, byMethod: {} }
  const edges: ExtractEdge[] = []
  const resolvedIds: number[] = []
  const failedIds: number[] = []
  // Same (source,target,kind,line) can come from several refs (same line at
  // different columns resolving to the same symbol) — dedupe so one logical
  // call site yields one edge.
  const seen = new Set<string>()

  let afterId = 0
  for (;;) {
    const refs = await S.listPendingRefs(scope, { limit: REF_BATCH, afterId, filePaths })
    if (refs.length === 0) break
    const results = await mapLimit(refs, 8, (ref) => resolveOne(ref, ctx))
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!
      const result = results[i]!
      stats.total++
      const edge = result ? edgeFromResolved(scope, ref, result) : null
      if (edge) {
        const key = `${edge.source}|${edge.target}|${edge.kind}|${edge.line}`
        if (!seen.has(key)) {
          seen.add(key)
          edges.push(edge)
        }
        resolvedIds.push(ref.id)
        stats.resolved++
        stats.byMethod[result.resolvedBy] = (stats.byMethod[result.resolvedBy] ?? 0) + 1
      } else {
        failedIds.push(ref.id)
        stats.failed++
      }
    }
    afterId = refs[refs.length - 1]!.id
  }

  if (edges.length > 0 || filePaths) {
    await S.replaceResolverEdges(scope, edges, filePaths)
    await S.markRefsStatus(scope, resolvedIds, "resolved")
    await S.markRefsStatus(scope, failedIds, "failed")
  }
  stats.edges = edges.length
  return stats
}

export * as CodegraphResolver from "./resolver"
