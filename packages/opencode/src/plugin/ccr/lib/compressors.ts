import { estimateTokens, type CcrConfig } from "./config"
import { extractQueryTerms, scoreText, type QueryTerms } from "./relevance"

export type CompressionStrategy = "json" | "search" | "config" | "log" | "diff" | "tabular" | "html" | "code" | "lines"

export interface CompressionPreview {
  strategy: CompressionStrategy
  preview: string
  /** Item counts for JSON-array compressions, surfaced in the marker. */
  itemCount?: { original: number; compressed: number }
}

/** Any of these substrings means the text is already compressed output
 *  carrying a live retrieval handle — re-compressing it risks orphaning
 *  the hash (Headroom issue #2694). */
export const CCR_MARKER_PATTERNS = [
  "[ccr:",
  "Retrieve original: hash=",
  "Retrieve more: hash=",
  "<<ccr:",
] as const

const JSON_STRING_VALUE_LIMIT = 400
const JSON_STRING_KEEP = 160

// ─── SmartCrusher selection parity (headroom-core smart_crusher) ────────────
const ERROR_KEYWORDS = [
  "error",
  "exception",
  "failed",
  "failure",
  "critical",
  "fatal",
  "crash",
  "panic",
  "abort",
  "timeout",
  "denied",
  "rejected",
]
const MAX_ITEMS_AFTER_CRUSH = 15
const FIRST_FRACTION = 0.3
const LAST_FRACTION = 0.15
const LOSSLESS_MIN_SAVINGS = 0.15

/** Lossless table fold (Headroom compaction parity): only for arrays of plain
 *  objects sharing one key set with scalar values — anything else returns
 *  undefined and the caller falls back to the scored keep/drop path. */
function buildTableRows(value: unknown[]): { columns: string[]; rows: unknown[][] } | undefined {
  if (value.length === 0) return undefined
  const first = value[0]
  if (!first || typeof first !== "object" || Array.isArray(first)) return undefined
  const columns = Object.keys(first)
  if (columns.length === 0) return undefined
  const keySig = [...columns].sort().join("\u0000")
  const rows: unknown[][] = []
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
    const record = item as Record<string, unknown>
    const keys = Object.keys(record)
    if ([...keys].sort().join("\u0000") !== keySig) return undefined
    const row: unknown[] = []
    for (const c of columns) {
      const v = record[c]
      if (v !== null && typeof v === "object") return undefined
      row.push(v)
    }
    rows.push(row)
  }
  return { columns, rows }
}

const LOG_LEVEL_RE =
  /\b(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|FAILED|FAILURE|PANIC|Traceback|Unhandled)\b/
const LOG_SHAPE_RE = /^\d{4}-\d{2}-\d{2}[T ]|^\[\d{2}:\d{2}:\d{2}\]|^\d{2}:\d{2}:\d{2}[.,]\d{3}/

const COMPRESSIBLE_LINE_CHAR = 60

function previewCharBudget(config: CcrConfig, originalChars: number): number {
  // Adaptive preview: mid-size outputs get a budget proportional to their own
  // size (≈1/3) so a low minTokens doesn't eat the savings — every compression
  // still nets ≈2/3 off before the marker. Outputs at or above
  // previewTokens*3 tokens keep the full previewTokens budget. The per-
  // compressor 0.7-ratio gates pass through anything that wouldn't be a win.
  const full = Math.max(200, config.previewTokens * 4)
  return Math.min(full, Math.max(200, Math.floor(originalChars / 3)))
}

function parseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function truncateLongString(value: string): string {
  if (value.length <= JSON_STRING_VALUE_LIMIT) return value
  return `${value.slice(0, JSON_STRING_KEEP)}...[+${value.length - JSON_STRING_KEEP} chars]`
}

