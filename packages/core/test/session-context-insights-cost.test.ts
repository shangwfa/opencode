import { describe, expect } from "bun:test"
import { LLM, Message } from "@opencode/ai"
import * as OpenAI from "@opencode/ai/providers/openai"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { Bus } from "../src/bus"
import { Database } from "../src/database/database"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { ProjectTable } from "../src/project/sql"
import { AbsolutePath } from "../src/schema"
import { SessionContextInsights } from "../src/session/context-insights"
import { SessionTable } from "../src/session/sql"
import { it } from "./lib/effect"

const describePg = process.env.OPENCODE_DATABASE_URL ? describe : describe.skip

describePg("context insights capture cost", () => {
  it.live(
    "measures per-call capture latency",
    () =>
      Effect.gen(function* () {
        const layer = yield* Layer.build(
          Layer.fresh(AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionContextInsights.node]), [
            Bus.node.replace(Bus.configured({ persist: true })),
          ])),
        )
        const service = Context.get(layer, SessionContextInsights.Service)
        const { db } = Context.get(layer, Database.Service)
        const bus = Context.get(layer, Bus.Service)
        const sessionID = Session.ID.create()
        yield* db.insert(ProjectTable)
          .values({ id: Project.ID.global, worktree: AbsolutePath.make("/workspace"), sandboxes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        yield* db.insert(SessionTable)
          .values({ id: sessionID, project_id: Project.ID.global, slug: "capture-cost", directory: "/workspace", version: "test" })
          .run()
          .pipe(Effect.orDie)
        yield* Effect.addFinalizer(() =>
          db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie, Effect.andThen(bus.remove(sessionID))),
        )
        const model = OpenAI.configure({ apiKey: "test" }).chat("test")
        const input = {
          sessionID,
          kind: "primary" as const,
          agent: Agent.ID.make("build"),
          model: Model.Ref.make({ id: Model.ID.make("test"), providerID: Provider.ID.make("openai") }),
          contextWindow: 200_000,
          outputReserve: 32_000,
          request: LLM.request({
            model,
            system: "system",
            messages: [Message.user("hi")],
            tools: [{ name: "read", description: "read", inputSchema: {} }],
          }),
        }
        // warm-up (first call opens connections / prepares statements)
        yield* service.capture(input)
        const rounds = 50
        const started = performance.now()
        yield* Effect.forEach(Array.from({ length: rounds }, () => 0), () => service.capture(input), { discard: true })
        const perCall = (performance.now() - started) / rounds
        console.log(`capture per call: ${perCall.toFixed(2)}ms (n=${rounds})`)
        expect(perCall).toBeLessThan(200)
      }),
    120_000,
  )
})
