import type { SessionAgent } from "@opencode/schema/session-agent"
import type { SessionSkill } from "@opencode/schema/session-skill"
import type { SessionMcp } from "@opencode/schema/session-mcp"
import type { SessionCommand } from "@opencode/schema/session-command"
import type { SessionTool } from "@opencode/schema/session-tool"
import type { SessionPlugin } from "@opencode/schema/session-plugin"

export type HarnessConfig = {
  agent: string
  agents: SessionAgent.Payload[]
  skills: SessionSkill.Payload[]
  mcps: SessionMcp.Payload[]
  commands: SessionCommand.CreatePayload[]
  tools: SessionTool.Payload[]
  plugins: SessionPlugin.Payload[]
  agentsMd: string
}
export type HarnessKind = Exclude<keyof HarnessConfig, "agent">

export type HarnessPair = { key: string; value: string }

export function harnessPairs(value: unknown): HarnessPair[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return []
  return Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => ({ key, value }))
}

export function harnessPairValues(rows: HarnessPair[]): Record<string, string> {
  const entries = rows.filter((row) => row.key.trim() || row.value)
  if (entries.some((row) => !row.key.trim())) throw new Error("请为每个参数填写名称")
  const keys = entries.map((row) => row.key.trim())
  if (new Set(keys).size !== keys.length) throw new Error("参数名称不能重复")
  return Object.fromEntries(entries.map((row) => [row.key.trim(), row.value]))
}

export const harnessStarters = {
  agents: { id: "reviewer", config: { description: "在提交前审查代码质量、安全风险与测试覆盖", mode: "subagent", system: "审查当前变更，优先报告可复现的问题。说明影响、代码位置和修复建议；不要未经确认修改文件。" } },
  skills: { id: "delivery-checklist", name: "交付检查", description: "完成功能开发、准备交付时使用", content: "## 检查步骤\n1. 对照需求核对实现。\n2. 运行相关测试与类型检查。\n3. 说明已验证项、未验证项和已知风险。", resources: [] },
  commands: { name: "review", description: "审查当前代码变更", template: "审查当前代码变更，重点检查正确性、安全性和测试覆盖。按严重程度列出问题，给出依据与修复建议。", hints: [] },
} as const

export const harnessSections = [
  { id: "agents", title: "Agent", description: "角色、系统提示词与执行策略" },
  { id: "mcps", title: "MCP", description: "远程服务与沙箱本地进程" },
  { id: "skills", title: "Skills", description: "技能正文与资源包" },
  { id: "commands", title: "Commands", description: "可复用的命令提示词" },
] as const

export function parseJsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text || "{}")
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("请填写 JSON 对象")
  return value as Record<string, unknown>
}

export function parseCommand(text: string): string[] {
  const value: unknown = JSON.parse(text)
  if (!Array.isArray(value) || !value.length || value.some((entry) => typeof entry !== "string" || !entry)) throw new Error('启动命令需为非空字符串数组，例如 ["npx", "-y", "包名"]')
  return value
}