function compressValue(value: unknown, remainingChars: number, terms?: QueryTerms): unknown | undefined {
  if (remainingChars <= 0) return undefined

  if (Array.isArray(value)) {
    // Dedup identical items (dedup_identical_items=true parity): canonically-
    // equal items collapse to their first occurrence and are counted.
    const canon = new Map<string, number>()
    const uniqueIdx: number[] = []
    for (let i = 0; i < value.length; i++) {
      const s = JSON.stringify(value[i]) ?? ""
      if (!canon.has(s)) {
        canon.set(s, i)
        uniqueIdx.push(i)
      }
    }
    const serialized = new Map<number, string>()
    for (const i of uniqueIdx) serialized.set(i, JSON.stringify(value[i]) ?? "")

    // Selection priority (SmartCrusher parity): must-keep errors first, then
    // first/last anchors, then query-relevant items — all capped at
    // max_items_after_crush, emitted in original order.
    const errorIdx = uniqueIdx.filter((i) => {
      const hay = (serialized.get(i) ?? "").toLowerCase()
      return ERROR_KEYWORDS.some((k) => hay.includes(k))
    })
    const kFirst = Math.max(1, Math.round(MAX_ITEMS_AFTER_CRUSH * FIRST_FRACTION))
    const kLast = Math.max(1, Math.round(MAX_ITEMS_AFTER_CRUSH * LAST_FRACTION))
    const firstIdx = uniqueIdx.slice(0, kFirst)
    const lastIdx = uniqueIdx.slice(-kLast)
    const relevant = terms
      ? uniqueIdx
          .map((i) => ({ i, score: scoreText(serialized.get(i) ?? "", terms) }))
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .map((x) => x.i)
      : uniqueIdx

    const keptIdx = new Set<number>()
    let used = 2
    for (const i of [...errorIdx, ...firstIdx, ...lastIdx, ...relevant]) {
      if (keptIdx.size >= Math.min(value.length, MAX_ITEMS_AFTER_CRUSH)) break
      const len = serialized.get(i)?.length ?? 0
      if (used + len + 1 > remainingChars) continue
      keptIdx.add(i)
      used += len + 1
    }
    if (keptIdx.size === 0 || keptIdx.size === value.length) return undefined
    const deduplicated = uniqueIdx.length < value.length
    return {
      ccr_truncated: true,
      total_items: value.length,
      ...(deduplicated ? { unique_items: uniqueIdx.length, deduplicated: true } : {}),
      showing: keptIdx.size,
      items: [...keptIdx].sort((a, b) => a - b).map((i) => value[i]),
    }
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
    const result: Record<string, unknown> = {}
    let changed = false
    let used = 2
    for (const [key, item] of entries) {
      if (typeof item === "string") {
        const truncated = truncateLongString(item)
        if (truncated !== item) changed = true
        result[key] = truncated
        used += key.length + truncated.length + 6
        continue
      }
      if (Array.isArray(item) || (item && typeof item === "object")) {
        const nested = compressValue(item, Math.max(120, remainingChars - used), terms)
        if (nested === undefined) {
          result[key] = item
          used += JSON.stringify(item)?.length ?? 0
          continue
        }
        changed = true
        result[key] = nested
        used += JSON.stringify(nested)?.length ?? 0
        continue
      }
      result[key] = item
      used += key.length + (JSON.stringify(item)?.length ?? 0)
    }
    if (!changed) return undefined
    return result
  }

  return undefined
}

