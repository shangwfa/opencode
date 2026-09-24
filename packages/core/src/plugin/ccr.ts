export * as CcrPlugin from "./ccr.js"

import { ToolResultPart, ToolFailure, Message } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Schema } from "effect"
import { createHash } from "node:crypto"
import { KV, type Interface as KVInterface } from "../kv.js"
import { resizeHistoryImage } from "./ccr-image.js"

const enabled = (process.env.OPENCODE_CCR_ENABLED ?? "").toLowerCase()
const ON = enabled !== "" && enabled !== "0" && enabled !== "false"

function positive(name: string, fallback: number, zero = false) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && (zero ? value >= 0 : value > 0) ? value : fallback
}

export interface Config {
  readonly minTokens: number
  readonly previewTokens: number
  readonly protectRecent: number
  readonly ttl: number
  readonly images: boolean
}

/** V1 loadCcrConfig 对齐：数值 env 非法回落默认；保护窗/TTL 允许显式 0。 */
export const loadCcrConfig = (): Config => ({
  minTokens: positive("OPENCODE_CCR_MIN_TOKENS", 250),
  previewTokens: positive("OPENCODE_CCR_PREVIEW_TOKENS", 300),
  protectRecent: positive("OPENCODE_CCR_PROTECT_RECENT", 4, true),
  ttl: positive("OPENCODE_CCR_TTL_SEC", 1800, true),
  images: !["0", "false"].includes((process.env.OPENCODE_CCR_IMAGE_ENABLED ?? "true").toLowerCase()),
})

const defaultConfig = loadCcrConfig()
const exclusions = new Set(["edit", "write", "question", "ccr_retrieve"])
const imageDetailQuery = /\bread\b|\bcount\b|\btranscribe\b|\bexact\b|\bserial\b|\bcompare\b|\bzoom\b|数一下|数量|几个|精确|序列|对比|逐字|逐项|逐个|逐像素|放大|仔细|看清|识别.*(?:文字|文本)/i

// V1 CJK_RE 范围的码点比较版：语义一致（按码点计数，BMP 外字符算 1 个），
// 但免去逐字符 regex 的开销 —— estimateTokens 在每次压缩中多次调用，
// regex 版 1MB 文本要 ~18ms，占压缩耗时的大头。
export const estimateTokens = (text: string) => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}
export const contentHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 24)
const markerPattern = /(?:\[ccr:|Retrieve original: hash=|Retrieve more: hash=|<<ccr:)/
const ERROR_KEYWORDS = ["error", "exception", "failed", "failure", "critical", "fatal", "crash", "panic", "abort", "timeout", "denied", "rejected"]
const MAX_JSON_ITEMS = 15
const queryTerms = (query: string) => {
  const lower = query.toLowerCase()
  const words: string[] = lower.match(/[a-z0-9]+/g) ?? []
  const cjk = Array.from(lower.replace(/[^\p{Script=Han}]/gu, ""))
  for (let index = 0; index < cjk.length - 1; index++) words.push(cjk.slice(index, index + 2).join(""))
  return [...new Set(words.filter((word) => word.length > 1))]
}
const stableJson = (value: unknown): string | undefined => {
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}
function compressJsonValue(value: unknown, budget: number, terms: string[]): unknown | undefined {
  if (budget <= 0) return undefined
  if (Array.isArray(value)) {
    const unique = new Map<string, number>()
    value.forEach((item, index) => {
      const encoded = stableJson(item) ?? ""
      if (!unique.has(encoded)) unique.set(encoded, index)
    })
    const indices = [...unique.values()]
    const encoded = new Map(indices.map((index) => [index, stableJson(value[index]) ?? ""]))
    const errors = indices.filter((index) => ERROR_KEYWORDS.some((word) => encoded.get(index)?.toLowerCase().includes(word)))
    const first = indices.slice(0, Math.max(1, Math.round(MAX_JSON_ITEMS * 0.3)))
    const last = indices.slice(-Math.max(1, Math.round(MAX_JSON_ITEMS * 0.15)))
    const relevant = [...indices].sort((a, b) => {
      const score = (index: number) => terms.reduce((n, word) => n + (encoded.get(index)?.toLowerCase().includes(word) ? 1 : 0), 0)
      return score(b) - score(a) || a - b
    })
    const keep = new Set<number>()
    let used = 2
    for (const index of [...errors, ...first, ...last, ...relevant]) {
      if (keep.size >= Math.min(value.length, MAX_JSON_ITEMS)) break
      const size = encoded.get(index)?.length ?? 0
      if (used + size + 1 > budget) continue
      keep.add(index)
      used += size + 1
    }
    if (keep.size === 0 || keep.size === value.length) return undefined
    return {
      ccr_truncated: true,
      total_items: value.length,
      ...(indices.length < value.length ? { unique_items: indices.length, deduplicated: true } : {}),
      showing: keep.size,
      items: [...keep].sort((a, b) => a - b).map((index) => value[index]),
    }
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    let changed = false
    let used = 2
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && item.length > 400) {
        result[key] = `${item.slice(0, 160)}...[+${item.length - 160} chars]`
        changed = true
      } else if (item && typeof item === "object") {
        const nested = compressJsonValue(item, Math.max(120, budget - used), terms)
        result[key] = nested ?? item
        changed ||= nested !== undefined
      } else result[key] = item
      used += JSON.stringify(result[key])?.length ?? 0
    }
    return changed ? result : undefined
  }
  return undefined
}

