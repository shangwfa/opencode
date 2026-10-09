import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Log } from "@opencode/core/log"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { Session } from "@opencode/core/session"
import { SessionTable } from "@opencode/core/session/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Log.node]), []))

const setup = (sessionID = Session.ID.make("ses_log_test")) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // A shared PG test database keeps rows across runs; deleting the Session row
    // first cascades any prior log entries away so every case starts clean.
    yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: "log",
        directory: "/project",
        title: "log test",
        version: "test",
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    return sessionID
  })

describe("Log", () => {
  it.live("records and lists entries oldest-first with detail passthrough", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup()
      const logs = yield* Log.Service
      yield* logs.record({ sessionID, source: "session.create", detail: { title: "audit" } })
      yield* logs.record({ sessionID, source: "session.agentDefinition.create", detail: { id: "session/probe" } })
      yield* logs.record({ sessionID, source: "session.agentDefinition.clear" })

      const entries = yield* logs.list({ sessionID })
      expect(entries.map((entry) => entry.source)).toEqual([
        "session.create",
        "session.agentDefinition.create",
        "session.agentDefinition.clear",
      ])
      expect(entries[0]?.id).toStartWith("log_")
      expect(entries[0]?.detail).toEqual({ title: "audit" })
      expect(entries[1]?.detail).toEqual({ id: "session/probe" })
      expect(entries[2]?.detail).toBeUndefined()
      expect(entries.map((entry) => entry.time.created)).toEqual([...entries.map((entry) => entry.time.created)].sort())
    }),
  )

  it.live("degrades oversized detail to a truncation marker", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup()
      const logs = yield* Log.Service
      yield* logs.record({
        sessionID,
        source: "session.update",
        detail: { blob: "x".repeat(16_384) },
      })
      const [entry] = yield* logs.list({ sessionID })
      expect(entry?.detail?.truncated).toBe(true)
      expect(typeof entry?.detail?.bytes).toBe("number")
    }),
  )

  it.live("caps list results to the requested limit", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup()
      const logs = yield* Log.Service
      yield* logs.record({ sessionID, source: "session.create" })
      yield* logs.record({ sessionID, source: "session.update" })
      yield* logs.record({ sessionID, source: "session.interrupt" })
      const entries = yield* logs.list({ sessionID, limit: 2 })
      expect(entries.map((entry) => entry.source)).toEqual(["session.create", "session.update"])
    }),
  )

  it.live("pages the full trail with the after cursor and no default cap", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup()
      const logs = yield* Log.Service
      yield* logs.record({ sessionID, source: "session.create" })
      yield* logs.record({ sessionID, source: "session.update" })
      yield* logs.record({ sessionID, source: "session.interrupt" })
      const all = yield* logs.list({ sessionID })
      expect(all).toHaveLength(3)
      const page1 = yield* logs.list({ sessionID, limit: 2 })
      expect(page1.map((entry) => entry.source)).toEqual(["session.create", "session.update"])
      const page2 = yield* logs.list({ sessionID, limit: 2, after: page1[1]!.id })
      expect(page2.map((entry) => entry.source)).toEqual(["session.interrupt"])
      const unknown = yield* logs.list({ sessionID, after: Log.ID.make("log_missing") })
      expect(unknown).toEqual([])
    }),
  )

  it.live("cascades log rows when the session row is deleted", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup()
      const logs = yield* Log.Service
      yield* logs.record({ sessionID, source: "session.create" })
      yield* logs.record({ sessionID, source: "session.update" })
      const { db } = yield* Database.Service
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
      expect(yield* logs.list({ sessionID })).toEqual([])
    }),
  )

  it.live("keeps entries isolated per session", () =>    Effect.gen(function* () {
      const first = Session.ID.make("ses_log_first")
      const second = Session.ID.make("ses_log_second")
      yield* setup(first)
      yield* setup(second)
      const logs = yield* Log.Service
      yield* logs.record({ sessionID: first, source: "session.create" })
      yield* logs.record({ sessionID: second, source: "session.update" })
      expect((yield* logs.list({ sessionID: first })).map((entry) => entry.source)).toEqual(["session.create"])
      expect((yield* logs.list({ sessionID: second })).map((entry) => entry.source)).toEqual(["session.update"])
    }),
  )

  it.live("writes a 32-hex traceId when OTLP export is configured and a span is active", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup()
      const logs = yield* Log.Service
      const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel.test"
      try {
        yield* logs.record({ sessionID, source: "session.create" }).pipe(Effect.withSpan("test-audit"))
      } finally {
        if (previous === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous
      }
      const [entry] = yield* logs.list({ sessionID })
      expect(entry?.traceId).toMatch(/^[0-9a-f]{32}$/)
    }),
  )

  it.live("leaves traceId NULL when OTLP export is not configured", () =>
    Effect.gen(function* () {
      const sessionID = yield* setup()
      const logs = yield* Log.Service
      const previous = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT
      try {
        yield* logs.record({ sessionID, source: "session.create" }).pipe(Effect.withSpan("test-audit"))
      } finally {
        if (previous !== undefined) process.env.OTEL_EXPORTER_OTLP_ENDPOINT = previous
      }
      const [entry] = yield* logs.list({ sessionID })
      expect(entry?.traceId).toBeUndefined()
    }),
  )
})
