import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import fs from "fs/promises"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Skill.defaultLayer, node))

function skillMd(name: string, description: string, content = "Test skill content.") {
  return `---
name: ${name}
description: ${description}
---

# ${name}

${content}
`
}

describe("skill runtime loading", () => {
  it.live("load from path returns new skills", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "my-skills", "runtime-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(skillDir, "SKILL.md"), skillMd("runtime-skill", "Loaded at runtime")),
          )

          const skill = yield* Skill.Service
          const loaded = yield* skill.load(path.join(dir, "my-skills"))
          expect(loaded.length).toBe(1)
          expect(loaded[0].name).toBe("runtime-skill")
          expect(loaded[0].description).toBe("Loaded at runtime")

          const found = yield* skill.get("runtime-skill")
          expect(found).toBeDefined()
          expect(found!.name).toBe("runtime-skill")
        }),
      { git: true },
    ),
  )

  it.live("load non-existent path returns empty array", () =>
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

  it.live("unload removes skill from registry", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "unload-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(skillDir, "SKILL.md"), skillMd("unload-me", "Will be unloaded")),
          )

          const skill = yield* Skill.Service
          yield* skill.load(skillDir)
          expect(yield* skill.get("unload-me")).toBeDefined()

          yield* skill.unload("unload-me")
          expect(yield* skill.get("unload-me")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("unload non-existent skill does not throw", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.unload("nonexistent")
        }),
      { git: true },
    ),
  )

  it.live("duplicate override: second load with same name overrides first", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const dir1 = path.join(dir, "first")
          const dir2 = path.join(dir, "second")
          yield* Effect.promise(() => fs.mkdir(dir1, { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(dir2, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(dir1, "SKILL.md"), skillMd("shared-name", "First skill")),
          )
          yield* Effect.promise(() =>
            Bun.write(path.join(dir2, "SKILL.md"), skillMd("shared-name", "Second skill")),
          )

          const skill = yield* Skill.Service
          yield* skill.load(dir1)
          expect((yield* skill.get("shared-name"))?.description).toBe("First skill")

          const loaded = yield* skill.load(dir2)
          expect(loaded.length).toBe(0)

          const found = yield* skill.get("shared-name")
          expect(found?.description).toBe("Second skill")
        }),
      { git: true },
    ),
  )
})