export function compressOutput(text: string, query: string, config: Config = defaultConfig) {
  const { previewTokens, ttl } = config
  const id = contentHash(text)
  let strategy = "lines"
  let output = ""
  let itemCount: { original: number; compressed: number } | undefined
  const looksHtml = /<html[\s>]|<!doctype\s+html|<body[\s>]/i.test(text.slice(0, 2000))
  try {
    const parsed: unknown = JSON.parse(text)
    if (!output && parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const budget = Math.min(Math.max(200, previewTokens * 4), Math.max(200, Math.floor(text.length / 3)))
      const compact = compressJsonValue(parsed, budget, queryTerms(query))
      if (compact) {
        const serialized = JSON.stringify(compact)
        if (serialized && estimateTokens(serialized) < estimateTokens(text) * 0.7) {
          strategy = "json"
          output = serialized
        }
      }
    }
    if (!output && Array.isArray(parsed) && parsed.length > 1) {
      strategy = "json"
      const first = parsed[0]
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const columns = Object.keys(first)
        const columnSet = [...columns].sort()
        const rows = parsed.map((item) => {
          if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
          const keys = Object.keys(item).sort()
          if (keys.length !== columns.length || keys.some((key, index) => key !== columnSet[index])) return undefined
          const values = columns.map((key) => (item as Record<string, unknown>)[key])
          return values.every((value) => value === null || ["string", "number", "boolean"].includes(typeof value)) ? values : undefined
        })
        if (rows.every((row) => row !== undefined)) {
          const table = JSON.stringify({ ccr_table: true, total_items: rows.length, columns, rows })
          if (Buffer.byteLength(table) <= Buffer.byteLength(text) * 0.85) {
            output = table
            itemCount = { original: parsed.length, compressed: parsed.length }
          }
        }
      }
      if (!output) {
        const budget = Math.min(Math.max(200, previewTokens * 4), Math.max(200, Math.floor(text.length / 3)))
        const compact = compressJsonValue(parsed, budget, queryTerms(query))
        const serialized = compact === undefined ? undefined : JSON.stringify(compact)
        if (serialized && estimateTokens(serialized) < estimateTokens(text) * 0.7) {
          output = serialized
          const meta = compact as { total_items?: number; showing?: number }
          if (meta.total_items !== undefined && meta.showing !== undefined)
            itemCount = { original: meta.total_items, compressed: meta.showing }
        }
      }
    }
  } catch {}
  if (!output) {
    const lines = text.split("\n")
    const textTokens = estimateTokens(text)
    const budget = Math.min(Math.max(200, previewTokens * 4), Math.max(200, Math.floor(text.length / 3)))
    const terms = queryTerms(query)
    const isDiff = /^diff --git |^--- (?:a\/|\S)/m.test(text) && /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text)
    const isTable = looksLikeTabular(lines)
    const isSearch = looksLikeSearch(lines)
    const config = looksLikeConfig(lines)
    // V1 LOG_LEVEL_RE/LOG_SHAPE_RE 对齐：级别词大小写敏感（ERROR/ERR/…），
    // 避免普通散文里的小写 "error" 触发日志路由。
    const logSignals = lines.filter((line) => /\b(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|FAILED|FAILURE|PANIC|Traceback|Unhandled)\b|^\d{4}-\d{2}-\d{2}[T ]|^\[\d{2}:\d{2}:\d{2}\]/.test(line)).length
    const isLog = lines.length >= 8 && logSignals / lines.length >= 0.15
    const codeSignals = lines.filter((line) => /^\s*(?:import\s|export\s|from\s|@\w|class\s|interface\s|type\s|enum\s|def\s|async\s+def\s|function\s)/.test(line)).length
    const isCode = lines.length >= 24 && codeSignals >= 5 && codeSignals / lines.length >= 0.05
    const chooseLines = (name: string, candidate: string[]) => {
      const preview = candidate.join("\n")
      if (candidate === lines || estimateTokens(preview) >= textTokens * 0.7) return false
      strategy = name
      output = preview
      return true
    }
    if (lines.length >= 24 && isDiff) {
      const candidate = compressDiffLines(lines)
      if (chooseLines("diff", candidate)) itemCount = { original: lines.length, compressed: candidate.length }
    }
    if (!output && lines.length >= 16 && isTable) {
      const candidate = compressTableLines(lines)
      if (chooseLines("tabular", candidate)) itemCount = { original: lines.filter((line) => line.trim()).length, compressed: candidate.length - 1 }
    }
    if (!output && lines.length >= 16 && isSearch) {
      const candidate = compressSearchLines(lines, terms)
      if (chooseLines("search", candidate)) {
        const matchCount = (rows: string[]) => rows.filter((line) => /^\d+: /.test(line)).length
        itemCount = { original: lines.filter((line) => /^((?:[A-Za-z]:)?[^:\n]+?):\d+:/.test(line)).length, compressed: matchCount(candidate) }
      }
    }
    if (!output && lines.length >= 16 && config) {
      const candidate = compressConfigLines(lines)
      if (chooseLines("config", candidate)) itemCount = { original: lines.length, compressed: candidate.length - 1 }
    }
    if (!output && looksHtml) {
      const html = compressHtml(text)
      if (html) { strategy = "html"; output = html.preview; itemCount = html.itemCount }
    }
    if (!output && isCode) {
      const candidate = compressCodeLines(lines)
      if (chooseLines("code", candidate)) itemCount = { original: lines.length, compressed: candidate.length }
    }
    if (!output && lines.length >= 16 && isLog) chooseLines("log", compressLogLines(lines, terms))
    if (!output && lines.length >= 24) chooseLines("lines", compressPlainLines(lines, text, budget, terms))
  }
  if (!output) return undefined
  if (estimateTokens(output) >= estimateTokens(text) * 0.7) return undefined
  const expiry = ttl > 0 ? ` Expires in ${Math.max(1, Math.round(ttl / 60))}m.` : ""
  return {
    id,
    strategy,
    preview: output,
    itemCount,
    replacement: `[ccr:${id}] (${strategy}) ${output}\n\n[${itemCount ? `${itemCount.original} items compressed to ${itemCount.compressed}. ` : ""}${estimateTokens(text)} tokens compressed to ~${estimateTokens(output)}. Retrieve original: hash=${id}.${expiry} Call ccr_retrieve with this hash if you need the full content.]`,
  }
}

