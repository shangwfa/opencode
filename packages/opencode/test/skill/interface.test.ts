import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"

const node = CrossSpawnSpawner.defaultLayer
const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))

describe("Skill Service Interface", () => {
  it.live("load → get → unload workflow", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "test-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: test-skill
description: A test skill for interface validation
---

# Test Skill

This skill is used for testing the load/get/unload interface.
`,
            ),
          )

          const skill = yield* Skill.Service

          // 1. Load skill
          const loaded = yield* skill.load(skillDir)
          expect(loaded.length).toBe(1)
          expect(loaded[0].name).toBe("test-skill")
          expect(loaded[0].description).toBe("A test skill for interface validation")

          // 2. Get skill
          const found = yield* skill.get("test-skill")
          expect(found).toBeDefined()
          expect(found!.name).toBe("test-skill")
          expect(found!.content).toContain("This skill is used for testing")

          // 3. Check in all()
          const all = yield* skill.all()
          const inAll = all.find((s) => s.name === "test-skill")
          expect(inAll).toBeDefined()

          // 4. Check in available()
          const available = yield* skill.available()
          const inAvailable = available.find((s) => s.name === "test-skill")
          expect(inAvailable).toBeDefined()

          // 5. Unload skill
          yield* skill.unload("test-skill")

          // 6. Verify unloaded
          const after = yield* skill.get("test-skill")
          expect(after).toBeUndefined()

          const allAfter = yield* skill.all()
          const notInAll = allAfter.find((s) => s.name === "test-skill")
          expect(notInAll).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("load returns empty array for non-existent path", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const loaded = yield* skill.load(path.join(dir, "does-not-exist"))
          expect(loaded).toEqual([])
        }),
      { git: true },
    ),
  )

  it.live("unload non-existent skill does not throw", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.unload("never-loaded-skill")
        }),
      { git: true },
    ),
  )
})
