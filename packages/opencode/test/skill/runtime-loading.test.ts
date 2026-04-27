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

  it.live("load multiple skills from nested directories", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sub1 = path.join(dir, "my-skills", "sub1")
          const sub2 = path.join(dir, "my-skills", "sub2")
          yield* Effect.promise(() => fs.mkdir(sub1, { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(sub2, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(sub1, "SKILL.md"), skillMd("skill-one", "First nested skill")),
          )
          yield* Effect.promise(() =>
            Bun.write(path.join(sub2, "SKILL.md"), skillMd("skill-two", "Second nested skill")),
          )

          const skill = yield* Skill.Service
          const loaded = yield* skill.load(path.join(dir, "my-skills"))

          expect(loaded.length).toBe(2)
          const names = loaded.map((s) => s.name).sort()
          expect(names).toEqual(["skill-one", "skill-two"])

          const all = yield* skill.all()
          const found1 = all.find((s) => s.name === "skill-one")
          const found2 = all.find((s) => s.name === "skill-two")
          expect(found1).toBeDefined()
          expect(found2).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("load directory with malformed SKILL.md is skipped gracefully", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const badDir = path.join(dir, "bad-skill")
          const goodDir = path.join(dir, "good-skill")
          yield* Effect.promise(() => fs.mkdir(badDir, { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(goodDir, { recursive: true }))

          // Malformed: missing required frontmatter
          yield* Effect.promise(() =>
            Bun.write(path.join(badDir, "SKILL.md"), "# No Frontmatter\n\nJust content."),
          )
          yield* Effect.promise(() =>
            Bun.write(path.join(goodDir, "SKILL.md"), skillMd("good-one", "Valid skill")),
          )

          const skill = yield* Skill.Service
          const loaded = yield* skill.load(dir)

          // Should only load the good one
          expect(loaded.length).toBe(1)
          expect(loaded[0].name).toBe("good-one")

          // Bad skill should not be in registry
          const bad = yield* skill.get("bad-skill")
          expect(bad).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("all() returns loaded skills including runtime-loaded", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "all-test-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(skillDir, "SKILL.md"), skillMd("all-skill", "For all() test")),
          )

          const skill = yield* Skill.Service

          const before = yield* skill.all()
          const beforeNames = before.map((s) => s.name)

          yield* skill.load(skillDir)

          const after = yield* skill.all()
          const afterNames = after.map((s) => s.name)

          expect(afterNames).toContain("all-skill")
          expect(after.length).toBe(before.length + 1)
        }),
      { git: true },
    ),
  )

  it.live("dirs() returns loaded skill directories", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "dirs-test-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(skillDir, "SKILL.md"), skillMd("dirs-skill", "For dirs() test")),
          )

          const skill = yield* Skill.Service

          const before = yield* skill.dirs()

          yield* skill.load(skillDir)

          const after = yield* skill.dirs()

          expect(after.length).toBe(before.length + 1)
          expect(after).toContain(skillDir)
        }),
      { git: true },
    ),
  )

  it.live("load then unload then load again works", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "cycle-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(skillDir, "SKILL.md"), skillMd("cycle-skill", "Cyclic skill")),
          )

          const skill = yield* Skill.Service

          // Load
          yield* skill.load(skillDir)
          expect(yield* skill.get("cycle-skill")).toBeDefined()

          // Unload
          yield* skill.unload("cycle-skill")
          expect(yield* skill.get("cycle-skill")).toBeUndefined()

          // Load again
          const reloaded = yield* skill.load(skillDir)
          expect(reloaded.length).toBe(1)
          expect(reloaded[0].name).toBe("cycle-skill")
          expect(yield* skill.get("cycle-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("concurrent load of different skills is safe", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const dir1 = path.join(dir, "concurrent1")
          const dir2 = path.join(dir, "concurrent2")
          yield* Effect.promise(() => fs.mkdir(dir1, { recursive: true }))
          yield* Effect.promise(() => fs.mkdir(dir2, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(dir1, "SKILL.md"), skillMd("concurrent-a", "Skill A")),
          )
          yield* Effect.promise(() =>
            Bun.write(path.join(dir2, "SKILL.md"), skillMd("concurrent-b", "Skill B")),
          )

          const skill = yield* Skill.Service

          // Load both concurrently
          const [loaded1, loaded2] = yield* Effect.all([
            skill.load(dir1),
            skill.load(dir2),
          ])

          expect(loaded1.length + loaded2.length).toBe(2)

          const all = yield* skill.all()
          const names = all.map((s) => s.name)
          expect(names).toContain("concurrent-a")
          expect(names).toContain("concurrent-b")
        }),
      { git: true },
    ),
  )

  it.live("create returns skill with memory location", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const info = yield* skill.create({
            name: "inline-skill",
            description: "Created inline",
            content: "# Inline\nTest content.",
          })

          expect(info.name).toBe("inline-skill")
          expect(info.description).toBe("Created inline")
          expect(info.content).toBe("# Inline\nTest content.")
          expect(info.location).toBe("memory://inline-skill")
        }),
      { git: true },
    ),
  )

  it.live("create writes to registry and get finds it", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.create({
            name: "findable-skill",
            description: "Should be findable",
            content: "Find me.",
          })

          const found = yield* skill.get("findable-skill")
          expect(found).toBeDefined()
          expect(found!.name).toBe("findable-skill")
          expect(found!.location).toBe("memory://findable-skill")
        }),
      { git: true },
    ),
  )

  it.live("create appears in all and available", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.create({
            name: "listed-skill",
            description: "Should be listed",
            content: "List me.",
          })

          const all = yield* skill.all()
          expect(all.find((s) => s.name === "listed-skill")).toBeDefined()

          const available = yield* skill.available()
          expect(available.find((s) => s.name === "listed-skill")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("create overrides existing skill with same name", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "override-skill")
          yield* Effect.promise(() => fs.mkdir(skillDir, { recursive: true }))
          yield* Effect.promise(() =>
            Bun.write(path.join(skillDir, "SKILL.md"), skillMd("override-skill", "Original")),
          )

          const skill = yield* Skill.Service
          yield* skill.load(skillDir)
          expect((yield* skill.get("override-skill"))?.description).toBe("Original")

          yield* skill.create({
            name: "override-skill",
            description: "Replaced",
            content: "New content.",
          })
          const found = yield* skill.get("override-skill")
          expect(found?.description).toBe("Replaced")
          expect(found?.content).toBe("New content.")
          expect(found?.location).toBe("memory://override-skill")
        }),
      { git: true },
    ),
  )

  it.live("create then unload removes skill", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.create({
            name: "temp-skill",
            description: "Temporary",
            content: "Gone soon.",
          })
          expect(yield* skill.get("temp-skill")).toBeDefined()

          yield* skill.unload("temp-skill")
          expect(yield* skill.get("temp-skill")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("concurrent create of different skills is safe", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const [a, b] = yield* Effect.all([
            skill.create({ name: "concurrent-c", description: "C", content: "c" }),
            skill.create({ name: "concurrent-d", description: "D", content: "d" }),
          ])

          expect(a.name).toBe("concurrent-c")
          expect(b.name).toBe("concurrent-d")

          const all = yield* skill.all()
          const names = all.map((s) => s.name)
          expect(names).toContain("concurrent-c")
          expect(names).toContain("concurrent-d")
        }),
      { git: true },
    ),
  )

  it.live("sessionCreate creates skill only in session overlay", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          const created = yield* skill.sessionCreate("ses-A", {
            name: "session-only",
            description: "Only in session",
            content: "Session content",
          })
          expect(created.name).toBe("session-only")

          const globalGet = yield* skill.get("session-only")
          expect(globalGet).toBeUndefined()

          const sessionGet = yield* skill.get("session-only", "ses-A")
          expect(sessionGet).toBeDefined()
          expect(sessionGet!.name).toBe("session-only")
        }),
      { git: true },
    ),
  )

  it.live("session skill shadows global skill with same name", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service

          const globalSkill = yield* skill.create({
            name: "shared",
            description: "Global version",
            content: "Global content",
          })
          expect(globalSkill.description).toBe("Global version")

          const sessionSkill = yield* skill.sessionCreate("ses-B", {
            name: "shared",
            description: "Session version",
            content: "Session content",
          })
          expect(sessionSkill.description).toBe("Session version")

          const globalGet = yield* skill.get("shared")
          expect(globalGet).toBeDefined()
          expect(globalGet!.description).toBe("Global version")

          const sessionGet = yield* skill.get("shared", "ses-B")
          expect(sessionGet).toBeDefined()
          expect(sessionGet!.description).toBe("Session version")
        }),
      { git: true },
    ),
  )

  it.live("sessionUnload removes only from session overlay", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.sessionCreate("ses-C", {
            name: "unload-session",
            description: "Will be unloaded",
            content: "Content",
          })

          expect(yield* skill.get("unload-session", "ses-C")).toBeDefined()

          yield* skill.sessionUnload("ses-C", "unload-session")

          expect(yield* skill.get("unload-session", "ses-C")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("sessionClear removes all session skills", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.sessionCreate("ses-D", {
            name: "skill-1",
            description: "First",
            content: "Content 1",
          })
          yield* skill.sessionCreate("ses-D", {
            name: "skill-2",
            description: "Second",
            content: "Content 2",
          })

          expect(yield* skill.get("skill-1", "ses-D")).toBeDefined()
          expect(yield* skill.get("skill-2", "ses-D")).toBeDefined()

          yield* skill.sessionClear("ses-D")

          expect(yield* skill.get("skill-1", "ses-D")).toBeUndefined()
          expect(yield* skill.get("skill-2", "ses-D")).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("sessions are isolated from each other", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.sessionCreate("ses-1", {
            name: "skill-A",
            description: "Only in ses-1",
            content: "A",
          })
          yield* skill.sessionCreate("ses-2", {
            name: "skill-B",
            description: "Only in ses-2",
            content: "B",
          })

          expect(yield* skill.get("skill-B", "ses-1")).toBeUndefined()
          expect(yield* skill.get("skill-A", "ses-2")).toBeUndefined()
          expect(yield* skill.get("skill-A", "ses-1")).toBeDefined()
          expect(yield* skill.get("skill-B", "ses-2")).toBeDefined()
        }),
      { git: true },
    ),
  )

  it.live("all returns session overlay merged with global", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const skill = yield* Skill.Service
          yield* skill.create({
            name: "global-skill",
            description: "Global",
            content: "G",
          })
          yield* skill.sessionCreate("ses-merge", {
            name: "session-skill",
            description: "Session",
            content: "S",
          })

          const globalAll = yield* skill.all()
          expect(globalAll.map((s) => s.name)).toContain("global-skill")
          expect(globalAll.map((s) => s.name)).not.toContain("session-skill")

          const sessionAll = yield* skill.all("ses-merge")
          expect(sessionAll.map((s) => s.name)).toContain("global-skill")
          expect(sessionAll.map((s) => s.name)).toContain("session-skill")
        }),
      { git: true },
    ),
  )
})