function compressPlainLines(lines: string[], text: string, budget: number, terms: string[]) {
  if (terms.length) {
    const total = estimateTokens(text)
    const keep = new Set([0, 1, lines.length - 2, lines.length - 1])
    let used = [...keep].reduce((sum, index) => sum + estimateTokens(lines[index] ?? ""), 0)
    const scored = lines.map((line, index) => ({ line, index, score: terms.reduce((sum, term) => sum + (line.toLowerCase().includes(term) ? 1 : 0), 0) }))
    for (const item of scored.sort((a, b) => b.score - a.score || a.index - b.index)) {
      if (item.score <= 0) break
      if (keep.has(item.index)) continue
      const cost = estimateTokens(item.line)
      if (used + cost > total * 0.5) continue
      keep.add(item.index)
      used += cost
    }
    if (keep.size >= lines.length - 8) return lines
    const result: string[] = []
    let previous = -1
    for (const index of [...keep].sort((a, b) => a - b)) {
      if (index - previous > 1) result.push(`[... ${index - previous - 1} lines removed ...]`)
      result.push(lines[index]!)
      previous = index
    }
    const preview = result.join("\n")
    return estimateTokens(preview) >= total * 0.7 ? lines : result
  }
  const maxLines = Math.max(6, Math.floor(budget / 60))
  const head = Math.min(lines.length - 8, Math.max(8, Math.floor(maxLines * 0.6)))
  const tail = Math.min(lines.length - head - 8, Math.max(4, Math.floor(maxLines * 0.25)))
  const removed = lines.length - head - tail
  if (removed < 8) return lines
  return [...lines.slice(0, head), `[... ${removed} lines removed ...]`, ...lines.slice(-tail)]
}

