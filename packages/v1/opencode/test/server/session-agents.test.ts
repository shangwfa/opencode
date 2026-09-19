import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { provideTestInstance, disposeAllInstances } from "../fixture/fixture"
import { Server } from "../../src/server/server"
import { Session as SessionNs } from "../../src/session/session"
import type { SessionID } from "../../src/session/schema"
import type { Agent as AgentType } from "../../src/agent/agent"
import { Log } from "@opencode-ai/core/util/log"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "../../src/storage/db"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const url = process.env["OPENCODE_DATABASE_URL"]
const enabled = !!url && Database.dialect === "pg"

if (!enabled) {
  console.log("skip: OPENCODE_DATABASE_URL not set or not PG mode")
  process.exit(0)
}

function run<A, E>(fx: Effect.Effect<A, E, SessionNs.Service>) {
  return Effect.runPromise(fx.pipe(Effect.provide(LayerNode.compile(SessionNs.node))))
}

const svc = {
  create(input?: SessionNs.CreateInput) {
    return run(SessionNs.Service.use((s) => s.create(input)))
  },
  remove(id: SessionID) {
    return run(SessionNs.Service.use((s) => s.remove(id)))
  },
}

afterEach(async () => {
  await disposeAllInstances()
})

describe("session agents routes (PG)", () => {
  test("create, list, unload and clear session agents", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "agent-routes-test" })
        const app = Server.Default().app

        // create
        const created = await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "test-agent",
            description: "Test agent for route verification",
            mode: "primary",
            prompt: "You are a test agent.",
            temperature: 0.7,
            steps: 10,
            permission: [
              { permission: "bash", pattern: "*", action: "allow" },
              { permission: "edit", pattern: "*", action: "deny" },
            ],
          }),
        })
        expect(created.status).toBe(200)
        const json = (await created.json()) as AgentType.Info
        expect(json.name).toBe("test-agent")
        expect(json.mode).toBe("primary")
        expect(json.temperature).toBe(0.7)
        expect(json.steps).toBe(10)

        // list
        const listed = await app.request(`/session/${session.id}/agents`)
        expect(listed.status).toBe(200)
        const items = (await listed.json()) as AgentType.Info[]
        const names = items.map((a) => a.name)
        expect(names).toContain("test-agent")

        // unload single
        const unloaded = await app.request(`/session/${session.id}/agents/test-agent`, { method: "DELETE" })
        expect(unloaded.status).toBe(204)

        const empty = await app.request(`/session/${session.id}/agents`)
        const emptyNames = ((await empty.json()) as AgentType.Info[]).map((a) => a.name)
        expect(emptyNames).not.toContain("test-agent")

        // create two then clear all
        await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "a1", description: "A1", prompt: "p1" }),
        })
        await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "a2", description: "A2", prompt: "p2" }),
        })
        const cleared = await app.request(`/session/${session.id}/agents`, { method: "DELETE" })
        expect(cleared.status).toBe(204)

        const after = await app.request(`/session/${session.id}/agents`)
        const afterNames = ((await after.json()) as AgentType.Info[]).map((a) => a.name)
        expect(afterNames).not.toContain("a1")
        expect(afterNames).not.toContain("a2")

        await svc.remove(session.id)
      },
    })
  })

  test("upsert updates existing agent", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "upsert-test" })
        const app = Server.Default().app

        await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "upsert-agent", description: "v1", prompt: "prompt v1" }),
        })

        const updated = await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "upsert-agent", description: "v2", prompt: "prompt v2", mode: "subagent" }),
        })
        expect(updated.status).toBe(200)
        const json = (await updated.json()) as AgentType.Info
        expect(json.description).toBe("v2")
        expect(json.mode).toBe("subagent")

        const listed = await app.request(`/session/${session.id}/agents`)
        const items = (await listed.json()) as AgentType.Info[]
        expect(items.filter((a) => a.name === "upsert-agent").length).toBe(1)

        await svc.remove(session.id)
      },
    })
  })

  test("different sessions are isolated", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const sA = await svc.create({ title: "iso-A" })
        const sB = await svc.create({ title: "iso-B" })
        const app = Server.Default().app

        await app.request(`/session/${sA.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "shared", description: "From A", prompt: "A" }),
        })
        await app.request(`/session/${sB.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "shared", description: "From B", prompt: "B" }),
        })

        const listA = (await (await app.request(`/session/${sA.id}/agents`)).json()) as AgentType.Info[]
        const listB = (await (await app.request(`/session/${sB.id}/agents`)).json()) as AgentType.Info[]

        expect(listA.find((a) => a.name === "shared")?.description).toBe("From A")
        expect(listB.find((a) => a.name === "shared")?.description).toBe("From B")

        await svc.remove(sA.id)
        await svc.remove(sB.id)
      },
    })
  })

  test("returns 404 for missing session", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const app = Server.Default().app
        const res = await app.request("/session/ses_missing/agents/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "ghost", description: "Ghost", prompt: "ghost" }),
        })
        expect(res.status).toBe(404)
      },
    })
  })

  test("cascade delete when session is removed", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "cascade-test" })
        const app = Server.Default().app

        await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "cascade-agent", description: "Will be cascaded", prompt: "cascade" }),
        })

        const before = (await (await app.request(`/session/${session.id}/agents`)).json()) as AgentType.Info[]
        expect(before.map((a) => a.name)).toContain("cascade-agent")

        await svc.remove(session.id)

        const after = await app.request(`/session/${session.id}/agents`)
        expect(after.status).toBe(404)
      },
    })
  })

  test("agent with full config persists all fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "full-config" })
        const app = Server.Default().app

        const created = await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "full-agent",
            description: "Fully configured agent",
            mode: "subagent",
            prompt: "Custom prompt for full agent",
            permission: [
              { permission: "bash", pattern: "*", action: "deny" },
              { permission: "read", pattern: "*", action: "allow" },
            ],
            temperature: 0.5,
            topP: 0.8,
            steps: 15,
            color: "#FF5733",
            variant: "fast",
            options: { custom_flag: true },
          }),
        })
        expect(created.status).toBe(200)
        const agent = (await created.json()) as AgentType.Info

        expect(agent.name).toBe("full-agent")
        expect(agent.mode).toBe("subagent")
        expect(agent.prompt).toBe("Custom prompt for full agent")
        expect(agent.temperature).toBe(0.5)
        expect(agent.topP).toBe(0.8)
        expect(agent.steps).toBe(15)
        expect(agent.color).toBe("#FF5733")
        expect(agent.variant).toBe("fast")
        expect(agent.options).toEqual({ custom_flag: true })
        expect(agent.permission.length).toBe(2)

        // verify persistence via list
        const listed = (await (await app.request(`/session/${session.id}/agents`)).json()) as AgentType.Info[]
        const found = listed.find((a) => a.name === "full-agent")
        expect(found?.steps).toBe(15)
        expect(found?.prompt).toBe("Custom prompt for full agent")

        await svc.remove(session.id)
      },
    })
  })

  test("rejects invalid agent names", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "invalid-name" })
        const app = Server.Default().app

        for (const name of ["", " ", "1bad", "bad/name", "bad name"]) {
          const res = await app.request(`/session/${session.id}/agents/create`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, prompt: "bad" }),
          })
          expect(res.status).toBe(400)
        }

        await svc.remove(session.id)
      },
    })
  })

  test("session agent override preserves native metadata", async () => {
    await using tmp = await tmpdir({ git: true })
    await provideTestInstance({
      directory: tmp.path,
      fn: async () => {
        const session = await svc.create({ title: "native-override" })
        const app = Server.Default().app

        const created = await app.request(`/session/${session.id}/agents/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: "build", description: "Session build", prompt: "override" }),
        })
        const agent = (await created.json()) as AgentType.Info
        expect(agent.native).toBe(true)

        const listed = (await (await app.request(`/session/${session.id}/agents`)).json()) as AgentType.Info[]
        expect(listed.find((item) => item.name === "build")?.native).toBe(true)

        await svc.remove(session.id)
      },
    })
  })
})
