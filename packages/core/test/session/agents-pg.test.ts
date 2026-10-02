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
import { ensureSession, removeIfCreated, sessionInfo } from "../lib/session"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, Agent.node, SessionAgents.node])))
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

pgTest("persists and upserts session agent overrides in PostgreSQL", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { session, created } = yield* ensureSession(db)

    const sessionID = session.id
    const agentID = Agent.ID.make(`pg-${crypto.randomUUID()}`)
    const agents = yield* SessionAgents.Service
    try {
      const stored = yield* agents.create(sessionID, {
        id: agentID,
        config: ConfigAgent.Info.make({ system: "first value", mode: "subagent" }),
      })
      expect(stored.agent.system).toBe("first value")

      yield* agents.create(sessionID, {
        id: agentID,
        config: ConfigAgent.Info.make({ system: "updated value", mode: "subagent" }),
      })
      const rows = yield* db.select().from(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).all()
      expect(rows.filter((row) => row.agent_id === agentID)).toHaveLength(1)
      expect(rows.find((row) => row.agent_id === agentID)?.config.system).toBe("updated value")
    } finally {
      yield* db.delete(SessionAgentTable).where(eq(SessionAgentTable.agent_id, agentID)).run()
      yield* removeIfCreated(db, session, created)
    }
  }),
)

pgTest("advances time_updated monotonically across same-session upserts", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { session, created } = yield* ensureSession(db)

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
      yield* removeIfCreated(db, session, created)
    }
  }),
)

pgTest("cascades PostgreSQL session agent rows when the owning session is deleted", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { session: template, created } = yield* ensureSession(db)

    const sessionID = `ses_agent_cascade_${crypto.randomUUID().replaceAll("-", "")}` as typeof template.id
    const agentID = Agent.ID.make(`cascade-${crypto.randomUUID()}`)
    const now = Date.now()
    const agents = yield* SessionAgents.Service
    yield* db
      .insert(SessionTable)
      .values({
        ...template,
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
      yield* removeIfCreated(db, template, created)
    }
  }),
)

pgTest("select prefers the merged session override and falls back for unknown ids", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { session, created } = yield* ensureSession(db)
    const agents = yield* SessionAgents.Service
    const globalAgents = yield* Agent.Service
    // The Agent `select()` resolves with no id is exactly what `SessionAgents.select` indirection
    // ends up looking up in the merged list, so override that one instead of hard-coding a name.
    const agentID = (yield* globalAgents.select()).id
    const info = sessionInfo(session)
    try {
      yield* agents.create(session.id, {
        id: agentID,
        config: ConfigAgent.Info.make({ system: "SESSION_SELECTED_SYSTEM" }),
      })

      // An explicit id resolves through the merged list, so the session override wins over the
      // global definition instead of falling back to the global `Agent.select`.
      const explicit = yield* agents.select(info, agentID)
      expect(explicit.id).toBe(agentID)
      expect(explicit.info?.system).toBe("SESSION_SELECTED_SYSTEM")

      // No id: resolve the default Agent, then look *that* up in the merged list. Permission
      // resolution depends on this indirection, so the override must survive it.
      const implicit = yield* agents.select(info)
      expect(implicit.id).toBe(agentID)
      expect(implicit.info?.system).toBe("SESSION_SELECTED_SYSTEM")

      // An unknown id has no merged definition; the fallback returns the id with no info.
      const missing = yield* agents.select(info, Agent.ID.make("does-not-exist"))
      expect(missing.id).toBe(Agent.ID.make("does-not-exist"))
      expect(missing.info).toBeUndefined()
    } finally {
      yield* db.delete(SessionAgentTable).where(eq(SessionAgentTable.agent_id, agentID)).run()
      yield* removeIfCreated(db, session, created)
    }
  }),
)
