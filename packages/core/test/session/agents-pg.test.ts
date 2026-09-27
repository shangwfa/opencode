import { expect } from "bun:test"
import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Agent } from "@opencode/core/agent"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SessionAgents } from "@opencode/core/session/agents"
import { SessionAgentTable, SessionTable } from "@opencode/core/session/sql"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionAgents.node])))
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

pgTest("persists and upserts session agent overrides in PostgreSQL", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const [session] = yield* db.select().from(SessionTable).limit(1).all()
    if (!session) throw new Error("No test session")

    const sessionID = session.id
    const agentID = Agent.ID.make(`pg-${crypto.randomUUID()}`)
    const agents = yield* SessionAgents.Service
    try {
      const created = yield* agents.create(sessionID, {
        id: agentID,
        config: ConfigAgent.Info.make({ system: "first value", mode: "subagent" }),
      })
      expect(created.agent.system).toBe("first value")

      yield* agents.create(sessionID, {
        id: agentID,
        config: ConfigAgent.Info.make({ system: "updated value", mode: "subagent" }),
      })
      const rows = yield* db.select().from(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).all()
      expect(rows.filter((row) => row.agent_id === agentID)).toHaveLength(1)
      expect(rows.find((row) => row.agent_id === agentID)?.config.system).toBe("updated value")
    } finally {
      yield* db.delete(SessionAgentTable).where(eq(SessionAgentTable.agent_id, agentID)).run()
    }
  }),
)

pgTest("advances time_updated monotonically across same-session upserts", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const [session] = yield* db.select().from(SessionTable).limit(1).all()
    if (!session) throw new Error("No test session")

    const sessionID = session.id
    const agentID = Agent.ID.make(`pg-monotonic-${crypto.randomUUID()}`)
    const agents = yield* SessionAgents.Service
    const read = () =>
      db
        .select()
        .from(SessionAgentTable)
        .where(and(eq(SessionAgentTable.session_id, sessionID), eq(SessionAgentTable.agent_id, agentID)))
        .get()
    try {
      yield* agents.create(sessionID, {
        id: agentID,
        config: ConfigAgent.Info.make({ system: "first", mode: "subagent" }),
      })
      const first = yield* read()
      yield* agents.create(sessionID, {
        id: agentID,
        config: ConfigAgent.Info.make({ system: "second", mode: "subagent" }),
      })
      const second = yield* read()
      expect(first?.time_updated).toBeDefined()
      expect(second?.time_updated ?? 0).toBeGreaterThan(first?.time_updated ?? 0)
    } finally {
      yield* db.delete(SessionAgentTable).where(eq(SessionAgentTable.agent_id, agentID)).run()
    }
  }),
)

pgTest("cascades PostgreSQL session agent rows when the owning session is deleted", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const [existing] = yield* db.select().from(SessionTable).limit(1).all()
    if (!existing) throw new Error("No test session")

    const sessionID = `ses_agent_cascade_${crypto.randomUUID().replaceAll("-", "")}` as typeof existing.id
    const agentID = Agent.ID.make(`cascade-${crypto.randomUUID()}`)
    const now = Date.now()
    const agents = yield* SessionAgents.Service
    yield* db
      .insert(SessionTable)
      .values({
        ...existing,
        id: sessionID,
        slug: `session-agent-cascade-${crypto.randomUUID()}`,
        parent_id: null,
        fork_session_id: null,
        time_created: now,
        time_updated: now,
        time_idle: null,
        time_viewed: null,
        time_compacting: null,
        time_archived: null,
        time_suspended: null,
      })
      .run()
    yield* agents.create(sessionID, {
      id: agentID,
      config: ConfigAgent.Info.make({ system: "cascade" }),
    })

    try {
      expect(
        yield* db.select().from(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).all(),
      ).toHaveLength(1)
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      expect(
        yield* db.select().from(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).all(),
      ).toHaveLength(0)
    } finally {
      yield* db.delete(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).run()
      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
    }
  }),
)