export function compressJson(text: string, config: CcrConfig, query?: string): CompressionPreview | undefined {
  const trimmed = text.trimStart()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined

  const parsed = parseJson(text)
  if (parsed === undefined) return undefined

  // Lossless table fold first (lossless-first parity): uniformly-structured
  // arrays re-encode to {columns, rows} with EVERY item kept — adopted only
  // when it saves ≥ 15% of bytes (lossless needs no CCR retrieval round-trip,
  // so the bar sits below the lossy 0.7-ratio gate).
  if (Array.isArray(parsed) && parsed.length > 1) {
    const table = buildTableRows(parsed)
    if (table) {
      const rendered = JSON.stringify({
        ccr_table: true,
        total_items: table.rows.length,
        columns: table.columns,
        rows: table.rows,
      })
      if (1 - rendered.length / text.length >= LOSSLESS_MIN_SAVINGS) {
        return {
          strategy: "json",
          preview: rendered,
          itemCount: { original: table.rows.length, compressed: table.rows.length },
        }
      }
    }
  }

  const compressed = compressValue(parsed, previewCharBudget(config, text.length), extractQueryTerms(query))
  if (compressed === undefined) return undefined

  const preview = JSON.stringify(compressed)
  if (preview === undefined || estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined

  const itemCount =
    compressed && typeof compressed === "object" && "ccr_truncated" in (compressed as Record<string, unknown>)
      ? {
          original: (compressed as { total_items: number }).total_items,
          compressed: (compressed as { showing: number }).showing,
        }
      : undefined
  return { strategy: "json", preview, itemCount }
}

export function looksLikeLog(text: string): boolean {
  const lines = text.split("\n")
  if (lines.length < 8) return false
  let signals = 0
  for (const line of lines) {
    if (LOG_SHAPE_RE.test(line) || LOG_LEVEL_RE.test(line)) signals++
  }
  return signals / lines.length >= 0.15
}

export function compressLog(text: string, query?: string): CompressionPreview | undefined {
  const lines = text.split("\n")
  if (lines.length < 16) return undefined
  const terms = extractQueryTerms(query)

  const headCount = 2
  const tailCount = 5
  const head = lines.slice(0, headCount)
  // Tail carries the most recent routine state; error lines are the
  // important pool's job so max_errors caps the total (Headroom parity).
  const tail = lines.slice(-tailCount).filter((line) => !LOG_LEVEL_RE.test(line))
  const middle = lines.slice(headCount, lines.length - tailCount)
  const importantAll = middle.filter((line) => LOG_LEVEL_RE.test(line))
  // Cap at max_errors=10 lines (Headroom parity), preferring query-relevant rows, original order.
  const important =
    terms && importantAll.length > 10
      ? importantAll
          .map((line, i) => ({ line, i, score: scoreText(line, terms) }))
          .sort((a, b) => b.score - a.score || a.i - b.i)
          .slice(0, 10)
          .map((x) => x.line)
      : importantAll.slice(0, 10)
  // Back-heavy weighting (Headroom logs_front_weight=0.15): keep a slice of
  // the most recent routine lines — recent entries often carry the outcome.
  const routineKeep = Math.min(10, Math.floor(middle.length * 0.1))
  const routineTail = middle.slice(-routineKeep).filter((line) => !LOG_LEVEL_RE.test(line))
  const removed = middle.length - important.length - routineTail.length
  if (removed < 8 || important.length === 0) return undefined

  const routineSet = new Set(routineTail)
  const previewLines: string[] = [...head]
  let folded = 0
  for (const line of middle) {
    if (important.includes(line) || routineSet.has(line)) {
      if (folded > 0) {
        previewLines.push(`[... ${folded} routine lines elided ...]`)
        folded = 0
      }
      previewLines.push(line)
      continue
    }
    folded++
  }
  if (folded > 0) previewLines.push(`[... ${folded} routine lines elided ...]`)
  previewLines.push(...tail)

  const preview = previewLines.join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "log", preview }
}

export function compressLines(text: string, config: CcrConfig): CompressionPreview | undefined {
  const lines = text.split("\n")
  if (lines.length < 24) return undefined

  const maxLines = Math.max(6, Math.floor(previewCharBudget(config, text.length) / COMPRESSIBLE_LINE_CHAR))
  const headCount = Math.min(lines.length - 8, Math.max(8, Math.floor(maxLines * 0.6)))
  const tailCount = Math.min(lines.length - headCount - 8, Math.max(4, Math.floor(maxLines * 0.25)))
  const removed = lines.length - headCount - tailCount
  if (removed < 8) return undefined

  const preview = [
    ...lines.slice(0, headCount),
    `[... ${removed} lines removed ...]`,
    ...lines.slice(lines.length - tailCount),
  ].join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "lines", preview }
}

