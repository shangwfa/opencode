import { posix } from "node:path"
import { Schema } from "effect"
import { SessionContextInsights as C } from "@opencode/schema/session-context-insights"

export interface EventRow {
  readonly seq: number
  readonly created: number
  readonly type: string
  readonly callID: string | null
  readonly assistantID: string | null
  readonly name: string | null
  readonly input: unknown
  readonly nested: unknown
  readonly tokens: unknown
  readonly cost: number | null
  readonly model: unknown
  readonly reason: string | null
  /** Instruction delta (key → hash | "removed") for `instructions.updated`. */
  readonly delta?: unknown
  /** Tool result content, only on `session.tool.success`; used to attribute search hits. */
  readonly content?: unknown
}

export const jsonValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) } catch { return value }
}
const record = (value: unknown): Record<string, unknown> => {
  const parsed = jsonValue(value)
  return Schema.is(Schema.Record(Schema.String, Schema.Unknown))(parsed) ? parsed : {}
}
const text = (value: unknown) => typeof value === "string" ? value : ""
const eventType = (row: EventRow) => row.type.replace(/\.\d+$/, "")

export const unionDuration = (intervals: ReadonlyArray<readonly [number, number]>): number => {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && end >= start).toSorted((a, b) => a[0] - b[0])
  let end = -Infinity
  let duration = 0
  for (const [start, stop] of sorted) {
    duration += Math.max(0, stop - Math.max(start, end))
    end = Math.max(end, stop)
  }
  return duration
}

/** Lines a string contributes to a file; a trailing newline is a terminator, not an extra line. */
export const lineCount = (value: string): number => {
  if (value === "") return 0
  const normalized = value.replaceAll("\r\n", "\n")
  return normalized.endsWith("\n") ? normalized.split("\n").length - 1 : normalized.split("\n").length
}

type FileTarget = {
  path: string
  action: C.FileActivity["action"]
  target: C.FileActivity["target"]
  added?: number
  removed?: number
}

/** Patch sections carry their own `+`/`-` lines; the `*** ` headers are structure, not content. */
const patchTargets = (patch: string, normalized: (value: string) => string): FileTarget[] => {
  const targets: FileTarget[] = []
  let current: FileTarget | undefined
  const flush = () => {
    if (!current) return
    targets.push({
      ...current,
      ...(current.added === undefined ? {} : { added: current.added }),
      ...(current.removed === undefined ? {} : { removed: current.removed }),
    })
    current = undefined
  }
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line)
    if (header) {
      flush()
      current = { path: normalized(header[1].trim()), action: "write", target: "file", added: 0, removed: 0 }
      continue
    }
    if (!current) continue
    if (line.startsWith("@@") || line.startsWith("*** ")) continue
    if (line.startsWith("+")) current.added = (current.added ?? 0) + 1
    else if (line.startsWith("-")) current.removed = (current.removed ?? 0) + 1
  }
  flush()
  return targets
}

const fileTargets = (name: string, input: unknown): FileTarget[] => {
  const args = jsonValue(input)
  if (!Schema.is(Schema.Record(Schema.String, Schema.Unknown))(args)) return []
  const tool = name.toLowerCase().split(".").at(-1)
  const path = text(args.filePath) || text(args.file_path) || text(args.path)
  const normalized = (value: string) => posix.normalize(value.startsWith("/") ? value : `/workspace/${value}`)
  if (["read", "write", "edit"].includes(tool ?? "") && path) {
    const target = { path: normalized(path), action: tool === "read" ? ("read" as const) : ("write" as const), target: "file" as const }
    // Only mutation inputs describe a line delta; read has none and must not claim zero.
    if (tool === "write") return [{ ...target, added: lineCount(text(args.content)) }]
    if (tool === "edit")
      return [{ ...target, added: lineCount(text(args.newString)), removed: lineCount(text(args.oldString)) }]
    return [target]
  }
  if (["glob", "grep"].includes(tool ?? ""))
    return [{ path: normalized(path || "/workspace"), action: "search", target: "scope" }]
  if (tool === "apply_patch" || tool === "patch") return patchTargets(text(args.patchText) || text(args.patch), normalized)
  return []
}

const MaxOps = 20

/** `grep` reports `path:line:text` (or `path:text`); `glob` reports bare paths, one per line. */
export const searchHits = (tool: string, content: unknown): Array<{ path: string; hits: number }> => {
  const parsed = jsonValue(content)
  const body = Array.isArray(parsed)
    ? parsed.flatMap((entry) => record(entry).type === "text" ? [text(record(entry).text)] : []).join("\n")
    : text(parsed)
  if (body.trim() === "") return []
  const counts = new Map<string, number>()
  if (tool === "glob") {
    for (const line of body.split("\n")) {
      const value = line.trim()
      if (value === "" || /\s/.test(value) && !value.includes("/")) continue
      if (value.startsWith("/")) counts.set(value, 1)
    }
  } else {
    for (const line of body.split("\n")) {
      const match = /^(\/[^:]+|[A-Za-z0-9._/-]+\.[A-Za-z0-9]+):(\d+):/.exec(line.trim())
      if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1)
    }
  }
  return Array.from(counts, ([path, hits]) => ({ path, hits }))
}

