import type { RuntimeFlags } from "@/effect/runtime-flags"
import type { Tool } from "./tool"

const READ_TOOLS = new Set(["read", "glob", "grep", "lsp", "webfetch", "websearch", "repo_overview"])
const CONTROL_TOOLS = new Set(["execute", "invalid", "question", "task", "task_status", "todowrite", "skill", "plan"])

export function select(mode: RuntimeFlags.CodeMode, tools: readonly Tool.Def[]) {
  if (mode === "off" || mode === "mcp") return []
  return tools.filter((tool) => !CONTROL_TOOLS.has(tool.id) && (mode === "all" || READ_TOOLS.has(tool.id)))
}

export * as CodeModePolicy from "./code-mode-policy"