function compressDiffLines(lines: string[]) {
  const output: string[] = []
  let files = 0
  let hunks = 0
  let beyondFiles = false
  let inHunk = false
  let contextRun = 0
  let elided = 0
  const flushContext = () => {
    if (contextRun > 2) { output.push(`[... ${contextRun - 2} ctx elided ...]`); elided += contextRun - 2 }
    contextRun = 0
  }
  for (const line of lines) {
    if (/^(?:diff --git |Index: |--- (?:a\/|\S)|\+\+\+ (?:b\/|\S))/.test(line) && (!inHunk || line.startsWith("diff --git ") || line.startsWith("Index: "))) {
      flushContext()
      inHunk = false
      hunks = 0
      beyondFiles = line.startsWith("diff --git ") ? ++files > 20 : beyondFiles
      output.push(line)
      continue
    }
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      flushContext()
      inHunk = ++hunks <= 10
      if (inHunk) output.push(line)
      else elided++
      continue
    }
    if (!inHunk || hunks > 10 || beyondFiles) { elided++; continue }
    if (/^[+-\\]/.test(line)) {
      flushContext()
      output.push(line)
      continue
    }
    if (contextRun < 2) output.push(line)
    contextRun++
  }
  flushContext()
  return elided < 8 ? lines : output
}

function compressSearchLines(lines: string[], terms: string[]) {
  const pattern = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):(.*)$/
  const files = new Map<string, Array<{ number: number; content: string }>>()
  let total = 0
  for (const line of lines) {
    const match = pattern.exec(line)
    if (!match || (!/[\\/]/.test(match[1]!) && !/\.\w{1,8}$/.test(match[1]!))) continue
    total++
    const rows = files.get(match[1]!) ?? []
    rows.push({ number: Number(match[2]), content: match[3]! })
    files.set(match[1]!, rows)
  }
  if (total < 16 || files.size === 0) return lines
  const kept: Array<{ file: string; number: number; content: string }> = []
  let omitted = total
  for (const [file, rows] of [...files.entries()].slice(0, 15)) {
    if (kept.length >= 30) break
    const indices = new Set([0, ...(rows.length > 1 ? [rows.length - 1] : [])])
    const ranked = rows.map((row, index) => ({ index, rank: (/\b(error|warn|warning|deprecated|failed|failure|fatal|exception|panic)\b/i.test(row.content) ? 2 : 0) + terms.reduce((n, term) => n + (row.content.toLowerCase().includes(term) ? 1 : 0), 0) }))
      .filter((row) => !indices.has(row.index)).sort((a, b) => b.rank - a.rank || a.index - b.index)
    for (const row of ranked) { if (indices.size >= 5) break; indices.add(row.index) }
    let added = 0
    for (const index of [...indices].slice(0, 5).sort((a, b) => a - b)) {
      if (kept.length >= 30) break
      kept.push({ file, ...rows[index]! })
      added++
    }
    omitted -= added
  }
  omitted = Math.max(0, omitted)
  if (kept.length === 0 || omitted < 8) return lines
  const output: string[] = []
  let current = ""
  for (const row of kept) {
    if (row.file !== current) { output.push(row.file); current = row.file }
    output.push(`${row.number}: ${row.content}`)
  }
  output.push(`[... ${omitted} of ${total} matches across ${files.size} files omitted ...]`)
  return output
}