export function compressOutput(text: string, config: CcrConfig, query?: string): CompressionPreview | undefined {
  const json = compressJson(text, config, query)
  if (json) return json

  const diff = compressDiff(text)
  if (diff) return diff

  const tabular = compressTabular(text)
  if (tabular) return tabular

  const search = compressSearch(text, config, query)
  if (search) return search

  const cfg = compressConfig(text)
  if (cfg) return cfg

  const html = compressHtml(text, config)
  if (html) return html

  const code = compressCode(text, config)
  if (code) return code

  const log = compressLog(text, query)
  if (log) return log

  return compressLines(text, config)
}

// ─── Unified diffs ──────────────────────────────────────────────────────────
// Ported from Headroom diff_compressor: keep file headers and hunk headers,
// keep +/- change lines, elide context lines beyond `maxContextLines` per
// hunk, cap hunks per file.

const DIFF_FILE_HEAD_RE = /^(diff --git |Index: |--- (a\/|\S)|\+\+\+ (b\/|\S))/
const DIFF_HUNK_RE = /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m

export function looksLikeDiff(text: string): boolean {
  return DIFF_HUNK_RE.test(text) && (text.includes("diff --git ") || text.includes("--- a/") || text.includes("--- "))
}

export function compressDiff(text: string): CompressionPreview | undefined {
  const lines = text.split("\n")
  if (lines.length < 24 || !looksLikeDiff(text)) return undefined

  const MAX_CONTEXT_LINES = 2
  const MAX_HUNKS_PER_FILE = 10

  const previewLines: string[] = []
  let kept = 0
  let elided = 0
  let hunks = 0
  let contextRun = 0
  let inHunk = false

  for (const line of lines) {
    if (DIFF_FILE_HEAD_RE.test(line)) {
      if (contextRun > 0) {
        previewLines.push(`[... ${contextRun} ctx elided ...]`)
        kept++
        contextRun = 0
      }
      inHunk = false
      hunks = 0
      previewLines.push(line)
      kept++
      continue
    }
    if (DIFF_HUNK_RE.test(line)) {
      if (contextRun > 0) {
        previewLines.push(`[... ${contextRun} ctx elided ...]`)
        kept++
        contextRun = 0
      }
      inHunk = ++hunks <= MAX_HUNKS_PER_FILE
      if (inHunk) {
        previewLines.push(line)
        kept++
      }
      continue
    }
    if (!inHunk || hunks > MAX_HUNKS_PER_FILE) {
      elided++
      continue
    }
    if (line.startsWith("+") || line.startsWith("-") || line.startsWith("\\")) {
      if (contextRun > 0) {
        previewLines.push(`[... ${contextRun} ctx elided ...]`)
        kept++
        contextRun = 0
      }
      previewLines.push(line)
      kept++
      continue
    }
    // Context line (leading space or empty inside a hunk)
    if (contextRun < MAX_CONTEXT_LINES) {
      previewLines.push(line)
      kept++
      contextRun++
    } else {
      elided++
      contextRun++
    }
  }
  if (contextRun > 0) {
    previewLines.push(`[... ${contextRun} ctx elided ...]`)
    kept++
  }

  if (elided < 8) return undefined
  const preview = previewLines.join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "diff", preview, itemCount: { original: lines.length, compressed: kept } }
}

// ─── Tabular data (CSV/TSV/pipe tables) ─────────────────────────────────────
// Simplified port of Headroom TabularCompressor: detect uniform-column runs,
// keep the header and a few sample rows, summarize the rest.

const TABULAR_DELIMITERS = [",", "\t", "|"]

function detectDelimiter(text: string): string | undefined {
  const lines = text.split("\n").filter((l) => l.trim() !== "").slice(0, 20)
  for (const d of TABULAR_DELIMITERS) {
    if (d === "|" && !lines.every((l) => /^\s*\|.*\|\s*$/.test(l))) continue
    const count = (l: string) => (d === "|" ? l.split("|").length - 2 : l.split(d).length)
    const first = count(lines[0] ?? "")
    if (first >= 2 && lines.every((l) => count(l) === first)) return d
  }
  return undefined
}

