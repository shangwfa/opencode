export * as SessionContextAnalysis from "./context-analysis.js"

import { and, asc, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SessionContextInsights as C } from "@opencode/schema/session-context-insights"
import { SessionID } from "@opencode/schema/session-id"
import { Money } from "@opencode/schema/money"
import { Event } from "@opencode/schema/event"
import { SessionEvent } from "@opencode/schema/session-event"
import { Database } from "../database/database.js"
import { EventSequenceTable, EventTable } from "../event/sql.js"
import { SessionContextContentTable, SessionContextRequestTable, SessionInboxTable, SessionMessageTable, SessionTable } from "./sql.js"
import { LogTable } from "../log/sql.js"
import { eventsOf, filesOf, jsonValue, pointOf, statsOf } from "./context-analysis-fold.js"

const EventLimit = 2000
const relevant = new Set([
  "session.step.started", "session.step.streamed", "session.step.ended", "session.step.failed",
  "session.tool.input.started", "session.tool.called", "session.tool.success", "session.tool.failed",
  "session.text.started", "session.reasoning.started", "session.retry.scheduled",
  "session.execution.started", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted",
  "session.compaction.started", "session.compaction.ended", "session.compaction.failed",
  "session.instructions.updated", "session.skill.activated", "session.model.selected", "session.agent.selected",
])
const types = SessionEvent.DurableDefinitions.filter((definition) => relevant.has(definition.type))
  .map((definition) => Event.versionedType(definition.type, definition.durable.version))
const field = (name: string) => sql`json_extract(${EventTable.data}, ${`$.${name}`})`
const scalar = (value: unknown) => { const parsed = jsonValue(value); return typeof parsed === "string" ? parsed : null }

/**
 * First line of the user message that opened each request. Text bodies live in the dedup table,
 * so they are fetched in one batch and truncated here — the browser never receives full prompts.
 */
const briefOf = Effect.fn("SessionContextAnalysis.brief")(function* (
  rows: ReadonlyArray<{ request: C.Request; items: ReadonlyArray<C.Item> | null }>,
) {
  const { db } = yield* Database.Service
  const picked = rows.flatMap((row) => {
    const item = (row.items ?? []).findLast((candidate: C.Item) => candidate.category === "user" && candidate.hash !== undefined)
    return item?.hash === undefined || item.name.endsWith(":media") ? [] : [{ requestID: row.request.id, hash: item.hash }]
  })
  if (picked.length === 0) return new Map<string, string>()
  const hashes = Array.from(new Set(picked.map((entry) => entry.hash)))
  const bodies = yield* db.select({ hash: SessionContextContentTable.hash, content: SessionContextContentTable.content })
    .from(SessionContextContentTable).where(inArray(SessionContextContentTable.hash, hashes)).all().pipe(Effect.orDie)
  const byHash = new Map(bodies.map((row) => [row.hash, row.content]))
  const result = new Map<string, string>()
  for (const entry of picked) {
    const body = byHash.get(entry.hash)
    if (body === undefined) continue
    const parsed = jsonValue(body)
    const value = typeof parsed === "string" ? parsed : typeof (parsed as { text?: unknown })?.text === "string" ? (parsed as { text: string }).text : undefined
    const line = value?.split("\n").map((part) => part.trim()).find((part) => part !== "")
    if (line !== undefined) result.set(entry.requestID, line.length > 120 ? `${line.slice(0, 120)}…` : line)
  }
  return result
})

/** 已入队但尚未被模型调用消费的输入（来自 session_inbox，不触发任何执行）。 */
const pendingInputs = Effect.fn("SessionContextAnalysis.pending")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ time: SessionInboxTable.time_created })
    .from(SessionInboxTable)
    .where(eq(SessionInboxTable.session_id, sessionID))
    .orderBy(asc(SessionInboxTable.enqueued_seq))
    .limit(200)
    .all()
    .pipe(Effect.orDie)
  if (rows.length === 0) return undefined
  return {
    count: rows.length,
    first: rows[0]?.time ?? 0,
    last: rows.at(-1)?.time ?? 0,
  }
})

/**
 * 系统提示词 / 工具集的变更点：按请求内 system 与 tools 项的 hash 集合做签名，
 * 与上一个请求比较。只依赖已采集快照，不触碰运行中的组合流程。
 */
