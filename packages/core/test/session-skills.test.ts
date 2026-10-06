import { describe, expect, test } from "bun:test"
import { SessionSkill } from "@opencode/schema/session-skill"
import { validateResources } from "@opencode/core/session/skills"
import { sandboxSkillFiles, SessionSkills } from "@opencode/core/session/skills"
import { Skill } from "@opencode/schema/skill"

describe("SessionSkills resources", () => {
  test("sandbox skill file samples are relative, sorted, bounded, and exclude the manifest", () => {
    const directory = "/workspace/.opencode/skills/demo"
    expect(
      sandboxSkillFiles(directory, [
        { path: `${directory}/SKILL.md`, isDirectory: false },
        { path: `${directory}/scripts`, isDirectory: true },
        { path: `${directory}/scripts/check.mjs`, isDirectory: false },
        { path: `${directory}/references/guide.md`, isDirectory: false },
        { path: "/workspace/.opencode/skills/other/secret.md", isDirectory: false },
      ]),
    ).toEqual(["references/guide.md", "scripts/check.mjs"])
    expect(
      sandboxSkillFiles(
        directory,
        Array.from({ length: 12 }, (_, index) => ({
          path: `${directory}/resource-${String(index).padStart(2, "0")}.md`,
          isDirectory: false,
        })),
      ),
    ).toHaveLength(10)
  })

  for (const resourcePath of ["SKILL.md", "resources.json", "SKILL.md/nested", "resources.json/nested"]) {
    test(`rejects reserved resource path ${resourcePath}`, () => {
      expect(() => validateResources([{ path: resourcePath, type: "doc", content: "overwrite" }])).toThrow(
        SessionSkill.ResourceError,
      )
    })
  }
  test("rejects file/directory resource conflicts", () => {
    expect(() =>
      validateResources([
        { path: "scripts", type: "doc", content: "file" },
        { path: "scripts/run.sh", type: "script", content: "script" },
      ]),
    ).toThrow(SessionSkill.ResourceError)
  })
  test("sandbox skill shadows session and global definitions; removing it falls back to session", () => {
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
    expect(SessionSkills.mergeSkills([global], [], [sandbox])).toEqual([sandbox])
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
