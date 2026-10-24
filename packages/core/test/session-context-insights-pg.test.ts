import { describe, expect } from "bun:test"
import { LLM, Message } from "@opencode/ai"
import * as OpenAI from "@opencode/ai/providers/openai"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "@opencode/schema/agent"
import { Mcp } from "@opencode/schema/mcp"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { SessionMcp } from "@opencode/schema/session-mcp"
import { SessionTool } from "@opencode/schema/session-tool"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionContextInsights } from "../src/session/context-insights"
import { SessionContextContentTable, SessionMcpTable, SessionTable, SessionToolTable } from "../src/session/sql"
import { it } from "./lib/effect"

const describePg = process.env.OPENCODE_DATABASE_URL ? describe : describe.skip
const nodes = () =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionContextInsights.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ])

describePg("context insights PostgreSQL multi-instance", () => {
  it.live(
    "independent instances concurrently capture, read, and deduplicate using PG only",
    () =>
      Effect.gen(function* () {
        const url = process.env.OPENCODE_DATABASE_URL
        if (!url || new URL(url).pathname !== "/opencode-v2-test")
          throw new Error("必须使用专用 opencode-v2-test 数据库")
        const a = yield* Layer.build(Layer.fresh(nodes()))
        const b = yield* Layer.build(Layer.fresh(nodes()))
        const serviceA = Context.get(a, SessionContextInsights.Service)
        const serviceB = Context.get(b, SessionContextInsights.Service)
        const { db } = Context.get(a, Database.Service)
        const bus = Context.get(a, Bus.Service)
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
            slug: "context-multi-instance",
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
        const model = OpenAI.configure({ apiKey: "test" }).chat("test")
        yield* db
          .insert(SessionMcpTable)
          .values({
            id: SessionMcp.ID.create(),
            session_id: sessionID,
            name: SessionMcp.Name.make("docs"),
            config: Mcp.LocalConfig.make({ type: "local", command: ["true"], disabled: true }),
          })
          .run()
          .pipe(Effect.orDie)
        yield* db
          .insert(SessionToolTable)
          .values({
            id: SessionTool.ID.create(),
            session_id: sessionID,
            name: SessionTool.Name.make("deploy"),
            description: "deploy",
            code: "export default () => 1",
          })
          .run()
          .pipe(Effect.orDie)
        const input = {
          sessionID,
          kind: "primary" as const,
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("openai") }),
          request: LLM.request({
            model,
            system: "shared system",
            messages: [Message.user("shared user")],
            tools: [
              { name: "docs_search", description: "search docs", inputSchema: {} },
              { name: "deploy", description: "deploy", inputSchema: {} },
              { name: "read", description: "read file", inputSchema: {} },
            ],
          }),
        }
        const captured = yield* Effect.forEach(
          Array.from({ length: 12 }, (_, i) => i),
          (i) => (i % 2 ? serviceA : serviceB).capture(input),
          { concurrency: "unbounded" },
        )
        expect(new Set(captured.map((request) => request.id)).size).toBe(12)
        expect((yield* serviceB.summary(sessionID)).capturedRequests).toBe(12)
        const first = captured[0]
        if (!first) throw new Error("Missing captured request")
        expect((yield* serviceB.content(sessionID, first.id, 0)).content).toBe("shared system")
        const detail = yield* serviceB.detail(sessionID, first.id)
        expect(
          detail.items.filter((item) => item.category === "tools").map((item) => [item.name, item.source]),
        ).toEqual([
          ["docs_search", "mcp:docs"],
          ["deploy", "session"],
          ["read", undefined],
        ])
        const contents = yield* db
          .select()
          .from(SessionContextContentTable)
          .where(eq(SessionContextContentTable.session_id, sessionID))
          .all()
          .pipe(Effect.orDie)
        expect(contents).toHaveLength(5)
        const page = yield* serviceB.list(sessionID, { limit: 5 })
        const next = yield* serviceA.list(sessionID, { before: page.next, limit: 100 })
        expect(page.data).toHaveLength(5)
        expect(next.data).toHaveLength(7)
        expect(new Set([...page.data, ...next.data].map((request) => request.id)).size).toBe(12)
      }),
    60_000,
  )
})
