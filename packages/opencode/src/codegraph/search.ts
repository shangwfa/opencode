import * as path from "path"

/**
 * Search-ranking heuristics ported from codegraph's search/query-utils.ts
 * (MIT) so SaaS search quality matches the original (test-file dampening,
 * name/kind bonuses, path relevance). Pure functions — no I/O.
 */

/** True when a path looks like a test/spec/example/fixture file. */
export const isTestFile = (filePath: string): boolean => {
  const lower = filePath.toLowerCase()
  const fileName = path.basename(filePath)
  const lowerName = fileName.toLowerCase()

  if (
    lowerName.startsWith("test_") ||
    lowerName.startsWith("test.") ||
    /[._-](test|tests|spec|specs)\.[a-z0-9]+$/.test(lowerName) ||
    /(?:Test|Tests|TestCase|Tester|Spec|Specs)\.[A-Za-z0-9]+$/.test(fileName)
  )
    return true

  if (
    lower.includes("/tests/") || lower.includes("/test/") ||
    lower.includes("/__tests__/") || lower.includes("/spec/") ||
    lower.includes("/specs/") || lower.includes("/testlib/") ||
    lower.includes("/testing/") ||
    lower.startsWith("test/") || lower.startsWith("tests/") ||
    lower.startsWith("spec/") || lower.startsWith("specs/") ||
    /(?:^|\/)[A-Za-z0-9]*(?:Test|Tests|Spec)\//.test(filePath)
  )
    return true

  const nonProd = ["integration", "sample", "samples", "example", "examples", "fixture", "fixtures", "benchmark", "benchmarks", "demo", "demos"]
  for (const dir of nonProd) {
    if (lower.includes(`/${dir}/`) || lower.startsWith(`${dir}/`)) return true
  }
  return false
}

/** Bonus when a node's name matches the query (exact > prefix > substring). */
export const nameMatchBonus = (nodeName: string, query: string): number => {
  const nameLower = nodeName.toLowerCase()
  const rawTerms = query
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s_.\-]+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2)
  const queryTokens = query.split(/\s+/).map((t) => t.toLowerCase()).filter((t) => t.length >= 2)
  const queryLower = query.replace(/\s+/g, "").toLowerCase()

  if (nameLower === queryLower) return 80
  if (queryTokens.length > 1 && queryTokens.includes(nameLower)) return 60
  if (nameLower.startsWith(queryLower)) {
    const ratio = queryLower.length / nameLower.length
    return Math.round(10 + 30 * ratio)
  }
  if (rawTerms.length > 1 && rawTerms.every((t) => nameLower.includes(t))) return 15
  if (nameLower.includes(queryLower)) return 10
  return 0
}

/** Kind-based relevance bonus (functions/classes > variables/imports). */
export const kindBonus = (kind: string): number => {
  const bonuses: Record<string, number> = {
    function: 10, method: 10, class: 8, interface: 9, type_alias: 6,
    struct: 6, union: 6, trait: 9, enum: 5, component: 8, route: 9,
    module: 4, property: 3, field: 3, variable: 2, constant: 3,
    import: 1, export: 1, parameter: 0, namespace: 4, file: 0,
    protocol: 9, enum_member: 3,
  }
  return bonuses[kind] ?? 0
}

/** Path relevance: filename > directory > generic, minus test-file dampening. */
export const scorePathRelevance = (filePath: string, query: string): number => {
  const pathLower = filePath.toLowerCase()
  const fileName = path.basename(filePath).toLowerCase()
  const dirName = path.dirname(filePath).toLowerCase()
  let score = 0

  const words = query.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return 0

  for (const word of words) {
    const subtokens = word
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[\s_.\-]+/)
      .filter((t) => t.length >= 2)
    if (subtokens.length === 0) continue
    if (subtokens.some((t) => fileName.includes(t))) score += 10
    else if (subtokens.some((t) => dirName.includes(t))) score += 5
    else if (subtokens.some((t) => pathLower.includes(t))) score += 3
  }

  const qLower = query.toLowerCase()
  const isTestQuery = qLower.includes("test") || qLower.includes("spec")
  if (!isTestQuery && isTestFile(filePath)) score -= 15
  return score
}

/**
 * Whether a query token looks like a deliberately-typed code identifier
 * (camelCase / snake_case / contains a digit) rather than a plain word.
 * Used to decide if a single exact match is trustworthy enough to skip the
 * LOW_CONFIDENCE flag on explore.
 */
export const isDistinctiveIdentifier = (token: string): boolean => {
  if (!token) return false
  if (/[_0-9]/.test(token)) return true
  if (/[A-Z]/.test(token.slice(1))) return true
  return false
}

/**
 * Low-confidence signal for explore: true when NONE of the query's tokens is a
 * distinctive identifier — i.e. the query is all common words ("data handler
 * flow") so the entry points are weakly corroborated. Matches codegraph's
 * "query resolved only to isolated common-word matches" definition.
 */
export const isLowConfidenceQuery = (query: string): boolean => {
  const tokens = query.split(/[\s.,;:!?()]+/).filter((t) => t.length >= 2)
  if (tokens.length === 0) return true
  return !tokens.some(isDistinctiveIdentifier)
}
