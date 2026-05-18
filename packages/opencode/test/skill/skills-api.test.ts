import { describe, expect, test } from "bun:test"
import z from "zod"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))

// Replicate the REST endpoint zod schemas (they are inlined in server routes)
const LoadBody = z.union([z.object({ path: z.string() }), z.object({ url: z.string() })])
const UnloadBody = z.object({ name: z.string() })
const CreateBody = z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
})

import { SessionPrompt } from "../../src/session/prompt"

describe("skills REST API validation", () => {
  test("load body accepts path", () => {
    const result = LoadBody.safeParse({ path: "/some/dir" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ path: "/some/dir" })
    }
  })

  test("load body accepts url", () => {
    const result = LoadBody.safeParse({ url: "https://example.com/skills/" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ url: "https://example.com/skills/" })
    }
  })

  test("load body rejects empty", () => {
    const result = LoadBody.safeParse({})
    expect(result.success).toBe(false)
  })

  test("unload body accepts name", () => {
    const result = UnloadBody.safeParse({ name: "test-skill" })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data).toEqual({ name: "test-skill" })
    }
  })

  test("unload body rejects empty", () => {
    const result = UnloadBody.safeParse({})
    expect(result.success).toBe(false)
  })

  test("create body accepts valid input", () => {
    const result = CreateBody.safeParse({
      name: "test-skill",
      description: "A test skill",
      content: "# Test\nContent.",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.name).toBe("test-skill")
      expect(result.data.description).toBe("A test skill")
      expect(result.data.content).toBe("# Test\nContent.")
    }
  })

  test("create body rejects missing name", () => {
    const result = CreateBody.safeParse({ description: "desc", content: "c" })
    expect(result.success).toBe(false)
  })

  test("create body rejects missing description", () => {
    const result = CreateBody.safeParse({ name: "n", content: "c" })
    expect(result.success).toBe(false)
  })

  test("create body rejects missing content", () => {
    const result = CreateBody.safeParse({ name: "n", description: "d" })
    expect(result.success).toBe(false)
  })

  test("create body rejects empty object", () => {
    const result = CreateBody.safeParse({})
    expect(result.success).toBe(false)
  })
})

describe("PromptInput skills schema", () => {
  test("accepts skills array", () => {
    const result = SessionPrompt.PromptInput.safeParse({
      sessionID: "ses_123",
      parts: [],
      skills: ["a", "b"],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.skills).toEqual(["a", "b"])
    }
  })

  test("works without skills", () => {
    const result = SessionPrompt.PromptInput.safeParse({
      sessionID: "ses_123",
      parts: [],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.skills).toBeUndefined()
    }
  })

  test("rejects non-array skills", () => {
    const result = SessionPrompt.PromptInput.safeParse({
      sessionID: "ses_123",
      parts: [],
      skills: "not-array",
    })
    expect(result.success).toBe(false)
  })
})

describe("skill service integration", () => {
  it.live("load + get + unload roundtrip", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "tmp-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: roundtrip-skill
description: Skill for roundtrip test.
---

# Roundtrip Skill
`,
            ),
          )

          const skill = yield* Skill.Service

          // Load
          const loaded = yield* skill.load(skillDir)
          expect(loaded.length).toBe(1)
          expect(loaded[0].name).toBe("roundtrip-skill")

          // Get returns the loaded skill
          const got = yield* skill.get("roundtrip-skill")
          expect(got).toBeDefined()
          expect(got!.name).toBe("roundtrip-skill")

          // Unload
          yield* skill.unload("roundtrip-skill")

          // Get returns undefined after unload
          const after = yield* skill.get("roundtrip-skill")
          expect(after).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("load + available", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "avail-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: avail-skill
description: Skill for available test.
---

# Avail Skill
`,
            ),
          )

          const skill = yield* Skill.Service

          yield* skill.load(skillDir)
          const list = yield* skill.available()
          const found = list.find((s) => s.name === "avail-skill")
          expect(found).toBeDefined()
          expect(found!.description).toBe("Skill for available test.")
        }),
      { git: true },
    ),
  )

  it.live("load body rejects number path", () =>
    Effect.gen(function* () {
      const result = LoadBody.safeParse({ path: 123 })
      expect(result.success).toBe(false)
    }),
  )

  it.live("PromptInput skills rejects non-string items", () =>
    Effect.gen(function* () {
      const result = SessionPrompt.PromptInput.safeParse({
        sessionID: "ses_123",
        parts: [],
        skills: [123],
      })
      expect(result.success).toBe(false)
    }),
  )

  it.live("PromptInput skills accepts empty array", () =>
    Effect.gen(function* () {
      const result = SessionPrompt.PromptInput.safeParse({
        sessionID: "ses_123",
        parts: [],
        skills: [],
      })
      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.skills).toEqual([])
      }
    }),
  )

  it.live("load with both path and url prefers path", () =>
    Effect.gen(function* () {
      // Zod union matches first successful schema, so path wins
      const result = LoadBody.safeParse({ path: "/some/path", url: "https://example.com/" })
      expect(result.success).toBe(true)
      if (result.success) {
        expect("path" in result.data).toBe(true)
        if ("path" in result.data) expect(result.data.path).toBe("/some/path")
      }
    }),
  )

  it.live("create roundtrip", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service

          const info = yield* skill.create({
            name: "api-create-skill",
            description: "Created via API",
            content: "# API\nSkill content.",
          })

          expect(info.name).toBe("api-create-skill")
          expect(info.location).toBe("memory://api-create-skill")

          const found = yield* skill.get("api-create-skill")
          expect(found).toBeDefined()
          expect(found!.description).toBe("Created via API")

          yield* skill.unload("api-create-skill")
          expect(yield* skill.get("api-create-skill")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("create with invalid body (number name) fails validation", () =>
    Effect.gen(function* () {
      const result = CreateBody.safeParse({ name: 123, description: "d", content: "c" })
      expect(result.success).toBe(false)
    }),
  )

  it.live("session create via service matches API behavior", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service

          const sessionSkill = yield* skill.sessionCreate("ses_api", {
            name: "api-session-skill",
            description: "API Test",
            content: "API content",
          })
          expect(sessionSkill.name).toBe("api-session-skill")

          const globalList = yield* skill.all()
          expect(globalList.map((s) => s.name)).not.toContain("api-session-skill")

          const sessionList = yield* skill.all("ses_api")
          expect(sessionList.map((s) => s.name)).toContain("api-session-skill")
        }),
      { git: true },
    ),
  )

  it.live("global skill visible in session list", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service

          yield* skill.create({
            name: "global-for-session",
            description: "Global",
            content: "G",
          })

          const sessionList = yield* skill.all("ses_any")
          expect(sessionList.map((s) => s.name)).toContain("global-for-session")
        }),
      { git: true },
    ),
  )

  it.live("session unload only affects session overlay", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service

          yield* skill.create({
            name: "shared-unload",
            description: "Shared",
            content: "S",
          })

          yield* skill.sessionCreate("ses_unload", {
            name: "shared-unload",
            description: "Session",
            content: "Session",
          })

          yield* skill.sessionUnload("ses_unload", "shared-unload")

          const sessionGet = yield* skill.get("shared-unload", "ses_unload")
          expect(sessionGet).toBeDefined()
          expect(sessionGet!.description).toBe("Shared")
          const globalGet = yield* skill.get("shared-unload")
          expect(globalGet).toBeDefined()
        }),
      { git: true },
    ),
  )
})
