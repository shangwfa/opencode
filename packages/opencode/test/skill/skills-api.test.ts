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
})
