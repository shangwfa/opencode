import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(SystemPrompt.defaultLayer, Skill.defaultLayer, node))

// Minimal agent info for testing (allow all skills)
const mockAgentAllowAll: Agent.Info = {
  name: "test",
  mode: "primary",
  permission: [] as Permission.Ruleset,
} as Agent.Info

// Agent with skill permission denied
const mockAgentDenySkill: Agent.Info = {
  name: "test",
  mode: "primary",
  permission: [
    { permission: "skill", pattern: "*", action: "deny" },
  ] as Permission.Ruleset,
} as Agent.Info

describe("SystemPrompt.skills preload", () => {
  it.live("skills() without preload returns available skills list", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "preload-test-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: preload-test-skill
description: Test skill for preload.
---

# Test Skill

This is test content.
`,
            ),
          )

          const skill = yield* Skill.Service
          const sys = yield* SystemPrompt.Service

          // Load the skill first
          yield* skill.load(skillDir)

          // Call skills() without preload
          const result = yield* sys.skills(mockAgentAllowAll)

          expect(result).toBeDefined()
          expect(result).toContain("preload-test-skill")
          expect(result).toContain("<available_skills>")
          expect(result).toContain("Skills provide specialized instructions")
        }),
      { git: true },
    ),
  )

  it.live("skills() with preload injects lightweight skill manifest", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "content-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: content-skill
description: Skill with content.
---

# Content Skill

Custom content here.
More content.
`,
            ),
          )

          const skill = yield* Skill.Service
          const sys = yield* SystemPrompt.Service

          yield* skill.load(skillDir)

          // Call with preload
          const result = yield* sys.skills(mockAgentAllowAll, ["content-skill"])

          expect(result).toBeDefined()
          expect(result).toContain("<preloaded_skills>")
          expect(result).toContain("<name>content-skill</name>")
          expect(result).not.toContain("Custom content here.")
          expect(result).not.toContain('<skill_content name="content-skill">')
          expect(result).toContain("<available_skills>") // Also has available list
        }),
      { git: true },
    ),
  )

  it.live("skills() with preload for non-existent skill skips gracefully", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sys = yield* SystemPrompt.Service

          // Call with non-existent skill
          const result = yield* sys.skills(mockAgentAllowAll, ["nonexistent-skill"])

          expect(result).toBeDefined()
          // Should NOT contain skill_content for non-existent skill
          expect(result).not.toContain('<skill_content name="nonexistent-skill">')
          // When no skills available, shows "No skills are currently available"
          expect(result).toContain("No skills are currently available")
        }),
      { git: true },
    ),
  )

  it.live("skills() with mixed preload (exists + non-existent)", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "existing-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: existing-skill
description: This skill exists.
---

# Existing
`,
            ),
          )

          const skill = yield* Skill.Service
          const sys = yield* SystemPrompt.Service

          yield* skill.load(skillDir)

          // Mixed: one exists, one doesn't
          const result = yield* sys.skills(mockAgentAllowAll, ["existing-skill", "missing-skill"])

          expect(result).toContain("<preloaded_skills>")
          expect(result).toContain("<name>existing-skill</name>")
          expect(result).not.toContain('<skill_content name="missing-skill">')
          expect(result).not.toContain("# Skill: existing-skill")
        }),
      { git: true },
    ),
  )

  it.live("skills() returns undefined when skill permission is denied", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "blocked-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: blocked-skill
description: Cannot see this.
---

# Blocked
`,
            ),
          )

          const skill = yield* Skill.Service
          const sys = yield* SystemPrompt.Service

          yield* skill.load(skillDir)

          // Agent with deny permission
          const result = yield* sys.skills(mockAgentDenySkill)

          expect(result).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("skills() with empty preload array behaves like no preload", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const skillDir = path.join(dir, "empty-test-skill")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: empty-test-skill
description: Test.
---

# Empty
`,
            ),
          )

          const skill = yield* Skill.Service
          const sys = yield* SystemPrompt.Service

          yield* skill.load(skillDir)

          // Empty array preload
          const result = yield* sys.skills(mockAgentAllowAll, [])

          expect(result).toBeDefined()
          expect(result).not.toContain("<skill_content>")
          expect(result).toContain("<available_skills>")
        }),
      { git: true },
    ),
  )
})
