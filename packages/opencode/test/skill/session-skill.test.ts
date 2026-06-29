import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { Discovery } from "../../src/skill/discovery"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config/config"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Global } from "@opencode-ai/core/global"
import { testEffect } from "../lib/effect"

const testLayer = Layer.mergeAll(
  Skill.layer.pipe(
    Layer.provide(Discovery.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(FileSystem.defaultLayer),
    Layer.provide(Global.layer),
    Layer.provide(RuntimeFlags.layer({})),
  ),
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(testLayer)

const SESSION = "ses_test_001"

describe("Skill session CRUD", () => {
  it.instance("sessionList returns empty for new session", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const list = yield* skill.sessionList(SESSION)
      expect(list).toEqual([])
    }),
  )

  it.instance("sessionCreate creates a skill", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const info = yield* skill.sessionCreate(SESSION, {
        name: "reviewer",
        description: "Code review",
        content: "Review code for bugs",
      })
      expect(info.name).toBe("reviewer")
      expect(info.description).toBe("Code review")
      expect(info.content).toBe("Review code for bugs")
      expect(info.location).toBe("memory://reviewer")
    }),
  )

  it.instance("sessionCreate with resources", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      const info = yield* skill.sessionCreate(SESSION, {
        name: "security",
        description: "Security audit",
        content: "Audit security",
        resources: [
          { path: "refs/checklist.md", type: "doc", content: "OWASP Top 10" },
          { path: "tpl/safe.py", type: "template", content: "cursor.execute(q, params)" },
        ],
      })
      expect(info.resources).toHaveLength(2)
      expect(info.resources![0].path).toBe("refs/checklist.md")
      expect(info.resources![1].type).toBe("template")
    }),
  )

  it.instance("sessionList returns created skills", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "skill-a",
        description: "A",
        content: "a",
      })
      yield* skill.sessionCreate(SESSION, {
        name: "skill-b",
        description: "B",
        content: "b",
      })
      const list = yield* skill.sessionList(SESSION)
      const names = list.map((s) => s.name)
      expect(names).toContain("skill-a")
      expect(names).toContain("skill-b")
      expect(list).toHaveLength(2)
    }),
  )

  it.instance("sessionCreate upserts existing skill", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "upsert-test",
        description: "v1",
        content: "v1",
      })
      yield* skill.sessionCreate(SESSION, {
        name: "upsert-test",
        description: "v2",
        content: "v2",
      })
      const list = yield* skill.sessionList(SESSION)
      const found = list.find((s) => s.name === "upsert-test")
      expect(found).toBeDefined()
      expect(found!.description).toBe("v2")
      expect(found!.content).toBe("v2")
      expect(list.filter((s) => s.name === "upsert-test")).toHaveLength(1)
    }),
  )

  it.instance("sessions are isolated", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate("session-1", {
        name: "only-in-s1",
        description: "S1",
        content: "s1",
      })
      yield* skill.sessionCreate("session-2", {
        name: "only-in-s2",
        description: "S2",
        content: "s2",
      })
      const s1 = yield* skill.sessionList("session-1")
      const s2 = yield* skill.sessionList("session-2")
      expect(s1.map((s) => s.name)).toContain("only-in-s1")
      expect(s1.map((s) => s.name)).not.toContain("only-in-s2")
      expect(s2.map((s) => s.name)).toContain("only-in-s2")
      expect(s2.map((s) => s.name)).not.toContain("only-in-s1")
    }),
  )

  it.instance("sessionUnload removes a skill", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "to-remove",
        description: "Remove me",
        content: "x",
      })
      yield* skill.sessionUnload(SESSION, "to-remove")
      const list = yield* skill.sessionList(SESSION)
      expect(list.find((s) => s.name === "to-remove")).toBeUndefined()
    }),
  )

  it.instance("sessionUnload on non-existent skill is no-op", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionUnload(SESSION, "does-not-exist")
    }),
  )

  it.instance("sessionUnload on non-existent session is no-op", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionUnload("non-existent-session", "whatever")
    }),
  )

  it.instance("sessionClear removes all session skills", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "clear-a",
        description: "A",
        content: "a",
      })
      yield* skill.sessionCreate(SESSION, {
        name: "clear-b",
        description: "B",
        content: "b",
      })
      yield* skill.sessionClear(SESSION)
      const list = yield* skill.sessionList(SESSION)
      expect(list).toEqual([])
    }),
  )

  it.instance("sessionClear does not affect other sessions", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate("keep-session", {
        name: "keep-skill",
        description: "Keep",
        content: "keep",
      })
      yield* skill.sessionCreate("clear-session", {
        name: "clear-skill",
        description: "Clear",
        content: "clear",
      })
      yield* skill.sessionClear("clear-session")
      const keep = yield* skill.sessionList("keep-session")
      expect(keep.map((s) => s.name)).toContain("keep-skill")
    }),
  )
})

describe("Skill.CreateInput schema", () => {
  test("parses minimal input", () => {
    const parsed = Skill.CreateInput.make({
      name: "my-skill",
      content: "Do something",
    })
    expect(parsed.name).toBe("my-skill")
    expect(parsed.content).toBe("Do something")
  })

  test("parses full input with resources", () => {
    const parsed = Skill.CreateInput.make({
      name: "full",
      description: "Full skill",
      content: "Content",
      resources: [
        { path: "a.md", type: "doc", content: "doc content" },
        { path: "b.py", type: "template", content: "template content" },
      ],
    })
    expect(parsed.name).toBe("full")
    expect(parsed.description).toBe("Full skill")
    expect(parsed.resources).toHaveLength(2)
  })
})

describe("Skill.available merges session skills", () => {
  it.instance("available returns global skills only without session", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "session-only",
        description: "Session",
        content: "session",
      })
      const agent = { name: "build", mode: "primary" as const, permission: [] as never[], options: {} }
      const without = yield* skill.available(agent)
      expect(without.find((s) => s.name === "session-only")).toBeUndefined()
    }),
  )

  it.instance("available returns global + session skills with session param", () =>
    Effect.gen(function* () {
      const skill = yield* Skill.Service
      yield* skill.sessionCreate(SESSION, {
        name: "merged-skill",
        description: "Merged",
        content: "merged",
      })
      const agent = { name: "build", mode: "primary" as const, permission: [] as never[], options: {} }
      const withSession = yield* skill.available(agent, SESSION)
      const names = withSession.map((s) => s.name)
      expect(names).toContain("merged-skill")
    }),
  )
})
