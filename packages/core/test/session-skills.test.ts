import { describe, expect, test } from "bun:test"
import { SessionSkill } from "@opencode/schema/session-skill"
import { validateResources } from "@opencode/core/session/skills"
import { SessionSkills } from "@opencode/core/session/skills"
import { Skill } from "@opencode/schema/skill"

describe("SessionSkills resources", () => {
  test("sandbox skill replaces session and global definitions as one bundle, with layered fallback", () => {
    const id = Skill.ID.make("priority-skill")
    const skill = (content: string) =>
      Skill.Info.make({
        id,
        name: Skill.Name.make("priority-skill"),
        description: content,
        content,
        path: `/workspace/.opencode/skills/${content}/SKILL.md` as Skill.Info["path"],
      })
    const global = skill("global")
    const session = SessionSkill.Info.make({ skill: skill("session"), source: "session", resources: [] })
    const sandbox = SessionSkill.Info.make({ skill: skill("sandbox"), source: "sandbox", resources: [] })
    expect(SessionSkills.mergeSkills([global], [session], [sandbox])).toEqual([sandbox])
    expect(SessionSkills.mergeSkills([global], [session], [])).toEqual([session])
    expect(SessionSkills.mergeSkills([global], [], [])[0]?.skill).toEqual(global)
  })

  test("accepts bounded relative resources", () => {
    expect(() => validateResources([{ path: "references/guide.md", type: "doc", content: "guide" }])).not.toThrow()
  })

  test("rejects traversal, duplicates, and oversized bundles", () => {
    expect(() => validateResources([{ path: "../secret", type: "doc", content: "x" }])).toThrow(
      SessionSkill.ResourceError,
    )
    expect(() =>
      validateResources([
        { path: "a", type: "doc", content: "x" },
        { path: "a", type: "doc", content: "y" },
      ]),
    ).toThrow(SessionSkill.ResourceError)
    expect(() =>
      validateResources(
        Array.from({ length: SessionSkill.MaxResources + 1 }, (_, index) => ({
          path: `r/${index}`,
          type: "doc" as const,
          content: "x",
        })),
      ),
    ).toThrow(SessionSkill.ResourceError)
  })
})