const epochPoints = (page: ReadonlyArray<{ request: C.Request; items: ReadonlyArray<C.Item> | null; seq: number }>): C.Epoch[] => {
  const signature = (items: ReadonlyArray<C.Item> | null, category: C.Category) =>
    (items ?? []).filter((item) => item.category === category && item.hash !== undefined)
      .map((item) => item.hash as string).toSorted().join(",")
  const result: C.Epoch[] = []
  let previous: { system: string; tools: string } | undefined
  for (const row of page) {
    const system = signature(row.items, "system")
    const tools = signature(row.items, "tools")
    const systemChanged = previous !== undefined && previous.system !== system
    const toolsChanged = previous !== undefined && previous.tools !== tools
    if (previous === undefined || systemChanged || toolsChanged)
      result.push({
        requestID: row.request.id, seq: row.seq, time: row.request.time,
        system: system.slice(0, 12), tools: tools.slice(0, 12), systemChanged, toolsChanged,
      })
    previous = { system, tools }
  }
  return result
}

/** Slash-command usage from the durable audit log; names only, no prompt bodies. */
const commandUsage = Effect.fn("SessionContextAnalysis.commands")(function* (
  sessionID: SessionID,
  since: number,
) {
  const { db } = yield* Database.Service
  const rows = yield* db
    .select({ detail: LogTable.detail, time: LogTable.time_created })
    .from(LogTable)
    .where(and(eq(LogTable.session_id, sessionID), eq(LogTable.source, "session.command")))
    .orderBy(asc(LogTable.time_created))
    .limit(500)
    .all()
    .pipe(Effect.orDie)
  const byName = new Map<string, { calls: number; last: number }>()
  for (const row of rows) {
    if (row.time < since) continue
    const name = typeof row.detail?.name === "string" ? row.detail.name : undefined
    if (!name) continue
    const old = byName.get(name)
    byName.set(name, { calls: (old?.calls ?? 0) + 1, last: Math.max(old?.last ?? 0, row.time) })
  }
  return Array.from(byName, ([name, value]) => ({ name, ...value })).toSorted((left, right) => right.calls - left.calls)
})