export function looksLikeTabular(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "")
  if (lines.length < 10) return false
  const d = detectDelimiter(text)
  if (!d) return false
  const count = (l: string) => (d === "|" ? l.split("|").length - 2 : l.split(d).length)
  const first = count(lines[0])
  return first >= 2 && lines.slice(0, 20).every((l) => count(l) === first)
}

export function compressTabular(text: string): CompressionPreview | undefined {
  const lines = text.split("\n")
  if (lines.length < 16 || !looksLikeTabular(text)) return undefined

  const d = detectDelimiter(text)!
  const count = (l: string) => (d === "|" ? l.split("|").length - 2 : l.split(d).length)
  const columns = lines[0]
    .split(d === "|" ? "|" : d)
    .map((c) => c.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)

  const KEEP_ROWS = 5
  const kept: string[] = []
  let dataRows = 0
  let shown = 0
  for (const line of lines) {
    if (line.trim() === "") continue
    dataRows++
    if (shown < KEEP_ROWS + (d === "|" ? 1 : 0)) {
      kept.push(line)
      shown++
    }
  }
  const elided = dataRows - shown
  if (elided < 8) return undefined

  const preview = [...kept, `[... ${elided} data rows elided (columns: ${columns.join(", ")}) ...]`].join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "tabular", preview, itemCount: { original: dataRows, compressed: shown } }
}

// ─── HTML (structural noise removal) ────────────────────────────────────────
// Simplified port of Headroom html_extractor (trafilatura-based there): strip
// script/style/head/comment blocks, then reduce remaining tags to text lines.
// This is noise removal, not lossless compression — the original is CCR-stored.

export function looksLikeHtml(text: string): boolean {
  return /<html[\s>]|<!DOCTYPE\s+html|<body[\s>]/i.test(text.slice(0, 2000))
}

export function compressHtml(text: string, config: CcrConfig): CompressionPreview | undefined {
  if (!looksLikeHtml(text)) return undefined
  const totalLines = text.split("\n").length

  const stripped = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|hr|img|input|meta|link)\b[^>]*\/?>/gi, "")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  if (stripped.length < 4 || stripped.length >= totalLines) return undefined
  const preview = stripped.join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "html", preview, itemCount: { original: totalLines, compressed: stripped.length } }
}

// ─── Source code (heuristic structural elision) ─────────────────────────────
// Headroom uses per-language tree-sitter ASTs; we approximate with declaration
// line detection: imports, decorators, and block-opening signatures survive,
// bodies collapse. Mis-folded lines stay retrievable via CCR.

