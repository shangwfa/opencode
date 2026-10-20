import { describe, expect, test, vi } from "vitest"
import { fetchSessionSkills, toSessionSkillCommands, type SessionSkill } from "./session-skills"

const skill = (input: Partial<SessionSkill> & Pick<SessionSkill, "name">): SessionSkill => ({
  id: input.id ?? input.name,
  name: input.name,
  description: input.description ?? `${input.name} description`,
  content: input.content ?? "Use this skill.",
  resources: input.resources ?? [],
})

describe("session skills", () => {
  test("loads session skills from the raw opencode endpoint", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => [
        skill({
          id: "sk_1",
          name: "boss-create",
          description: "Create boss pages",
          resources: [{ path: "rules.md", type: "doc", size: 12, digest: "abc" }],
        }),
      ],
    })) as unknown as typeof fetch

    const result = await fetchSessionSkills({
      baseUrl: "https://test-opencode.shadow-rpa.net/",
      sessionId: "ses_1",
      fetcher,
    })

    expect(fetcher).toHaveBeenCalledWith("https://test-opencode.shadow-rpa.net/session/ses_1/skills")
    expect(result).toEqual([
      {
        id: "sk_1",
        name: "boss-create",
        description: "Create boss pages",
        content: "Use this skill.",
        resources: [{ path: "rules.md", type: "doc", size: 12, digest: "abc" }],
      },
    ])
  })

  test("normalizes session skills into custom slash commands", () => {
    expect(toSessionSkillCommands([skill({ id: "sk_1", name: "boss-create", description: "Create" })])).toEqual([
      {
        id: "session-skill.sk_1",
        trigger: "boss-create",
        title: "boss-create",
        description: "Create",
        type: "custom",
        source: "skill",
      },
    ])
  })

  test("skips duplicate triggers when existing commands win", () => {
    const commands = toSessionSkillCommands(
      [skill({ name: "review" }), skill({ name: "boss-create" }), skill({ name: "boss-create" })],
      new Set(["review"]),
    )

    expect(commands.map((command) => command.trigger)).toEqual(["boss-create"])
  })

  test("throws on failed fetch so callers can decide fallback behavior", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => [],
    })) as unknown as typeof fetch

    await expect(fetchSessionSkills({ baseUrl: "http://localhost:4096", sessionId: "ses_1", fetcher })).rejects.toThrow(
      "Failed to load session skills (500)",
    )
  })
})
