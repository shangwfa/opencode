import { expect } from "bun:test"
import { eq, inArray } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { SessionAgents } from "@opencode/core/session/agents"
import { SessionAgentsMd } from "@opencode/core/session/agents-md"
import { SessionCommands } from "@opencode/core/session/commands"
import { SessionMcps } from "@opencode/core/session/mcps"
import { SessionSkills } from "@opencode/core/session/skills"
import { SessionTools } from "@opencode/core/session/tools"
import { SessionResourceOwner } from "@opencode/core/session/resource-owner"
import {
  SessionTable,
  SessionAgentTable,
  SessionAgentsMdTable,
  SessionCommandTable,
  SessionMcpTable,
  SessionSkillTable,
  SessionToolTable,
} from "@opencode/core/session/sql"
import { Agent } from "@opencode/schema/agent"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { Session } from "@opencode/schema/session"
import { SessionMcp } from "@opencode/schema/session-mcp"
import { SessionTool } from "@opencode/schema/session-tool"
import { Skill } from "@opencode/schema/skill"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/schema/schema"
import { testEffect } from "../lib/effect"
import { ensureSession, removeIfCreated, sessionInfo } from "../lib/session"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      SessionAgents.node,
      SessionAgentsMd.node,
      SessionMcps.node,
      SessionSkills.node,
      SessionTools.node,
    ]),
    [Location.node.replace(Location.boundNode({ directory: AbsolutePath.make("/project") }))],
  ),
)
const pgTest = process.env.OPENCODE_DATABASE_URL ? it.effect : it.effect.skip

pgTest("six resource services share the root owner without copying child rows or crossing history forks", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const { session: template, created } = yield* ensureSession(db)
    const root = Session.ID.create()
    const child = Session.ID.create()
    const nested = Session.ID.create()
    const fork = Session.ID.create()
    const ids = [root, child, nested, fork]
    try {
      for (const [id, parentID, forkID] of [
        [root, null, null],
        [child, root, null],
        [nested, child, null],
        [fork, root, root],
      ] as const) {
        yield* db
          .insert(SessionTable)
          .values({
            ...template,
            id,
            slug: id,
            parent_id: parentID,
            fork_session_id: forkID,
            fork_boundary: null,
            title: `resource-owner-${id}`,
          })
          .run()
      }
      const info = (id: Session.ID) => sessionInfo({ ...template, id })
      const agents = yield* SessionAgents.Service
      const md = yield* SessionAgentsMd.Service
      const mcps = yield* SessionMcps.Service
      const skills = yield* SessionSkills.Service
      const tools = yield* SessionTools.Service
      const agentID = Agent.ID.make("owner-agent")
      const skillID = Skill.ID.make("owner-skill")
      const mcpName = SessionMcp.Name.make("owner-mcp")
      const toolName = SessionTool.Name.make("owner-tool")
      const write = (id: Session.ID, value: string) =>
        Effect.gen(function* () {
          yield* agents.create(id, { id: agentID, config: ConfigAgent.Info.make({ system: value }) })
          yield* md.put(id, value)
          yield* mcps.create(id, {
            name: mcpName,
            config: SessionMcp.RemoteConfig.make({
              type: "remote",
              url: `http://127.0.0.1/${value}`,
              oauth: false,
              disabled: true,
            }),
          })
          yield* skills.create(id, { id: skillID, description: value, content: value })
          yield* tools.create(id, {
            name: toolName,
            description: value,
            code: `export default {description:${JSON.stringify(value)},args:{},execute(){return ${JSON.stringify(value)}}}`,
          })
          yield* SessionCommands.create(id, { name: "owner-command", template: value })
        })
      const read = (id: Session.ID, value: string) =>
        Effect.gen(function* () {
          expect((yield* agents.get(info(id), agentID))?.agent.system).toBe(value)
          expect((yield* md.get(id))?.content).toBe(value)
          const config = (yield* mcps.list(id))[0]?.config
          expect(config?.type).toBe("remote")
          expect(config?.type === "remote" ? config.url : undefined).toBe(`http://127.0.0.1/${value}`)
          expect((yield* skills.get(info(id), skillID))?.skill.content).toBe(value)
          expect((yield* tools.list(id))[0]?.description).toBe(value)
          const ownerID = yield* SessionResourceOwner.id(db, id)
          expect(
            (yield* db.select().from(SessionCommandTable).where(eq(SessionCommandTable.session_id, ownerID)).get())
              ?.template,
          ).toBe(value)
        })
      yield* write(child, "first")
      for (const id of [root, child, nested]) yield* read(id, "first")
      yield* write(root, "updated")
      yield* read(nested, "updated")
      yield* write(nested, "nested-update")
      yield* read(root, "nested-update")
      yield* write(fork, "fork-private")
      yield* read(fork, "fork-private")
      yield* read(child, "nested-update")

      for (const table of [
        SessionAgentTable,
        SessionAgentsMdTable,
        SessionCommandTable,
        SessionMcpTable,
        SessionSkillTable,
        SessionToolTable,
      ]) {
        const rows = yield* db
          .select({ owner: table.session_id })
          .from(table)
          .where(inArray(table.session_id, ids))
          .all()
        expect(rows.map((row) => row.owner).sort()).toEqual([root, fork].sort())
      }
      yield* db.delete(SessionTable).where(eq(SessionTable.id, nested)).run()
      yield* read(root, "nested-update")
      yield* agents.remove(child, agentID)
      yield* md.remove(child)
      yield* mcps.remove(info(child), mcpName)
      yield* skills.remove(child, skillID)
      yield* tools.remove(child, toolName)
      yield* SessionCommands.remove(child, "owner-command")
      expect(yield* md.get(root)).toBeNull()
      expect(yield* tools.list(root)).toEqual([])
      yield* read(fork, "fork-private")

      yield* write(child, "clear-check")
      yield* agents.clear(child)
      yield* md.remove(child)
      yield* mcps.clear(info(child))
      yield* skills.clear(child)
      yield* tools.clear(child)
      yield* SessionCommands.clear(child)
      for (const table of [
        SessionAgentTable,
        SessionAgentsMdTable,
        SessionCommandTable,
        SessionMcpTable,
        SessionSkillTable,
        SessionToolTable,
      ]) {
        expect(
          yield* db.select({ owner: table.session_id }).from(table).where(eq(table.session_id, root)).all(),
        ).toEqual([])
      }
      yield* read(fork, "fork-private")
    } finally {
      yield* db.delete(SessionTable).where(inArray(SessionTable.id, ids)).run()
      yield* removeIfCreated(db, template, created)
    }
  }),
)