function compressLogLines(lines: string[], terms: string[]) {
  if (lines.length < 16) return lines
  const head = lines.slice(0, 2)
  const middle = lines.slice(2)
  const level = /\b(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|WARN|WARNING|FAILED|FAILURE|PANIC|Traceback|Unhandled)\b/
  const errorLevel = /\b(ERROR|ERR|FATAL|CRITICAL|EXCEPTION|FAILED|FAILURE|PANIC|Traceback|Unhandled)\b/
  const errors: number[] = []
  const warnings: number[] = []
  const warningSeen = new Set<string>()
  const summaries: number[] = []
  const stacks = new Set<number>()
  let traceCount = 0
  const stackOpen = /Traceback \(most recent call last\)|panic:|goroutine \d+ \[|Exception in thread|^\s+at /
  const fileFrame = /^[\w./\\-]+\.(?:go|py|java|ts|js|rs|cpp|c):\d+/
  for (let index = 0; index < middle.length; index++) {
    const line = middle[index]!
    if (errorLevel.test(line)) {
      errors.push(index)
      if (traceCount < 3 && stackOpen.test(line)) {
        stacks.add(index)
        traceCount++
        for (let next = index + 1, count = 1; next < middle.length && count < 20; next++, count++) {
          const frame = middle[next]!
          if (!/^\s/.test(frame) && !fileFrame.test(frame) && frame.trim()) break
          stacks.add(next)
        }
      }
      continue
    }
    if (/\b(WARN|WARNING|DEPRECATED)\b/.test(line)) {
      const signature = line.slice(0, 160)
      if (!warningSeen.has(signature)) { warningSeen.add(signature); warnings.push(index) }
      continue
    }
    if (/^(===|---)|\b\d+ (passed|failed|skipped|error|warning)\b|^(Tests?|Suites?):?\s*\d|^(TOTAL|Total|Summary)\b|^(Build|Compile|Test)\b.*(succeeded|failed|complete)/.test(line)) summaries.push(index)
    if (traceCount < 3 && stackOpen.test(line)) {
      stacks.add(index)
      traceCount++
      for (let next = index + 1, count = 1; next < middle.length && count < 20; next++, count++) {
        const frame = middle[next]!
        if (!/^\s/.test(frame) && !fileFrame.test(frame) && frame.trim()) break
        stacks.add(next)
      }
    }
  }
  const score = (index: number) => terms.reduce((sum, term) => sum + (middle[index]!.toLowerCase().includes(term) ? 1 : 0), 0)
  const important = errors.length > 10
    ? [errors[0]!, ...errors.slice(1, -1).sort((a, b) => score(b) - score(a) || a - b).slice(0, 8), errors.at(-1)!]
    : [errors[0], ...errors.slice(1, 9), errors.at(-1)].filter((index): index is number => index !== undefined)
  const warningKeep = [...new Set([warnings[0], ...warnings.slice(1, 4), warnings.at(-1)])].filter((index): index is number => index !== undefined)
  const keep = new Set<number>([...important, ...warningKeep, ...summaries, ...stacks])
  for (const index of important) {
    for (let delta = -3; delta <= 3; delta++) {
      const near = index + delta
      if (near >= 0 && near < middle.length && !level.test(middle[near]!)) keep.add(near)
    }
  }
  const importantLines = new Set([...keep].map((index) => middle[index]!))
  const routineTail = middle.slice(-Math.min(10, Math.floor(middle.length * 0.1))).filter((line) => !level.test(line))
  if (middle.length - keep.size - routineTail.length < 8 || important.length === 0) return lines
  const routine = new Set(routineTail)
  const output = [...head]
  let omitted = 0
  for (const line of middle) {
    if (importantLines.has(line) || routine.has(line)) {
      if (omitted) output.push(`[... ${omitted} routine lines elided ...]`)
      omitted = 0
      output.push(line)
    } else omitted++
  }
  if (omitted) output.push(`[... ${omitted} routine lines elided ...]`)
  return output
}

function compressTableLines(lines: string[]) {
  const delimiter = tableDelimiter(lines)
  if (!delimiter) return lines
  const content = lines.filter((line) => line.trim())
  const count = (line: string) => delimiter === "|" ? line.split("|").length - 2 : line.split(delimiter).length
  const columns = content[0]!.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, "")).filter(Boolean)
  const take = 5 + (delimiter === "|" ? 1 : 0)
  const kept = content.slice(0, take)
  const elided = content.length - kept.length
  if (elided < 8) return lines
  return [...kept, `[... ${elided} data rows elided (columns: ${columns.join(", ")}) ...]`]
}

function tableDelimiter(lines: string[]) {
  const content = lines.filter((line) => line.trim()).slice(0, 20)
  if (content.length < 10) return undefined
  for (const delimiter of [",", "\t", "|"]) {
    if (delimiter === "|" && !content.every((line) => /^\s*\|.*\|\s*$/.test(line))) continue
    const count = (line: string) => delimiter === "|" ? line.split("|").length - 2 : line.split(delimiter).length
    const columns = count(content[0]!)
    if (columns >= 2 && content.every((line) => count(line) === columns)) return delimiter
  }
  return undefined
}