export const get = Effect.fn("SessionContextAnalysis.get")(function* (
  sessionID: SessionID, options: { readonly before?: number; readonly limit?: number } = {},
) {
  const { db } = yield* Database.Service
  const head = yield* db.select({ seq: EventSequenceTable.seq }).from(EventSequenceTable)
    .where(eq(EventSequenceTable.aggregate_id, sessionID)).get().pipe(Effect.orDie)
  const limit = Math.max(1, Math.min(options.limit ?? 100, 100))
  const requests = yield* db.select({
    request: SessionContextRequestTable.summary, seq: SessionContextRequestTable.seq, items: SessionContextRequestTable.items,
    turn: sql<number>`(SELECT count(*) FROM ${SessionMessageTable} WHERE ${SessionMessageTable.session_id} = ${sessionID} AND ${SessionMessageTable.type} = 'user' AND ${SessionMessageTable.seq} < ${SessionContextRequestTable.seq})`.mapWith(Number).as("turn_number"),
  }).from(SessionContextRequestTable).where(and(
    eq(SessionContextRequestTable.session_id, sessionID), lte(SessionContextRequestTable.seq, head?.seq ?? -1),
    options.before === undefined ? undefined : lt(SessionContextRequestTable.seq, options.before),
  )).orderBy(desc(SessionContextRequestTable.seq)).limit(limit + 1).all().pipe(Effect.orDie)
  const page = requests.slice(0, limit).reverse()
  const oldest = page[0]
  if (!oldest) return { points: [], events: [], files: [], eventsTruncated: false, scope: "request-page" as const }
  // The PG bridge needs distinct aliases for repeated JSON expressions.
  const rows = yield* db.select({
    seq: EventTable.seq, created: EventTable.created, type: EventTable.type,
    callID: field("id").mapWith(scalar).as("call_id"),
    assistantID: field("assistantMessageID").mapWith(scalar).as("assistant_id"),
    name: field("name").mapWith(scalar).as("tool_name"),
    input: field("input").as("tool_input"), nested: field("metadata.toolCalls").as("nested_calls"), tokens: field("tokens").as("actual_tokens"),
    cost: sql<number | null>`CAST(${field("cost")} AS REAL)`.as("actual_cost"), model: field("model").as("selected_model"),
    reason: field("reason").mapWith(scalar).as("event_reason"),
    delta: field("delta").as("instruction_delta"),
    content: field("content").as("tool_content"),
  }).from(EventTable).where(and(
    eq(EventTable.aggregate_id, sessionID), gte(EventTable.seq, oldest.seq), lte(EventTable.seq, head?.seq ?? -1),
    options.before === undefined ? undefined : lt(EventTable.seq, options.before), inArray(EventTable.type, types),
  )).orderBy(asc(EventTable.seq)).limit(EventLimit + 1).all().pipe(Effect.orDie)
  const events = rows.slice(0, EventLimit)
  const briefs = yield* briefOf(page)
  // 只统计本页时间窗内的命令（以最老请求的采集时间为界，单位是毫秒）。
  const commands = yield* commandUsage(sessionID, page[0]?.request.time ?? 0)
  const pending = yield* pendingInputs(sessionID)
  const epochs = epochPoints(page)
  const skillTokens = page.reduce((total, row) => total + (row.items ?? [])
    .filter((item) => item.origin === "skills")
    .reduce((sum, item) => sum + item.estimatedTokens, 0), 0)
  const attachments = page.flatMap((row) => (row.items ?? [])
    .filter((item) => item.media !== undefined)
    .map((item) => ({ requestID: row.request.id, name: item.name, mediaType: item.media!.mediaType,
      ...(item.media!.filename === undefined ? {} : { filename: item.media!.filename }), bytes: item.bytes })))
  return {
    points: page.map((row, index) => {
      const point = pointOf(row.request, row.seq, row.turn, page[index - 1]?.request ?? requests[limit]?.request,
        events.filter((event) => event.seq >= row.seq && event.seq < (page[index + 1]?.seq ?? Infinity)))
      const brief = briefs.get(row.request.id)
      return brief === undefined ? point : { ...point, brief }
    }),
    // Compaction net change: the estimate right before vs right after the event.
    events: eventsOf(events, page.map((row, index) => ({ seq: row.seq, turn: row.turn ?? index + 1 }))).map((event) => {
      if (event.type !== "compaction") return event
      const before = page.findLast((row) => row.seq <= event.seq)?.request.estimatedTokens
      const after = page.find((row) => row.seq > event.seq)?.request.estimatedTokens
      return before === undefined || after === undefined ? event : { ...event, tokens: after - before }
    }),
    files: filesOf(events), attachments,
    stats: { ...statsOf(events, page.map((row, index) => ({ seq: row.seq, turn: row.turn ?? index + 1 })), commands), skillTokens },
    ...(pending === undefined ? {} : { pending }),
    ...(epochs.length === 0 ? {} : { epochs }),
    eventsTruncated: rows.length > EventLimit, scope: "request-page" as const,
    ...(requests.length > limit ? { next: oldest.seq } : {}),
  }
})

const decodeRequest = (value: unknown): C.Request | null => {
  try { return Schema.decodeUnknownSync(C.Request)(jsonValue(value)) } catch { return null }
}

export const cards = Effect.fn("SessionContextAnalysis.cards")(function* (ids: ReadonlyArray<SessionID>) {
  if (ids.length === 0) return []
  const { db } = yield* Database.Service
  const rows = yield* db.select({
    id: SessionTable.id, title: SessionTable.title, parentID: SessionTable.parent_id, forkID: SessionTable.fork_session_id,
    running: SessionTable.time_suspended, outcome: SessionTable.idle_outcome, updated: SessionTable.time_updated,
    started: SessionTable.time_created,
    cost: SessionTable.cost, input: SessionTable.tokens_input, output: SessionTable.tokens_output, reasoning: SessionTable.tokens_reasoning,
    read: SessionTable.tokens_cache_read, write: SessionTable.tokens_cache_write,
    latest: sql`(SELECT ${SessionContextRequestTable.summary} FROM ${SessionContextRequestTable} WHERE ${SessionContextRequestTable.session_id} = ${SessionTable.id} ORDER BY ${SessionContextRequestTable.seq} DESC LIMIT 1)`.as("latest_request"),
    requests: sql<number>`(SELECT count(*) FROM ${SessionContextRequestTable} WHERE ${SessionContextRequestTable.session_id} = ${SessionTable.id})`.mapWith(Number).as("request_count"),
  }).from(SessionTable).where(inArray(SessionTable.id, ids)).orderBy(desc(SessionTable.time_updated)).all().pipe(Effect.orDie)
  return rows.map((row): C.SessionCard => ({
    sessionID: row.id, title: row.title ?? row.id, parentID: row.parentID, forkID: row.forkID, running: row.running !== null, outcome: row.outcome,
    updated: row.updated, latest: decodeRequest(row.latest), requests: row.requests, started: row.started,
    usage: { cost: Money.USD.make(row.cost), tokens: { input: row.input, output: row.output, reasoning: row.reasoning, cache: { read: row.read, write: row.write } } },
  }))
})

