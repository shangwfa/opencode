import { describe, expect } from "bun:test"
import { LLM, Message } from "@opencode/ai"
import * as OpenAI from "@opencode/ai/providers/openai"
import { Session } from "@opencode/schema/session"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Project } from "@opencode/schema/project"
import { SessionContextInsights as Contract } from "@opencode/schema/session-context-insights"
import { SessionEvent } from "@opencode/schema/session-event"
import { Effect, Exit, Stream } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import { EventTable } from "../src/event/sql"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionContextInsights } from "../src/session/context-insights"
import { SessionContextAnalysis } from "../src/session/context-analysis"
import { SessionMessage } from "@opencode/schema/session-message"
import { Money } from "@opencode/schema/money"
import { SessionContextContentTable, SessionContextRequestTable, SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionContextInsights.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ]),
)
const model = OpenAI.configure({ apiKey: "secret" }).chat("test")
const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  const service = yield* SessionContextInsights.Service
  const sessionID = Session.ID.create()
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "context-test",
      directory: "/workspace",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  yield* Effect.addFinalizer(() =>
    db
      .delete(SessionTable)
      .where(eq(SessionTable.id, sessionID))
      .run()
      .pipe(Effect.orDie, Effect.andThen(bus.remove(sessionID))),
  )
  const input = {
    sessionID,
    kind: "primary" as const,
    agent: Agent.ID.make("build"),
    model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("openai") }),
    contextWindow: 100_000,
    request: LLM.request({ model, system: "context test system", messages: [Message.user("hello")] }),
  }
  return { db, bus, service, sessionID, input }
})