function looksLikeTabular(lines: string[]) {
  return tableDelimiter(lines) !== undefined
}

function looksLikeSearch(lines: string[]) {
  if (lines.length < 10) return false
  const pattern = /^((?:[A-Za-z]:)?[^:\n]+?):(\d+):(.*)$/
  const hits = lines.filter((line) => {
    const match = pattern.exec(line)
    return match && (/[\\/]/.test(match[1]!) || /\.\w{1,8}$/.test(match[1]!))
  }).length
  return hits / lines.length >= 0.6
}

function compressHtml(text: string) {
  const totalLines = text.split("\n").length
  const stripped = text.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(br|hr|img|input|meta|link)\b[^>]*\/?\s*>/gi, "")
    .replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").split("\n").map((line) => line.trim()).filter(Boolean)
  const preview = stripped.join("\n")
  if (stripped.length < 4 || stripped.length >= totalLines || estimateTokens(preview) >= estimateTokens(text) * 0.7) return undefined
  return { preview, itemCount: { original: totalLines, compressed: stripped.length } }
}

function looksLikeConfig(lines: string[]) {
  if (lines.length < 12) return false
  const comments = lines.filter((line) => /^\s*#/.test(line) || /^[#;]/.test(line)).length
  const structures = lines.filter((line) => /^\s*[A-Za-z_][\w.-]*\s*:(?:\s|$)/.test(line) || /^\s*\[[^\]]+\]\s*$/.test(line)).length
  return comments >= 4 && structures >= 3 && (comments + structures) / lines.length >= 0.5
}

