import { beforeAll, afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Database, eq } from "../../src/storage/db"
import { Bus } from "../../src/bus"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { Session } from "../../src/session/session"
import { SessionAgent } from "../../src/agent/session-agent"
import { SessionAgentTable } from "../../src/agent/agent.pg"
import type { SessionID } from "../../src/session/schema"
import { tmpdir } from "../fixture/fixture"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { ModelV2 } from "@opencode-ai/core/model"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"

const DB_URL = process.env.OPENCODE_DATABASE_URL
if (!DB_URL) {
  console.log("skip session-agent PG tests: OPENCODE_DATABASE_URL not set")
  process.exit(0)
}

const runtime = ManagedRuntime.make(Layer.mergeAll(SessionAgent.layer, LayerNode.compile(Session.node), Bus.layer) as any)
const db = Database.Client()

async function cleanup(sessionID: string) {
  await db.delete(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).run()
}

function run<A>(effect: Effect.Effect<A, unknown, SessionAgent.Service | Session.Service | Bus.Service>) {
  return runtime.runPromise(effect)
}

describe("SessionAgent PG", () => {
  const sessions: { [key: string]: SessionID } = {}

  beforeAll(async () => {
    await Database.initialize()
  })

  afterEach(async () => {
    for (const id of Object.keys(sessions)) {
      await cleanup(id)
      await run(Session.Service.use((svc) => svc.remove(sessions[id]))).catch(() => undefined)
      delete sessions[id]
    }
  })

  async function make() {
    const tmp = await tmpdir({ git: true })
    const session = await provideTestInstance({
      directory: tmp.path,
      fn: () => run(Session.Service.use((svc) => svc.create({ title: "session agent test" }))),
    })
    sessions[session.id] = session.id
    return { session, tmp }
  }

  test("upsert inserts and can be read back via get/list", async () => {
    const { session } = await make()
    const agent = await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, {
          name: "custom-agent",
          description: "A custom agent",
          prompt: "You are a custom agent",
        }),
      ),
    )

    expect(agent.session_id).toBe(session.id)
    expect(agent.name).toBe("custom-agent")
    expect(agent.mode).toBe("all")

    const got = await run(SessionAgent.Service.use((svc) => svc.get(session.id, "custom-agent")))
    expect(got!.prompt).toBe("You are a custom agent")

    const list = await run(SessionAgent.Service.use((svc) => svc.list(session.id)))
    expect(list.map((item) => item.name)).toEqual(["custom-agent"])
  })

  test("upsert with all fields", async () => {
    const { session } = await make()
    const agent = await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, {
          name: "full-agent",
          description: "Full config agent",
          mode: "subagent",
          prompt: "Custom prompt",
          permission: [
            { permission: "bash", pattern: "*", action: "deny" },
            { permission: "read", pattern: "*", action: "allow" },
          ],
          model: { providerID: ProviderV2.ID.make("openai"), modelID: ModelV2.ID.make("gpt-4") },
          temperature: 0.7,
          topP: 0.9,
          steps: 20,
          color: "#FF0000",
          variant: "reasoning",
          options: { custom_flag: true },
        }),
      ),
    )

    expect(agent.mode).toBe("subagent")
    expect(agent.prompt).toBe("Custom prompt")
    expect(agent.permission!.length).toBe(2)
    expect(agent.model).toEqual({ providerID: "openai", modelID: "gpt-4" })
    expect(agent.temperature).toBe(0.7)
    expect(agent.top_p).toBe(0.9)
    expect(agent.steps).toBe(20)
    expect(agent.color).toBe("#FF0000")
    expect(agent.variant).toBe("reasoning")
    expect(agent.options).toEqual({ custom_flag: true })
  })

  test("upsert same name updates existing", async () => {
    const { session } = await make()
    await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, { name: "alpha", description: "old", prompt: "old prompt" }),
      ),
    )
    const updated = await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, { name: "alpha", description: "new", prompt: "new prompt" }),
      ),
    )

    expect(updated.description).toBe("new")
    expect(updated.prompt).toBe("new prompt")
    const list = await run(SessionAgent.Service.use((svc) => svc.list(session.id)))
    expect(list.length).toBe(1)
  })

  test("upsert replaces omitted optional fields", async () => {
    const { session } = await make()
    await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, {
          name: "replace-agent",
          description: "old",
          prompt: "old prompt",
          permission: [{ permission: "bash", pattern: "*", action: "allow" }],
          options: { old: true },
        }),
      ),
    )
    const updated = await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, { name: "replace-agent", description: "new" }),
      ),
    )

    expect(updated.description).toBe("new")
    expect(updated.prompt).toBeNull()
    expect(updated.permission).toEqual([])
    expect(updated.options).toEqual({})
  })

  test("different sessions are isolated", async () => {
    const a = await make()
    const b = await make()
    await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(a.session.id, { name: "shared", description: "A", prompt: "A" }),
      ),
    )
    await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(b.session.id, { name: "shared", description: "B", prompt: "B" }),
      ),
    )

    const gotA = await run(SessionAgent.Service.use((svc) => svc.get(a.session.id, "shared")))
    expect(gotA!.description).toBe("A")
    const gotB = await run(SessionAgent.Service.use((svc) => svc.get(b.session.id, "shared")))
    expect(gotB!.description).toBe("B")
  })

  test("remove and removeAll clean up session agents", async () => {
    const { session } = await make()
    await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, { name: "alpha", description: "A", prompt: "A" }),
      ),
    )
    await run(
      SessionAgent.Service.use((svc) =>
        svc.upsert(session.id, { name: "beta", description: "B", prompt: "B" }),
      ),
    )

    await run(SessionAgent.Service.use((svc) => svc.remove(session.id, "alpha")))
    expect(await run(SessionAgent.Service.use((svc) => svc.get(session.id, "alpha")))).toBeUndefined()
    expect((await run(SessionAgent.Service.use((svc) => svc.list(session.id)))).length).toBe(1)

    await run(SessionAgent.Service.use((svc) => svc.removeAll(session.id)))
    expect(await run(SessionAgent.Service.use((svc) => svc.list(session.id)))).toEqual([])
  })

  test("get returns undefined for non-existent agent", async () => {
    const { session } = await make()
    const got = await run(SessionAgent.Service.use((svc) => svc.get(session.id, "nonexistent")))
    expect(got).toBeUndefined()
  })

  test("cascade delete when session is removed", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await run(
          Session.Service.use((svc) => svc.create({ title: "cascade test" })),
        )
        await run(
          SessionAgent.Service.use((svc) =>
            svc.upsert(session.id, { name: "cascade", description: "Cascade", prompt: "cascade" }),
          ),
        )
        expect((await run(SessionAgent.Service.use((svc) => svc.list(session.id)))).length).toBe(1)

        await run(Session.Service.use((svc) => svc.remove(session.id)))
        expect(await run(SessionAgent.Service.use((svc) => svc.list(session.id)))).toEqual([])
      },
    })
  })
})
