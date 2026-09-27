import { describe, expect, test } from "bun:test"
import { SessionSkill } from "@opencode/schema/session-skill"
import { validateResources } from "@opencode/core/session/skills"

describe("SessionSkills resources", () => {
  test("accepts bounded relative resources", () => {
    expect(() => validateResources([{ path: "references/guide.md", type: "doc", content: "guide" }])).not.toThrow()
  })

  test("rejects traversal, duplicates, and oversized bundles", () => {
    expect(() => validateResources([{ path: "../secret", type: "doc", content: "x" }])).toThrow(SessionSkill.ResourceError)
    expect(() => validateResources([{ path: "a", type: "doc", content: "x" }, { path: "a", type: "doc", content: "y" }])).toThrow(SessionSkill.ResourceError)
    expect(() => validateResources(Array.from({ length: SessionSkill.MaxResources + 1 }, (_, index) => ({ path: `r/${index}`, type: "doc" as const, content: "x" })))).toThrow(SessionSkill.ResourceError)
  })
})