function compressConfigLines(lines: string[]) {
  const text = lines.join("\n")
  if (/:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?(?:\s+#.*)?/m.test(text) || /"""|'''/.test(text)) return lines
  const ini = lines.some((line) => /^\s*\[[^\]]+\]\s*$/.test(line))
  const isComment = (line: string) => ini ? /^[#;]/.test(line) : /^\s*#/.test(line)
  const kept = lines.filter((line) => line.trim() !== "" && !isComment(line))
  const omitted = lines.length - kept.length
  if (omitted < 8 || kept.length < 4) return lines
  return [...kept, `[... ${omitted} comment/blank lines elided ...]`]
}

function compressCodeLines(lines: string[]) {
  const output: string[] = []
  const python = /\b(def |elif |self\.|print\()/.test(lines.join("\n"))
  const comment = python ? "#" : "//"
  const placeholder = (count: number, indent: string) => `${indent}${python ? `pass  # [... ${count} lines elided]` : `${comment} [... ${count} lines elided]`}`
  const imports = /^\s*(import\b|from\s+\S+\s+import\b|package\s|using\s|require\(|#include|use\s)/
  const declarations = /^\s*(export\s+)?(default\s+)?(async\s+)?(function\b|class\b|interface\b|type\s+\w+\s*=|enum\b|struct\b|impl\b|trait\b|def\b|fn\b|pub\b|public\b|private\b|protected\b)/
  const decorators = /^\s*@(?:[A-Za-z_][\w.]*)/
  const structure = (line: string) => imports.test(line) || declarations.test(line) || decorators.test(line) || (/[{(:]\s*$/.test(line) && /\(/.test(line) && !/^\s*[)}\]]/.test(line))
  const flush = () => {
    if (run) { output.push(placeholder(run, runIndent)); run = 0; runIndent = "" }
  }
  let elided = 0
  let run = 0
  let runIndent = ""
  let docDelimiter: string | undefined
  for (const line of lines) {
    if (docDelimiter) {
      if (line.includes(docDelimiter)) { flush(); output.push(line); docDelimiter = undefined }
      else { if (run === 0) runIndent = /^\s*/.exec(line)?.[0] ?? ""; run++; elided++ }
      continue
    }
    const doc = /("""|''')/.exec(line)
    if (doc) {
      flush()
      output.push(line)
      if (!line.slice(doc.index + 3).includes(doc[1]!)) docDelimiter = doc[1]
      continue
    }
    if (structure(line) || /^\s*[}\])];?\s*$/.test(line)) { flush(); output.push(line); continue }
    if (line.trim() === "") { if (run === 0) output.push(""); continue }
    if (run === 0) runIndent = /^\s*/.exec(line)?.[0] ?? ""
    run++
    elided++
  }
  flush()
  return elided < 10 ? lines : output
}

const RetrieveInput = Schema.Struct({ hash: Schema.String.annotate({ description: "24-character hash from a [ccr:...] marker" }) })

type KVInstance = KVInterface

/** 一轮请求视图转换：压缩/复用保护窗外的大 tool 输出，缩放窗口外的历史图片。 */
export const transformMessages = (
  kv: KVInstance,
  messages: Message[],
  sessionID: string,
  config: Config = defaultConfig,
) =>
  Effect.gen(function* () {
    const startedAt = Date.now()
    const { minTokens, protectRecent, ttl, images: imagesEnabled } = config
    const view = [...messages]
    const query = [...view].reverse().find((message) => message.role === "user")?.content
      .filter((part) => part.type === "text").map((part) => part.text).join(" ") ?? ""
    const cutoff = Math.max(0, view.length - protectRecent)
    let created = 0
    let reused = 0
    let originalTokens = 0
    let compressedTokens = 0
    let imagesResized = 0
    for (let i = 0; i < cutoff; i++) {
      const message = view[i]!
      if (imagesEnabled && !imageDetailQuery.test(query) && message.role !== "tool") {
        let changed = false
        const content: Array<(typeof message.content)[number]> = []
        for (const part of message.content) {
          if (part.type !== "media" || !part.mediaType.startsWith("image/")) {
            content.push(part)
            continue
          }
          // resizeHistoryImage 内部已捕获一切异常（返回 undefined 透传），永不 reject。
          const resized = yield* Effect.promise(() => resizeHistoryImage(part.mediaType, part.data))
          if (resized === undefined) {
            content.push(part)
            continue
          }
          changed = true
          imagesResized++
          content.push({ ...part, data: resized })
        }
        if (changed) view[i] = { ...message, content }
      }
      if (message.role !== "tool") continue
      const resultIndex = message.content.findIndex((part) => part.type === "tool-result")
      const result = resultIndex < 0 ? undefined : message.content[resultIndex]
      if (!result || result.type !== "tool-result" || exclusions.has(result.name)) continue
      const value = result.result.type === "text"
        ? typeof result.result.value === "string" ? result.result.value : undefined
        : result.result.type === "json"
          ? JSON.stringify(result.result.value)
          : result.result.type === "content" && result.result.value.every((part) => part.type === "text")
            ? result.result.value.map((part) => part.text).join("\n")
            : undefined
      if (typeof value !== "string" || estimateTokens(value) < minTokens || markerPattern.test(value)) continue
      const key = `plugin/ccr/${sessionID}/${contentHash(value)}`
      const prior = yield* kv.get(key).pipe(Effect.catch(() => Effect.succeed(undefined)), Effect.catchDefect(() => Effect.succeed(undefined)))
      const priorExpired = (entry: unknown) =>
        !!entry && typeof entry === "object" && !Array.isArray(entry) && "expiresAt" in entry &&
        typeof (entry as { expiresAt: unknown }).expiresAt === "string" &&
        Date.parse((entry as { expiresAt: string }).expiresAt) <= Date.now()
      if (
        prior &&
        typeof prior === "object" &&
        !Array.isArray(prior) &&
        "replacement" in prior &&
        typeof prior.replacement === "string" &&
        !priorExpired(prior)
      ) {
        const content = [...message.content]
        content[resultIndex] = ToolResultPart.make({ ...result, result: prior.replacement, resultType: "text" })
        view[i] = { ...message, content }
        reused++
        originalTokens += estimateTokens(value)
        compressedTokens += estimateTokens(prior.replacement)
        continue
      }
      const compressed = compressOutput(value, query, config)
      if (!compressed) continue
      const entry = {
        hash: compressed.id,
        sessionID,
        ...(message.id === undefined ? {} : { messageID: message.id }),
        tool: result.name,
        original: value,
        replacement: compressed.replacement,
        strategy: compressed.strategy,
        originalTokens: estimateTokens(value),
        compressedTokens: estimateTokens(compressed.preview),
        ...(compressed.itemCount
          ? { originalItems: compressed.itemCount.original, compressedItems: compressed.itemCount.compressed }
          : {}),
        createdAt: new Date().toISOString(),
        expiresAt: ttl ? new Date(Date.now() + ttl * 1000).toISOString() : null,
        retrievalCount: 0,
      }
      const expired = priorExpired(prior)
      const written = yield* (expired ? kv.set(key, entry).pipe(Effect.as(true)) : kv.setIfAbsent(key, entry)).pipe(
        Effect.catch(() => Effect.succeed(false)),
        Effect.catchDefect(() => Effect.succeed(false)),
      )
      let replacement = compressed.replacement
      if (written && expired) {
        // 过期覆盖路径：写入成功且无竞争，直接使用本地生成的 replacement。
      } else {
        const winner = yield* kv.get(key).pipe(Effect.catch(() => Effect.succeed(undefined)), Effect.catchDefect(() => Effect.succeed(undefined)))
        if (
          !winner || typeof winner !== "object" || Array.isArray(winner) ||
          !("replacement" in winner) || typeof winner.replacement !== "string" || priorExpired(winner)
        ) continue
        replacement = winner.replacement
        if (!written) reused++
      }
      const content = [...message.content]
      content[resultIndex] = ToolResultPart.make({ ...result, result: replacement, resultType: "text" })
      view[i] = { ...message, content }
      if (written) created++
      originalTokens += estimateTokens(value)
      compressedTokens += estimateTokens(replacement)
    }
    yield* Effect.logInfo("[ccr] turn", {
      messages: view.length,
      window: cutoff,
      created,
      reused,
      compressed: created + reused,
      originalTokens,
      compressedTokens,
      savedPct: originalTokens ? Number(((1 - compressedTokens / originalTokens) * 100).toFixed(1)) : 0,
      imagesResized,
      tookMs: Date.now() - startedAt,
    })
    return view
  })

export type RetrieveOutcome =
  | { readonly status: "available"; readonly original: string; readonly countedOn: string }
  | { readonly status: "expired" }
  | { readonly status: "not_found" }

/** 按 hash 取回原文；自身 session 未命中时沿父链回溯（默认最多 3 层）。 */
export const retrieveEntry = (
  kv: KVInstance,
  hash: string,
  sessionID: string,
  resolveParent: (sessionID: string) => Effect.Effect<string | undefined>,
  maxDepth = 3,
) =>
  Effect.gen(function* () {
    let current: string | undefined = sessionID
    let entry: import("../kv.js").Value | undefined
    for (let depth = 0; current && depth <= maxDepth; depth++) {
      entry = yield* kv.get(`plugin/ccr/${current}/${hash}`).pipe(Effect.catch(() => Effect.succeed(undefined)), Effect.catchDefect(() => Effect.succeed(undefined)))
      if (entry) break
      current = yield* resolveParent(current)
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !("original" in entry) || typeof entry.original !== "string")
      return { status: "not_found" } as const
    if (typeof entry.expiresAt === "string" && Date.parse(entry.expiresAt) <= Date.now()) return { status: "expired" } as const
    if (current)
      yield* kv.set(`plugin/ccr/${current}/${hash}`, { ...entry, retrievalCount: Number(entry.retrievalCount ?? 0) + 1 }).pipe(
        Effect.catch(() => Effect.void),
        Effect.catchDefect(() => Effect.void),
      )
    return { status: "available", original: entry.original, countedOn: current ?? sessionID } as const
  })

export const Plugin = {
  id: "opencode.ccr",
  effect: Effect.fn("CcrPlugin.effect")(function* (ctx: Context) {
    if (!ON) return
    const kv = yield* KV.Service
    const transform = (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        event.messages = yield* transformMessages(kv, event.messages, event.sessionID)
      })
    yield* ctx.session.hook("context", transform)
    yield* ctx.session.hook("compaction", transform)
    yield* ctx.tool.transform((editor) => {
      editor.add({
        name: "ccr_retrieve",
        description: "Retrieve the full original tool output saved by context compression. Pass the hash from a [ccr:...] marker.",
        input: RetrieveInput,
        options: { codemode: false },
        execute: (input, context) =>
          Effect.gen(function* () {
            const outcome = yield* retrieveEntry(kv, input.hash, context.sessionID, (sid) =>
              ctx.session
                .get({ sessionID: sid as typeof context.sessionID })
                .pipe(
                  Effect.map((info) => info.parentID),
                  Effect.catch(() => Effect.succeed(undefined)),
                ))
            if (outcome.status === "not_found")
              return yield* new ToolFailure({ message: "CCR content not found. Re-run the source command or re-read the source file." })
            if (outcome.status === "expired")
              return yield* new ToolFailure({
                message: "CCR entry expired. Do not retry this hash; re-run the source command or re-read the source file.",
              })
            return { content: outcome.original }
          }),
      })
    }).pipe(Effect.orDie)
  }),
}
