/**
 * Slash 命令浮层的纯逻辑（分组/排序/标签显隐）。
 * 源：slash-popover.tsx；UI（PromptPopover 组件）随 React composer 重写。
 */

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "file"; path: string; display: string; recent?: boolean }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

export type SlashGroupKey = "custom" | "skill" | "command"

export const slashGroupKey = (cmd: SlashCommand): SlashGroupKey => {
  if (cmd.source === "skill") return "skill"
  if (cmd.source === "mcp" || (cmd.type === "custom" && cmd.source !== "command")) return "custom"
  return "command"
}

const slashGroupRank = (key: SlashGroupKey) => {
  if (key === "custom") return 0
  if (key === "skill") return 1
  return 2
}

export const slashCommandGroup = slashGroupKey

export function sortSlashCommandGroups(a: { category: string }, b: { category: string }) {
  return slashGroupRank(a.category as SlashGroupKey) - slashGroupRank(b.category as SlashGroupKey)
}

export function shouldShowSlashGroupLabel(key: SlashGroupKey) {
  return key !== "custom"
}
