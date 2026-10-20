import { describe, expect, test } from "vitest"
import { shouldShowSlashGroupLabel, slashCommandGroup, sortSlashCommandGroups, type SlashCommand } from "./slash-popover"

const command = (input: Partial<SlashCommand> & Pick<SlashCommand, "id" | "trigger">): SlashCommand => ({
  id: input.id,
  trigger: input.trigger,
  title: input.title ?? input.trigger,
  description: input.description,
  keybind: input.keybind,
  type: input.type ?? "custom",
  source: input.source,
})

describe("slash popover grouping", () => {
  test("groups MCP and custom content before skills and commands", () => {
    const groups = [
      { category: slashCommandGroup(command({ id: "builtin.model", trigger: "model", type: "builtin", source: "command" })) },
      { category: slashCommandGroup(command({ id: "session-skill.review", trigger: "review", source: "skill" })) },
      { category: slashCommandGroup(command({ id: "session-mcp.search", trigger: "search", source: "mcp" })) },
    ].sort(sortSlashCommandGroups)

    expect(groups.map((group) => group.category)).toEqual(["custom", "skill", "command"])
  })

  test("hides the custom group label used by the MCP parent menu", () => {
    expect(shouldShowSlashGroupLabel("custom")).toBe(false)
    expect(shouldShowSlashGroupLabel("skill")).toBe(true)
    expect(shouldShowSlashGroupLabel("command")).toBe(true)
  })
})