export const family = Effect.fn("SessionContextAnalysis.family")(function* (sessionID: SessionID) {
  const { db } = yield* Database.Service
  let root = sessionID
  let complete = true
  const visited = new Set<SessionID>()
  for (let depth = 0; depth < 32; depth++) {
    if (visited.has(root)) { complete = false; break }
    visited.add(root)
    const row = yield* db.select({ parent: SessionTable.parent_id }).from(SessionTable).where(eq(SessionTable.id, root)).get().pipe(Effect.orDie)
    if (!row) { root = sessionID; complete = false; break }
    if (!row.parent) break
    root = row.parent
    if (depth === 31) complete = false
  }
  const ids = yield* db.all<{ id: string }>(sql`
    WITH RECURSIVE family(id) AS (
      SELECT id FROM ${SessionTable} WHERE id = ${root}
      UNION SELECT child.id FROM ${SessionTable} child JOIN family ON child.parent_id = family.id
    ) SELECT id FROM family LIMIT 501
  `).pipe(Effect.orDie)
  const members = yield* cards(ids.slice(0, 500).map((row) => SessionID.make(row.id)))
  return { rootID: root, members, complete: complete && ids.length <= 500 }
})

export const overview = Effect.fn("SessionContextAnalysis.overview")(function* (input: typeof C.OverviewInput.Type) {
  if (input.from >= input.to || input.to - input.from > 400 * 86400000)
    return yield* new C.RangeError({ message: "Overview range must be positive and at most 400 days" })
  const { db } = yield* Database.Service
  const ids = Array.from(new Set(input.sessionIDs))
  const sessions = yield* cards(ids)
  if (ids.length === 0) return { sessions, days: [], range: { from: input.from, to: input.to }, attribution: "settlement-utc" as const, coverage: "available-durable-events" as const }
  const number = (name: string) => sql`coalesce(CAST(json_extract(${EventTable.data}, ${`$.${name}`}) AS REAL), 0)`
  const settled = [SessionEvent.Step.Ended, SessionEvent.Step.Failed, SessionEvent.UsageRecorded]
    .map((definition) => Event.versionedType(definition.type, definition.durable.version))
  const days = yield* db.select({
    sessionID: EventTable.aggregate_id,
    day: sql<number>`CAST(${EventTable.created} / 86400000 AS INTEGER)`.mapWith(Number).as("usage_day"),
    tokens: sql<number>`sum(${number("tokens.input")} + ${number("tokens.output")} + ${number("tokens.reasoning")} + ${number("tokens.cache.read")} + ${number("tokens.cache.write")})`.mapWith(Number).as("usage_tokens"),
    cost: sql<number>`sum(${number("cost")})`.mapWith(Number).as("usage_cost"), settlements: sql<number>`count(*)`.mapWith(Number).as("settlements"),
  }).from(EventTable).where(and(inArray(EventTable.aggregate_id, ids), inArray(EventTable.type, settled),
    gte(EventTable.created, input.from), lt(EventTable.created, input.to), sql`${field("tokens")} IS NOT NULL`))
    .groupBy(sql`CAST(${EventTable.created} / 86400000 AS INTEGER)`, EventTable.aggregate_id).orderBy(asc(sql`CAST(${EventTable.created} / 86400000 AS INTEGER)`)).all().pipe(Effect.orDie)
  const toolTypes = [SessionEvent.Tool.Success, SessionEvent.Tool.Failed]
    .map((definition) => Event.versionedType(definition.type, definition.durable.version))
  const toolDays = yield* db.select({
    day: sql<number>`CAST(${EventTable.created} / 86400000 AS INTEGER)`.mapWith(Number).as("tool_day"),
    calls: sql<number>`count(*)`.mapWith(Number).as("tool_calls"),
  }).from(EventTable).where(and(inArray(EventTable.aggregate_id, ids), inArray(EventTable.type, toolTypes),
    gte(EventTable.created, input.from), lt(EventTable.created, input.to)))
    .groupBy(sql`CAST(${EventTable.created} / 86400000 AS INTEGER)`).all().pipe(Effect.orDie)
  const toolByDay = new Map(toolDays.map((row) => [row.day, row.calls]))
  // 配对出工具耗时与步骤墙钟时间：start→end 以 (assistant, call) / assistantMessage 关联。
  const timingTypes = [
    SessionEvent.Step.Started, SessionEvent.Step.Ended,
    SessionEvent.Tool.Input.Started, SessionEvent.Tool.Success, SessionEvent.Tool.Failed,
  ].map((definition) => Event.versionedType(definition.type, definition.durable.version))
  const timings = yield* db.select({
    day: sql<number>`CAST(${EventTable.created} / 86400000 AS INTEGER)`.mapWith(Number).as("event_day"),
    type: EventTable.type,
    aggregate: EventTable.aggregate_id,
    callID: field("id").mapWith(scalar).as("call_id"),
    assistantID: field("assistantMessageID").mapWith(scalar).as("assistant_id"),
    created: EventTable.created,
  }).from(EventTable).where(and(inArray(EventTable.aggregate_id, ids), inArray(EventTable.type, timingTypes),
    gte(EventTable.created, input.from), lt(EventTable.created, input.to)))
    .orderBy(asc(EventTable.created)).all().pipe(Effect.orDie)

  const base = timings[0]?.day ?? Math.floor(input.from / 86400000)
  const toolRuns = new Map<string, { day: number; start: number }>()
  const stepRuns = new Map<string, { day: number; start: number }>()
  const toolMs = new Map<number, number>()
  const wallMs = new Map<number, number>()
  const addMs = (map: Map<number, number>, day: number, value: number) =>
    map.set(day, (map.get(day) ?? 0) + Math.max(0, value))
  for (const row of timings) {
    const type = row.type.replace(/\.\d+$/, "")
    const key = `${row.assistantID}:${row.callID ?? ""}`
    if (type === "session.tool.input.started" || type === "session.tool.called") toolRuns.set(key, { day: row.day, start: row.created })
    else if (type === "session.tool.success" || type === "session.tool.failed") {
      const run = toolRuns.get(key)
      if (run) { addMs(toolMs, run.day, row.created - run.start); toolRuns.delete(key) }
    } else if (type === "session.step.started") stepRuns.set(row.assistantID ?? "", { day: row.day, start: row.created })
    else if (type === "session.step.ended") {
      const run = stepRuns.get(row.assistantID ?? "")
      if (run) { addMs(wallMs, run.day, row.created - run.start); stepRuns.delete(key) }
    }
    void base
  }

  // 轮次：当天入库的用户消息（session_message 持久保留，inbox 在消费后即清空）。
  const turnRows = yield* db.select({
    day: sql<number>`CAST(${SessionMessageTable.time_created} / 86400000 AS INTEGER)`.mapWith(Number).as("turn_day"),
    turns: sql<number>`count(*)`.mapWith(Number).as("turn_count"),
  }).from(SessionMessageTable).where(and(inArray(SessionMessageTable.session_id, ids),
    eq(SessionMessageTable.type, "user"), gte(SessionMessageTable.time_created, input.from), lt(SessionMessageTable.time_created, input.to)))
    .groupBy(sql`CAST(${SessionMessageTable.time_created} / 86400000 AS INTEGER)`).all().pipe(Effect.orDie)
  const turnByDay = new Map(turnRows.map((row) => [row.day, row.turns]))

  const grouped = new Map<number, C.Day>()
  for (const day of days) {
    const old = grouped.get(day.day)
    grouped.set(day.day, { date: new Date(day.day * 86400000).toISOString().slice(0, 10),
      tokens: (old?.tokens ?? 0) + Math.round(day.tokens), cost: Money.USD.make((old?.cost ?? 0) + day.cost),
      settlements: (old?.settlements ?? 0) + day.settlements, toolCalls: toolByDay.get(day.day),
      turns: turnByDay.get(day.day), toolsMs: toolMs.get(day.day), wallMs: wallMs.get(day.day),
      sessionIDs: [...(old?.sessionIDs ?? []), SessionID.make(day.sessionID)] })
  }
  return { sessions, days: Array.from(grouped.values()),
    range: { from: input.from, to: input.to }, attribution: "settlement-utc" as const, coverage: "available-durable-events" as const }
})
