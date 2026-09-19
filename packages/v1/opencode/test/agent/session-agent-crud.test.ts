import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Agent } from "../../src/agent/agent"
import { Skill } from "../../src/skill"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Plugin } from "../../src/plugin"
import { Provider } from "../../src/provider/provider"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Global } from "@opencode-ai/core/global"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Bus } from "../../src/bus"
import { Discovery } from "../../src/skill/discovery"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionAgent } from "../../src/agent/session-agent"
import { SessionID } from "../../src/session/schema"
import { locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { testEffect } from "../lib/effect"

const memoryLayer = Layer.effect(
  SessionAgent.Service,
  Effect.gen(function* () {
    const store = new Map<string, SessionAgent.Row[]>()
    let nextId = 1
    return SessionAgent.Service.of({
      list: (sessionID) => Effect.succeed(store.get(sessionID) ?? []),
      get: (sessionID, name) =>
        Effect.succeed((store.get(sessionID) ?? []).find((r) => r.name === name)),
      upsert: (sessionID, input) =>
        Effect.sync(() => {
          const rows = [...(store.get(sessionID) ?? [])]
          const idx = rows.findIndex((r) => r.name === input.name)
          const row: SessionAgent.Row = {
            id: `mem-${nextId++}`,
            session_id: sessionID as string,
            name: input.name,
            description: input.description ?? null,
            mode: input.mode ?? "all",
            prompt: input.prompt ?? null,
            permission: input.permission ? [...input.permission] : [],
            model: input.model ?? null,
            temperature: input.temperature ?? null,
            top_p: input.topP ?? null,
            steps: input.steps ?? null,
            color: input.color ?? null,
            variant: input.variant ?? null,
            options: input.options ?? {},
            time_created: Date.now(),
            time_updated: Date.now(),
          }
          if (idx >= 0) rows[idx] = row
          else rows.push(row)
          store.set(sessionID, rows)
          return row
        }),
      remove: (sessionID, name) =>
        Effect.sync(() => {
          const rows = (store.get(sessionID) ?? []).filter((r) => r.name !== name)
          store.set(sessionID, rows)
        }),
      removeAll: (sessionID) =>
        Effect.sync(() => {
          store.set(sessionID, [])
        }),
    })
  }),
)

const agentLayer = Agent.defaultLayer.pipe(
  Layer.provide(LayerNode.compile(Plugin.node)),
  Layer.provide(LayerNode.compile(Provider.node)),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(LayerNode.compile(Config.node)),
  Layer.provide(Skill.defaultLayer),
  Layer.provide(RuntimeFlags.layer({})),
  Layer.provide(memoryLayer),
  Layer.provide(locationServiceMapLayer),
)

const it = testEffect(Layer.mergeAll(agentLayer, LayerNode.compile(CrossSpawnSpawner.node)))

const SESSION = SessionID.make("ses_test_agent_001")

describe("Agent sessionList", () => {
  it.instance("returns default agents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const list = yield* agent.sessionList(SESSION)
      const names = list.map((a) => a.name)
      expect(names).toContain("build")
      expect(names).toContain("plan")
      expect(names).toContain("explore")
    }),
  )
})

describe("Agent sessionCreate", () => {
  it.instance("creates a custom agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      const info = yield* agent.sessionCreate(SESSION, {
        name: "custom-agent",
        description: "Custom test agent",
        mode: "primary",
        prompt: "Test prompt",
      })
      expect(info.name).toBe("custom-agent")
      expect(info.description).toBe("Custom test agent")
      expect(info.mode).toBe("primary")
    }),
  )

  it.instance("created agent appears in sessionList", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.sessionCreate(SESSION, {
        name: "list-test",
        description: "List test",
        mode: "subagent",
      })
      const list = yield* agent.sessionList(SESSION)
      const names = list.map((a) => a.name)
      expect(names).toContain("list-test")
    }),
  )

  it.instance("upserts existing agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.sessionCreate(SESSION, {
        name: "upsert-agent",
        description: "v1",
        mode: "primary",
      })
      yield* agent.sessionCreate(SESSION, {
        name: "upsert-agent",
        description: "v2",
        mode: "subagent",
      })
      const list = yield* agent.sessionList(SESSION)
      const found = list.find((a) => a.name === "upsert-agent")
      expect(found).toBeDefined()
      expect(found!.description).toBe("v2")
      expect(found!.mode).toBe("subagent")
      expect(list.filter((a) => a.name === "upsert-agent")).toHaveLength(1)
    }),
  )

  it.instance("session agents are isolated between sessions", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.sessionCreate(SessionID.make("session-x"), {
        name: "only-x",
        description: "X",
        mode: "primary",
      })
      yield* agent.sessionCreate(SessionID.make("session-y"), {
        name: "only-y",
        description: "Y",
        mode: "primary",
      })
      const x = yield* agent.sessionList(SessionID.make("session-x"))
      const y = yield* agent.sessionList(SessionID.make("session-y"))
      expect(x.map((a) => a.name)).toContain("only-x")
      expect(x.map((a) => a.name)).not.toContain("only-y")
      expect(y.map((a) => a.name)).toContain("only-y")
      expect(y.map((a) => a.name)).not.toContain("only-x")
    }),
  )
})

describe("Agent sessionUnload", () => {
  it.instance("removes a custom agent", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.sessionCreate(SESSION, {
        name: "to-remove",
        description: "Remove",
        mode: "primary",
      })
      yield* agent.sessionUnload(SESSION, "to-remove")
      const list = yield* agent.sessionList(SESSION)
      expect(list.find((a) => a.name === "to-remove")).toBeUndefined()
    }),
  )

  it.instance("does not remove default agents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.sessionUnload(SESSION, "build")
      const list = yield* agent.sessionList(SESSION)
      expect(list.find((a) => a.name === "build")).toBeDefined()
    }),
  )
})

describe("Agent sessionClear", () => {
  it.instance("removes all custom agents", () =>
    Effect.gen(function* () {
      const agent = yield* Agent.Service
      yield* agent.sessionCreate(SESSION, {
        name: "clear-a",
        description: "A",
        mode: "primary",
      })
      yield* agent.sessionCreate(SESSION, {
        name: "clear-b",
        description: "B",
        mode: "subagent",
      })
      yield* agent.sessionClear(SESSION)
      const list = yield* agent.sessionList(SESSION)
      const defaults = ["build", "plan", "explore", "compaction", "summary", "title", "scout", "general"]
      const custom = list.filter((a) => !defaults.includes(a.name))
      expect(custom).toHaveLength(0)
    }),
  )
})

describe("Agent.CreateInput schema", () => {
  test("make creates valid object", () => {
    const input = Agent.CreateInput.make({
      name: "test-agent",
      mode: "primary",
    })
    expect(input.name).toBe("test-agent")
    expect(input.mode).toBe("primary")
  })

  test("make with all fields", () => {
    const input = Agent.CreateInput.make({
      name: "full-agent",
      description: "Full",
      mode: "subagent",
      prompt: "Custom prompt",
      temperature: 0.7,
      topP: 0.9,
      steps: 5,
      color: "#FF0000",
      variant: "fast",
    })
    expect(input.name).toBe("full-agent")
    expect(input.temperature).toBe(0.7)
    expect(input.steps).toBe(5)
  })
})