export const filesOf = (rows: ReadonlyArray<EventRow>): C.FileActivity[] => {
  const calls = new Map<string, { name: string; input: unknown; seq: number; failed: boolean }>()
  const files = new Map<string, C.FileActivity>()
  const add = (name: string, input: unknown, seq: number, failed: boolean, nested: boolean) => {
    for (const item of fileTargets(name, input)) {
      const key = `${item.action}:${item.path}`
      const old = files.get(key)
      const added = item.added === undefined && old?.added === undefined ? undefined : (old?.added ?? 0) + (item.added ?? 0)
      const removed =
        item.removed === undefined && old?.removed === undefined ? undefined : (old?.removed ?? 0) + (item.removed ?? 0)
      const op = {
        seq,
        failed,
        nested,
        ...(item.added === undefined ? {} : { added: item.added }),
        ...(item.removed === undefined ? {} : { removed: item.removed }),
      }
      files.set(key, {
        ...item,
        calls: (old?.calls ?? 0) + 1,
        failed: (old?.failed ?? 0) + Number(failed),
        nested: (old?.nested ?? 0) + Number(nested),
        lastSeq: Math.max(old?.lastSeq ?? 0, seq),
        ...(added === undefined ? {} : { added }),
        ...(removed === undefined ? {} : { removed }),
        ops: [op, ...(old?.ops ?? [])].slice(0, MaxOps),
      })
    }
  }
  const addHit = (path: string, seq: number, hits: number) => {
    const normalized = posix.normalize(path.startsWith("/") ? path : `/workspace/${path}`)
    const key = `search:${normalized}`
    const old = files.get(key)
    files.set(key, {
      path: normalized, action: "search", target: "file",
      calls: (old?.calls ?? 0) + hits, failed: old?.failed ?? 0, nested: old?.nested ?? 0,
      lastSeq: Math.max(old?.lastSeq ?? 0, seq), ops: old?.ops,
    })
  }
  for (const row of rows) {
    const type = eventType(row)
    const key = `${row.assistantID}:${row.callID}`
    if (type === "session.tool.input.started" && row.name) calls.set(key, { name: row.name, input: null, seq: row.seq, failed: false })
    const call = calls.get(key)
    if (type === "session.tool.called" && call) { call.input = jsonValue(row.input); call.seq = row.seq }
    if (type === "session.tool.success" || type === "session.tool.failed") {
      if (call) { call.failed = type.endsWith("failed"); call.seq = row.seq }
      // Attribute matched files from the tool result; only when the tool actually succeeded.
      if (type === "session.tool.success" && call && ["grep", "glob"].includes(call.name.toLowerCase().split(".").at(-1) ?? ""))
        for (const hit of searchHits(call.name.toLowerCase().split(".").at(-1) ?? "", row.content))
          addHit(hit.path, row.seq, hit.hits)
      const nested = jsonValue(row.nested)
      if (Array.isArray(nested)) for (const value of nested) {
        const item = record(value)
        if (typeof item.tool === "string" && (item.status === "completed" || item.status === "error"))
          add(item.tool, item.input, row.seq, item.status === "error", true)
      }
    }
  }
  for (const call of calls.values()) if (call.input !== null) add(call.name, call.input, call.seq, call.failed, false)
  return Array.from(files.values()).sort((a, b) => b.lastSeq - a.lastSeq)
}

export const eventsOf = (
  rows: ReadonlyArray<EventRow>,
  requests: ReadonlyArray<{ readonly seq: number; readonly turn: number }> = [],
): C.ContextEvent[] => rows.flatMap((row) => {
  const type = eventType(row)
  const category: C.ContextEvent["type"] | undefined = type.startsWith("session.compaction.") ? "compaction"
    : type === "session.instructions.updated" ? "inject" : type === "session.skill.activated" ? "skill"
    : type === "session.model.selected" ? "model" : type === "session.agent.selected" ? "agent"
    : type.startsWith("session.execution.") ? "execution" : undefined
  if (!category) return []
  const model = record(row.model)
  const delta = record(row.delta)
  const instruction = type === "session.instructions.updated" ? Object.keys(delta).join(", ") : ""
  const source = [instruction, category === "skill" ? (row.name ?? "") : row.reason ?? ""].filter(Boolean).join(", ")
  const turn = requests.filter((request) => request.seq <= row.seq).length
  return [{ seq: row.seq, time: row.created, type: category,
    label: [type.replace(/^session\./, ""), text(model.providerID), text(model.id), row.reason ?? ""].filter(Boolean).join(" · "),
    ...(source ? { source } : {}), ...(turn > 0 ? { turn } : {}) }]
})