const CODE_IMPORT_RE = /^\s*(import\b|from\s+\S+\s+import\b|package\s|using\s|require\(|#include|use\s)/
const CODE_DECL_RE = /^\s*(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|interface\b|type\s+\w+\s*=|enum\b|struct\b|impl\b|trait\b|def\b|fn\b|pub\b|public\b|private\b|protected\b)/
const CODE_DECORATOR_RE = /^\s*@(?:[A-Za-z_][\w.]*)/

export function looksLikeCode(text: string): boolean {
  const lines = text.split("\n")
  if (lines.length < 20) return false
  let signals = 0
  for (const line of lines) {
    if (CODE_IMPORT_RE.test(line) || CODE_DECL_RE.test(line) || CODE_DECORATOR_RE.test(line)) signals++
  }
  return signals >= 5 && signals / lines.length >= 0.05
}

export function compressCode(text: string, config: CcrConfig): CompressionPreview | undefined {
  const lines = text.split("\n")
  if (lines.length < 24 || !looksLikeCode(text)) return undefined

  // Headroom CodeAwareCompressor parity: the folded output must stay valid
  // syntax. Blocks keep their closing line, and elided bodies are replaced by
  // a same-language comment placeholder (Python additionally gets `pass` so
  // an empty block stays parseable).
  const isPython = /\b(def |elif |self\.|print\()/.test(text)
  const commentPrefix = isPython ? "#" : "//"
  const placeholder = (n: number) => (isPython ? `pass  # [... ${n} lines elided]` : `${commentPrefix} [... ${n} lines elided]`)
  const isClose = (line: string): boolean => /^\s*[}\])];?\s*$/.test(line)

  const kept: string[] = []
  let elided = 0
  let run = 0
  const isStructure = (line: string): boolean =>
    CODE_IMPORT_RE.test(line) || CODE_DECL_RE.test(line) || CODE_DECORATOR_RE.test(line) ||
    // Block-opening signature: indented `name(args...):` / `...{` (methods etc.)
    (/[{(:]\s*$/.test(line) && /\(/.test(line) && !/^\s*[)}\]]/.test(line))

  const flush = (): void => {
    if (run > 0) {
      kept.push(placeholder(run))
      run = 0
    }
  }

  // DocstringMode.FIRST_LINE parity: a Python docstring's opening line states
  // the function's intent — the most valuable elided context — so it survives
  // the fold while the rest of the string folds away.
  let docDelim: string | undefined

  for (const line of lines) {
    if (docDelim) {
      run++
      elided++
      if (line.includes(docDelim)) docDelim = undefined
      continue
    }
    const docOpen = /("""|''')/.exec(line)
    if (docOpen) {
      const rest = line.slice(docOpen.index + 3)
      flush()
      kept.push(line)
      if (!rest.includes(docOpen[1])) docDelim = docOpen[1]
      continue
    }
    if (isStructure(line) || isClose(line)) {
      flush()
      kept.push(line)
      continue
    }
    if (line.trim() === "") {
      if (run === 0) kept.push("")
      continue
    }
    run++
    elided++
  }
  flush()

  if (elided < 10) return undefined
  const preview = kept.join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "code", preview, itemCount: { original: lines.length, compressed: kept.length } }
}

// ─── Search results (grep/ripgrep `file:line:content`) ──────────────────────
// Ported from Headroom search_compressor: anchor on the line-number marker
// (earliest `<sep>digits<sep>`), keep first/last/error rows per file, cap
// matches per file and globally, and emit group_by_file output to drop the
// per-match path repetition.

const SEARCH_LINE_RE = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):(.*)$/
// A search hit's file portion must look like a path (extension or separator),
// so timestamps like `10:00:00Z` are not misread as `file:line:content`.
const isSearchPath = (file: string): boolean => /[\\/]/.test(file) || /\.\w{1,8}$/.test(file)
const SEARCH_ERROR_RE = /\b(error|warn|warning|deprecated|failed|failure|fatal|exception|panic)\b/i
const SEARCH_MAX_PER_FILE = 5
const SEARCH_MAX_TOTAL = 30
const SEARCH_MAX_FILES = 15

export function looksLikeSearch(text: string): boolean {
  const lines = text.split("\n")
  if (lines.length < 10) return false
  let hits = 0
  for (const line of lines) {
    const m = SEARCH_LINE_RE.exec(line)
    if (m && isSearchPath(m[1])) hits++
  }
  return hits / lines.length >= 0.6
}

export function compressSearch(text: string, config: CcrConfig, query?: string): CompressionPreview | undefined {
  const lines = text.split("\n")
  if (lines.length < 16) return undefined
  const terms = extractQueryTerms(query)

  const files = new Map<string, Array<{ no: number; content: string; err: boolean; score: number }>>()
  let total = 0
  for (const line of lines) {
    const m = SEARCH_LINE_RE.exec(line)
    if (!m || !isSearchPath(m[1])) continue
    total++
    const rows = files.get(m[1]) ?? []
    rows.push({ no: Number(m[2]), content: m[3], err: SEARCH_ERROR_RE.test(m[3]), score: scoreText(m[3], terms) })
    files.set(m[1], rows)
  }
  if (total < 16 || files.size === 0) return undefined

  const kept: Array<{ file: string; no: number; content: string }> = []
  const fileEntries = [...files.entries()].slice(0, SEARCH_MAX_FILES)
  let omitted = total
  for (const [file, rows] of fileEntries) {
    if (kept.length >= SEARCH_MAX_TOTAL) break
    const indices = new Set<number>([0])
    if (rows.length > 1) indices.add(rows.length - 1)
    // Fill the remaining per-file slots by relevance: error rows and
    // query-matching rows first (Headroom boost_errors + context scoring),
    // ties broken by original position for determinism.
    const ranked = rows
      .map((row, i) => ({ i, rank: (row.err ? 2 : 0) + row.score }))
      .filter((x) => !indices.has(x.i))
      .sort((a, b) => b.rank - a.rank || a.i - b.i)
    for (const x of ranked) {
      if (indices.size >= SEARCH_MAX_PER_FILE) break
      indices.add(x.i)
    }
    const selected = [...indices].slice(0, SEARCH_MAX_PER_FILE).sort((a, b) => a - b)
    for (const i of selected) {
      if (kept.length >= SEARCH_MAX_TOTAL) break
      kept.push({ file, no: rows[i].no, content: rows[i].content })
    }
    omitted -= selected.length
  }
  omitted = Math.max(0, omitted)
  if (kept.length === 0 || omitted < 8) return undefined

  const previewLines: string[] = []
  let currentFile = ""
  for (const row of kept) {
    if (row.file !== currentFile) {
      previewLines.push(row.file)
      currentFile = row.file
    }
    previewLines.push(`${row.no}: ${row.content}`)
  }
  previewLines.push(`[... ${omitted} of ${total} matches across ${files.size} files omitted ...]`)

  const preview = previewLines.join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "search", preview, itemCount: { original: total, compressed: kept.length } }
}

// ─── Structured config (YAML/TOML/INI) ──────────────────────────────────────
// Ported from Headroom config_compressor Tier 2: elide whole-line comments and
// blank lines behind a summary line. Skipped when a `#` line could be data
// (YAML block scalars, TOML multi-line strings) — detection stays over-broad.

const CONFIG_COMMENT_YAML_TOML_RE = /^\s*#/
const CONFIG_COMMENT_INI_RE = /^[#;]/
const CONFIG_YAML_KEY_RE = /^\s*[A-Za-z_][\w.-]*\s*:(\s|$)/
const CONFIG_SECTION_RE = /^\s*\[[^\]]+\]\s*$/
const CONFIG_YAML_BLOCK_SCALAR_RE = /:\s*[|>][+-]?\d*\s*$/m
const CONFIG_TOML_MULTILINE_RE = /"""|'''/

export function looksLikeConfig(text: string): boolean {
  const lines = text.split("\n")
  if (lines.length < 12) return false
  let comments = 0
  let structure = 0
  for (const line of lines) {
    if (CONFIG_COMMENT_YAML_TOML_RE.test(line) || CONFIG_COMMENT_INI_RE.test(line)) comments++
    else if (CONFIG_YAML_KEY_RE.test(line) || CONFIG_SECTION_RE.test(line)) structure++
  }
  return comments >= 4 && structure >= 3 && (comments + structure) / lines.length >= 0.5
}

export function compressConfig(text: string): CompressionPreview | undefined {
  const lines = text.split("\n")
  if (lines.length < 16) return undefined
  if (CONFIG_YAML_BLOCK_SCALAR_RE.test(text) || CONFIG_TOML_MULTILINE_RE.test(text)) return undefined

  const isIni = lines.some((l) => CONFIG_SECTION_RE.test(l) && CONFIG_COMMENT_INI_RE.test(l))
  const isComment = (line: string): boolean =>
    isIni ? CONFIG_COMMENT_INI_RE.test(line) : CONFIG_COMMENT_YAML_TOML_RE.test(line)

  let elided = 0
  const kept: string[] = []
  for (const line of lines) {
    if (line.trim() === "" || isComment(line)) {
      elided++
      continue
    }
    kept.push(line)
  }
  if (elided < 8 || kept.length < 4) return undefined

  const preview = [...kept, `[... ${elided} comment/blank lines elided ...]`].join("\n")
  if (estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { strategy: "config", preview, itemCount: { original: lines.length, compressed: kept.length } }
}
