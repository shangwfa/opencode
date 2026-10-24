export * as SessionContextInsights from "./context-insights.js"

import type { LLMRequest } from "@opencode/ai"
import { SessionContextInsights } from "@opencode/schema/session-context-insights"
import { SessionEvent } from "@opencode/schema/session-event"
import { Session } from "@opencode/schema/session"
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { snapshot } from "./context-snapshot.js"
import { SessionContextOrigin } from "./context-origin.js"
import { SessionContextContentTable, SessionContextRequestTable, SessionMcpTable, SessionToolTable } from "./sql.js"

export interface CaptureInput {
  readonly sessionID: Session.ID
  readonly kind: SessionContextInsights.Request["kind"]
  readonly agent: SessionContextInsights.Request["agent"]
  readonly model: SessionContextInsights.Request["model"]
  readonly contextWindow?: number
  readonly outputReserve?: number
  readonly inputLimit?: number
  readonly assistantMessageID?: SessionContextInsights.Request["assistantMessageID"]
  readonly request: LLMRequest
}

export interface Interface {
  readonly capture: (input: CaptureInput) => Effect.Effect<SessionContextInsights.Request>
  readonly summary: (sessionID: Session.ID) => Effect.Effect<SessionContextInsights.Summary>
  readonly list: (
    sessionID: Session.ID,
    options?: { readonly before?: number; readonly limit?: number },
  ) => Effect.Effect<SessionContextInsights.Page>
  readonly detail: (
    sessionID: Session.ID,
    requestID: SessionContextInsights.RequestID,
  ) => Effect.Effect<SessionContextInsights.Detail, SessionContextInsights.NotFoundError>
  readonly content: (
    sessionID: Session.ID,
    requestID: SessionContextInsights.RequestID,
    index: number,
  ) => Effect.Effect<SessionContextInsights.Content, SessionContextInsights.NotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContextInsights") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const bus = yield* Bus.Service
    /**
     * Tool provenance for one request. Only origins that are knowable from durable session state
     * are labelled: `session` for session-scoped custom tools and `mcp:<server>` for tools whose
     * advertised name carries the sanitized MCP server prefix. Everything else stays unlabelled
     * because the host registry does not distinguish builtin from plugin registrations.
     */
    /**
     * Per-session provenance cache. MCP servers and custom tools change rarely, and this lookup runs
     * before every model call; a short TTL removes two indexed reads from the token-start path while
     * keeping labels fresh within seconds of a config change.
     */
    const origins = new Map<Session.ID, { value: (name: string) => string | undefined; expires: number }>()
    const OriginTtlMs = 10_000
    const origin = Effect.fn("SessionContextInsights.origin")(function* (sessionID: Session.ID) {
      const cached = origins.get(sessionID)
      if (cached !== undefined && cached.expires > Date.now()) return cached.value
      const mcps = yield* db
        .select({ name: SessionMcpTable.name })
        .from(SessionMcpTable)
        .where(eq(SessionMcpTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const custom = yield* db
        .select({ name: SessionToolTable.name })
        .from(SessionToolTable)
        .where(eq(SessionToolTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      const resolve = SessionContextOrigin.resolve({
        mcp: mcps.map((row) => String(row.name)),
        custom: custom.map((row) => String(row.name)),
      })
      if (origins.size > 500) origins.clear()
      origins.set(sessionID, { value: resolve, expires: Date.now() + OriginTtlMs })
      return resolve
    })
    /** Operators can disable capture (e.g. to measure or shed load) without touching call sites. */
    const enabled = (process.env.OPENCODE_CONTEXT_INSIGHTS ?? "").toLowerCase() !== "off"
    const capture = Effect.fn("SessionContextInsights.capture")(function* (input: CaptureInput) {
      // Only requests that advertise tools need provenance; requests without tools skip the reads.
      const captured = snapshot(
        input.request,
        input.request.tools.length === 0 ? undefined : yield* origin(input.sessionID),
      )
      const request: SessionContextInsights.Request = {
        id: SessionContextInsights.RequestID.create(),
        sessionID: input.sessionID,
        kind: input.kind,
        agent: input.agent,
        model: input.model,
        time: Date.now(),
        boundary: "model-call-semantic-request",
        estimation: "text-characters-div-4",
        estimatedTokens: captured.estimatedTokens,
        composition: captured.composition,
        incomplete: captured.incomplete,
        itemCount: captured.items.length,
        ...(input.assistantMessageID === undefined ? {} : { assistantMessageID: input.assistantMessageID }),
        ...(input.contextWindow !== undefined && Number.isSafeInteger(input.contextWindow) && input.contextWindow > 0
          ? { contextWindow: input.contextWindow }
          : {}),
        ...(input.outputReserve !== undefined && Number.isSafeInteger(input.outputReserve) && input.outputReserve > 0
          ? { outputReserve: input.outputReserve }
          : {}),
        ...(input.inputLimit !== undefined && Number.isSafeInteger(input.inputLimit) && input.inputLimit > 0
          ? { inputLimit: input.inputLimit }
          : {}),
      }
      if (!enabled) return request
      yield* bus.publish(
        SessionEvent.ContextCaptured,
        { sessionID: input.sessionID, request },
        {
          commit: (seq) =>
            Effect.gen(function* () {
              const contents = Array.from(captured.contents, ([hash, content]) => ({
                session_id: input.sessionID,
                hash,
                content,
              }))
              for (let offset = 0; contents.length > 0 && offset < contents.length; offset += 20) {
                yield* db
                  .insert(SessionContextContentTable)
                  .values(contents.slice(offset, offset + 20))
                  .onConflictDoNothing()
                  .run()
                  .pipe(Effect.orDie)
              }
              yield* db
                .insert(SessionContextRequestTable)
                .values({ id: request.id, session_id: input.sessionID, seq, summary: request, items: captured.items })
                .run()
                .pipe(Effect.orDie)
            }),
        },
      )
      return request
    })
    const list = Effect.fn("SessionContextInsights.list")(function* (
      sessionID: Session.ID,
      options: { readonly before?: number; readonly limit?: number } = {},
    ) {
      const limit = Math.max(1, Math.min(100, options.limit ?? 20))
      const rows = yield* db
        .select({ summary: SessionContextRequestTable.summary, seq: SessionContextRequestTable.seq })
        .from(SessionContextRequestTable)
        .where(
          and(
            eq(SessionContextRequestTable.session_id, sessionID),
            options.before === undefined ? undefined : lt(SessionContextRequestTable.seq, options.before),
          ),
        )
        .orderBy(desc(SessionContextRequestTable.seq))
        .limit(limit + 1)
        .all()
        .pipe(Effect.orDie)
      const page = rows.slice(0, limit)
      const last = page.at(-1)
      return { data: page.map((row) => row.summary), ...(rows.length > limit && last ? { next: last.seq } : {}) }
    })
    const detail = Effect.fn("SessionContextInsights.detail")(function* (
      sessionID: Session.ID,
      requestID: SessionContextInsights.RequestID,
    ) {
      const row = yield* db
        .select({
          request: SessionContextRequestTable.summary,
          items: SessionContextRequestTable.items,
          seq: SessionContextRequestTable.seq,
        })
        .from(SessionContextRequestTable)
        .where(and(eq(SessionContextRequestTable.session_id, sessionID), eq(SessionContextRequestTable.id, requestID)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* new SessionContextInsights.NotFoundError({ sessionID, requestID })
      // 该内容（按 hash）在本会话最早出现在第几次请求：用于 DNA 的"引入步骤"列。
      // 只在有 hash 的项上计算，读取上限与请求页一致，避免扫全表。
      const prior = yield* db
        .select({ id: SessionContextRequestTable.id, seq: SessionContextRequestTable.seq, items: SessionContextRequestTable.items })
        .from(SessionContextRequestTable)
        .where(and(eq(SessionContextRequestTable.session_id, sessionID), lt(SessionContextRequestTable.seq, row.seq)))
        .orderBy(SessionContextRequestTable.seq)
        .limit(200)
        .all()
        .pipe(Effect.orDie)
      const firstSeen = new Map<string, number>()
      for (const [index, request] of prior.entries())
        for (const item of request.items) if (item.hash !== undefined && !firstSeen.has(item.hash)) firstSeen.set(item.hash, index + 1)
      const items = row.items.map((item) =>
        item.hash !== undefined && firstSeen.has(item.hash) ? { ...item, introduced: firstSeen.get(item.hash) } : item,
      )
      return { request: row.request, items }
    })
    const content = Effect.fn("SessionContextInsights.content")(function* (
      sessionID: Session.ID,
      requestID: SessionContextInsights.RequestID,
      index: number,
    ) {
      const row = yield* detail(sessionID, requestID)
      const item = row.items[index]
      if (!item) return yield* new SessionContextInsights.NotFoundError({ sessionID, requestID })
      if (!item.hash) return { item, content: null }
      const body = yield* db
        .select({ content: SessionContextContentTable.content })
        .from(SessionContextContentTable)
        .where(
          and(eq(SessionContextContentTable.session_id, sessionID), eq(SessionContextContentTable.hash, item.hash)),
        )
        .get()
        .pipe(Effect.orDie)
      if (!body) return yield* new SessionContextInsights.NotFoundError({ sessionID, requestID })
      return { item, content: body.content }
    })
    const summary = Effect.fn("SessionContextInsights.summary")(function* (sessionID: Session.ID) {
      const row = yield* db
        .select({ summary: SessionContextRequestTable.summary, total: sql<number>`count(*) over ()`.mapWith(Number) })
        .from(SessionContextRequestTable)
        .where(eq(SessionContextRequestTable.session_id, sessionID))
        .orderBy(desc(SessionContextRequestTable.seq))
        .limit(1)
        .get()
        .pipe(Effect.orDie)
      return {
        capturedRequests: row?.total ?? 0,
        latest: row?.summary ?? null,
        history: "captured-requests-only" as const,
      }
    })
    return Service.of({ capture, list, detail, content, summary })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Database.node, Bus.node] })