/**
 * Counts over the request page and the events inside it. Every figure comes from a stored fact:
 * events for inject/compaction/skill/tool, request records for turns/steps. Command usage is
 * joined from the durable audit log by the caller.
 */
export const statsOf = (
  rows: ReadonlyArray<EventRow>,
  requests: ReadonlyArray<{ readonly seq: number; readonly turn: number }>,
  commands: ReadonlyArray<C.CommandUsage> = [],
): C.Stats => {
  const calls = new Map<string, { name: string; failed: boolean }>()
  let injects = 0
  let compactions = 0
  const skills = new Set<string>()
  for (const row of rows) {
    const type = eventType(row)
    if (type === "session.instructions.updated") injects += 1
    else if (type === "session.compaction.started") compactions += 1
    else if (type === "session.skill.activated") {
      if (row.name) skills.add(row.name)
    } else if ((type === "session.tool.input.started" || type === "session.tool.called") && row.callID && row.name) {
      const key = `${row.assistantID}:${row.callID}`
      calls.set(key, { name: row.name, failed: calls.get(key)?.failed ?? false })
    } else if ((type === "session.tool.success" || type === "session.tool.failed") && row.callID) {
      const key = `${row.assistantID}:${row.callID}`
      const call = calls.get(key)
      if (call) call.failed = type.endsWith("failed")
    }
  }
  const tools = new Map<string, { calls: number; failed: number }>()
  for (const call of calls.values()) {
    const old = tools.get(call.name)
    tools.set(call.name, { calls: (old?.calls ?? 0) + 1, failed: (old?.failed ?? 0) + Number(call.failed) })
  }
  return {
    requests: requests.length,
    turns: new Set(requests.map((request) => request.turn)).size,
    steps: requests.length,
    injects,
    compactions,
    skills: skills.size,
    toolCalls: calls.size,
    tools: Array.from(tools, ([name, value]) => ({ name, ...value })).toSorted((left, right) => right.calls - left.calls),
    commands: [...commands],
  }
}

export const pointOf = (
  request: C.Request, seq: number, turn: number, previous: C.Request | undefined, rows: ReadonlyArray<EventRow>,
): C.Point => {
  const own = rows.filter((row) => row.assistantID === request.assistantMessageID && request.assistantMessageID !== undefined)
  const terminal = own.findLast((row) => ["session.step.ended", "session.step.failed"].includes(eventType(row)))
  const interrupted = rows.findLast((row) => eventType(row) === "session.execution.interrupted")
  const retry = own.some((row) => eventType(row) === "session.retry.scheduled")
  /**
   * Compaction settlements carry no assistant identifier: `compaction.started` precedes the model
   * call and its `ended`/`failed` follows it. Compactions run sequentially, so the first settlement
   * at or after this capture belongs to this attempt; later captures skip it by their own time.
   */
  const compacted =
    request.kind === "compaction"
      ? rows.find(
          (row) => row.created >= request.time && ["session.compaction.ended", "session.compaction.failed"].includes(eventType(row)),
        )
      : undefined
  const first = own.find((row) => ["session.text.started", "session.reasoning.started"].includes(eventType(row)))
  const streamed = own.find((row) => eventType(row) === "session.step.streamed")
  const duration = (row: EventRow | undefined) => row ? Math.max(0, row.created - request.time) : null
  const started = new Map<string, number>()
  const intervals: Array<readonly [number, number]> = []
  for (const row of own) {
    const type = eventType(row)
    if (type === "session.tool.called" && row.callID) started.set(row.callID, row.created)
    if ((type === "session.tool.success" || type === "session.tool.failed") && row.callID) {
      const start = started.get(row.callID)
      if (start !== undefined) { intervals.push([start, row.created]); started.delete(row.callID) }
    }
  }
  // A compaction attempt is settled by its own compaction event, which repeats the usage figures.
  const settlement = terminal ?? compacted
  const candidate = { tokens: jsonValue(settlement?.tokens), cost: settlement?.cost }
  const actual = Schema.is(C.Usage)(candidate) ? candidate : null
  return {
    request, seq, turn, delta: previous ? request.estimatedTokens - previous.estimatedTokens : null,
    status: terminal ? eventType(terminal).endsWith("failed") ? "failed" : "completed" : compacted ? eventType(compacted).endsWith("failed") ? "failed" : "completed" : interrupted ? "interrupted" : retry ? "retried" : own.length ? "running" : "unknown",
    actual, elapsedMs: duration(terminal ?? compacted ?? interrupted), firstContentMs: duration(first), modelMs: duration(streamed), toolMs: started.size || !request.assistantMessageID ? null : unionDuration(intervals),
  }
}