describe("session context insights persistence", () => {
  it.live("analyzes persisted requests and counts settlement usage once in the explicit overview scope", () => Effect.gen(function* () {
    const { bus, service, input, sessionID } = yield* setup
    const assistantMessageID = SessionMessage.ID.create()
    yield* service.capture({ ...input, assistantMessageID })
    yield* bus.publish(SessionEvent.Step.Started, { sessionID, assistantMessageID, agent: input.agent, model: input.model })
    yield* bus.publish(SessionEvent.Tool.Input.Started, { sessionID, assistantMessageID, id: "read_1", name: "read" })
    yield* bus.publish(SessionEvent.Tool.Called, { sessionID, assistantMessageID, id: "read_1", input: { filePath: "/workspace/probe.ts" }, executed: true })
    yield* bus.publish(SessionEvent.Tool.Success, { sessionID, assistantMessageID, id: "read_1", executed: true, content: [{ type: "text", text: "PRIVATE_RESULT" }] })
    const tokens = { input: 8, output: 2, reasoning: 0, cache: { read: 3, write: 0 } }
    yield* bus.publish(SessionEvent.Step.Ended, { sessionID, assistantMessageID, tokens, cost: Money.USD.make(0.1), finish: "stop" })
    const analysis = yield* SessionContextAnalysis.get(sessionID)
    expect(analysis.points).toHaveLength(1)
    expect(analysis.points[0]).toMatchObject({ status: "completed", actual: { tokens, cost: 0.1 } })
    expect(analysis.files[0]).toMatchObject({ path: "/workspace/probe.ts", calls: 1 })
    expect(JSON.stringify(analysis)).not.toContain("PRIVATE_RESULT")
    const overview = yield* SessionContextAnalysis.overview({ sessionIDs: [sessionID, sessionID], from: Date.now() - 10_000, to: Date.now() + 10_000 })
    expect(overview.sessions).toHaveLength(1)
    expect(overview.sessions[0]?.latest?.id).toBe(analysis.points[0]?.request.id)
    expect(overview.days[0]).toMatchObject({ tokens: 13, cost: 0.1, settlements: 1 })
    expect((yield* SessionContextAnalysis.overview({ sessionIDs: [], from: 0, to: 1000 })).days).toEqual([])
    expect(Exit.isFailure(yield* SessionContextAnalysis.overview({ sessionIDs: [], from: 100, to: 0 }).pipe(Effect.exit))).toBe(true)
  }))

  it.live("family follows parent lineage but excludes a fork", () => Effect.gen(function* () {
    const { db, sessionID } = yield* setup
    const child = Session.ID.create()
    const fork = Session.ID.create()
    for (const [id, parent, origin] of [[child, sessionID, null], [fork, null, sessionID]] as const) {
      yield* db.insert(SessionTable).values({ id, project_id: Project.ID.global, slug: id, directory: "/workspace", version: "test", parent_id: parent, fork_session_id: origin }).run().pipe(Effect.orDie)
      yield* Effect.addFinalizer(() => db.delete(SessionTable).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie))
    }
    const family = yield* SessionContextAnalysis.family(child)
    expect(family.rootID).toBe(sessionID)
    expect(new Set(family.members.map((item) => item.sessionID))).toEqual(new Set([sessionID, child]))
    expect((yield* SessionContextAnalysis.family(fork)).members.map((item) => item.sessionID)).toEqual([fork])
  }))

  it.live("captures a bounded manifest, pages summaries, deduplicates bodies and isolates sessions", () =>
    Effect.gen(function* () {
      const { db, service, input, sessionID } = yield* setup
      expect(yield* service.summary(sessionID)).toEqual({
        capturedRequests: 0,
        latest: null,
        history: "captured-requests-only",
      })
      const first = yield* service.capture(input)
      const second = yield* service.capture(input)
      expect(first.id).not.toBe(second.id)
      const summary = yield* service.summary(sessionID)
      expect(summary).toMatchObject({ capturedRequests: 2, latest: { id: second.id, contextWindow: 100_000 } })
      const page = yield* service.list(sessionID, { limit: 1 })
      expect(page.data.map((item) => item.id)).toEqual([second.id])
      expect(page.next).toBeDefined()
      expect((yield* service.list(sessionID, { before: page.next, limit: 1 })).data.map((item) => item.id)).toEqual([
        first.id,
      ])
      expect((yield* service.detail(sessionID, first.id)).items).toHaveLength(2)
      expect((yield* service.content(sessionID, first.id, 0)).content).toBe("context test system")
      const bodies = yield* db
        .select()
        .from(SessionContextContentTable)
        .where(eq(SessionContextContentTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(bodies).toHaveLength(2)
      const isolated = yield* service.detail(Session.ID.create(), first.id).pipe(Effect.exit)
      expect(Exit.isFailure(isolated)).toBe(true)
      expect(yield* service.list(Session.ID.create())).toEqual({ data: [] })
      expect(Exit.isFailure(yield* service.content(sessionID, first.id, 999).pipe(Effect.exit))).toBe(true)
      expect(Exit.isFailure(yield* service.detail(sessionID, Contract.RequestID.create()).pipe(Effect.exit))).toBe(true)
    }),
  )

  it.live("stores notification and snapshot atomically without leaking bodies into the event feed", () =>
    Effect.gen(function* () {
      const { db, bus, service, input, sessionID } = yield* setup
      const captured = yield* service.capture(input)
      const log = Array.from(yield* bus.log({ aggregateID: sessionID }).pipe(Stream.runCollect))
      const event = log.find((item) => item.type === "session.context.captured")
      expect(event).toBeDefined()
      expect(JSON.stringify(event)).not.toContain("context test system")
      expect(JSON.stringify(event)).not.toContain("hello")
      const rows = yield* db
        .select()
        .from(SessionContextRequestTable)
        .where(eq(SessionContextRequestTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.id).toBe(captured.id)
      const stored = yield* db
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!stored) throw new Error("Missing captured event")
      yield* bus.replay({ ...stored, aggregateID: sessionID })
      expect((yield* service.summary(sessionID)).capturedRequests).toBe(1)
    }),
  )

  it.live("rolls back snapshot content and notifications on failed commit", () =>
    Effect.gen(function* () {
      const { db, bus, service, input, sessionID } = yield* setup
      yield* bus.project(SessionEvent.ContextCaptured, () => Effect.die("reject projection"))
      expect(Exit.isFailure(yield* service.capture(input).pipe(Effect.exit))).toBe(true)
      expect((yield* service.summary(sessionID)).capturedRequests).toBe(0)
      expect(
        yield* db
          .select()
          .from(SessionContextContentTable)
          .where(eq(SessionContextContentTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      expect(
        Array.from(yield* bus.log({ aggregateID: sessionID }).pipe(Stream.runCollect)).filter(
          (item) => item.type === "session.context.captured",
        ),
      ).toEqual([])
    }),
  )

  it.live("rolls back newly inserted bodies when the later request insert fails", () =>
    Effect.gen(function* () {
      const { db, bus, service, input, sessionID } = yield* setup
      const first = yield* service.capture(input)
      const stored = yield* db
        .select({ seq: SessionContextRequestTable.seq })
        .from(SessionContextRequestTable)
        .where(eq(SessionContextRequestTable.id, first.id))
        .get()
        .pipe(Effect.orDie)
      if (!stored) throw new Error("Missing first request")
      const blocker = Contract.RequestID.create()
      yield* db
        .insert(SessionContextRequestTable)
        .values({
          id: blocker,
          session_id: sessionID,
          seq: stored.seq + 1,
          summary: { ...first, id: blocker, itemCount: 0 },
          items: [],
        })
        .run()
        .pipe(Effect.orDie)
      const attempted = yield* service
        .capture({
          ...input,
          request: LLM.request({ model, system: "ROLLBACK_NEW_BODY" }),
        })
        .pipe(Effect.exit)
      expect(Exit.isFailure(attempted)).toBe(true)
      const bodies = yield* db
        .select()
        .from(SessionContextContentTable)
        .where(eq(SessionContextContentTable.session_id, sessionID))
        .all()
        .pipe(Effect.orDie)
      expect(bodies).toHaveLength(2)
      expect(bodies.some((body) => body.content.includes("ROLLBACK_NEW_BODY"))).toBe(false)
      expect((yield* service.summary(sessionID)).capturedRequests).toBe(2)
      const captured = Array.from(yield* bus.log({ aggregateID: sessionID }).pipe(Stream.runCollect)).filter(
        (event) => event.type === "session.context.captured",
      )
      expect(captured).toHaveLength(1)
    }),
  )

  it.live("deletes session-private snapshots and content with the session", () =>
    Effect.gen(function* () {
      const { db, service, input, sessionID } = yield* setup
      yield* service.capture(input)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      expect((yield* service.summary(sessionID)).capturedRequests).toBe(0)
      expect(
        yield* db
          .select()
          .from(SessionContextContentTable)
          .where(eq(SessionContextContentTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
    }),
  )
})
