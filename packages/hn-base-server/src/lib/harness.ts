/** 应用 Harness 模板：复用 SaaS 定义契约，不维护另一套配置语义。 */
import { Schema } from "effect"
import { SessionAgent } from "@opencode/schema/session-agent"
import { SessionSkill } from "@opencode/schema/session-skill"
import { SessionMcp } from "@opencode/schema/session-mcp"
import { SessionCommand } from "@opencode/schema/session-command"
import { SessionTool } from "@opencode/schema/session-tool"
import { SessionPlugin } from "@opencode/schema/session-plugin"
import { encryptSecret, decryptSecret } from "./crypto.js"
import { saasFetch } from "./saas.js"
import { errors } from "./errors.js"

const Harness = Schema.Struct({
  agent: Schema.String,
  agents: Schema.Array(SessionAgent.Payload),
  skills: Schema.Array(SessionSkill.Payload),
  mcps: Schema.Array(SessionMcp.Payload),
  commands: Schema.Array(SessionCommand.CreatePayload),
  tools: Schema.Array(SessionTool.Payload),
  plugins: Schema.Array(SessionPlugin.Payload),
  agentsMd: Schema.String,
})
export type HarnessConfig = typeof Harness.Type

export function emptyHarness(): HarnessConfig {
  return { agent: "build", agents: [], skills: [], mcps: [], commands: [], tools: [], plugins: [], agentsMd: "" }
}

/** 模板必须在保存前满足会话资源约束，不能等新需求下发时才失败。 */
function validateSkillResources(items: readonly SessionSkill.ResourceInput[]): void {
  if (items.length > SessionSkill.MaxResources) throw errors.invalid(`单个 Skill 最多配置 ${SessionSkill.MaxResources} 个资源文件`)
  const paths = new Set<string>()
  let total = 0
  for (const item of items) {
    const path = item.path
    if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw errors.invalid(`Skill 资源路径无效：${path}`)
    if (["SKILL.md", "resources.json"].some((name) => path === name || path.startsWith(`${name}/`))) throw errors.invalid(`Skill 资源路径为保留名称：${path}`)
    if (paths.has(path)) throw errors.invalid(`Skill 资源路径重复：${path}`)
    if (items.some((other) => other.path !== path && (other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`)))) throw errors.invalid(`Skill 文件与目录路径冲突：${path}`)
    paths.add(path)
    const size = Buffer.byteLength(item.content, "utf8")
    if (size > SessionSkill.MaxResourceBytes) throw errors.invalid("单个 Skill 资源文件不能超过 256 KiB")
    total += size
  }
  if (total > SessionSkill.MaxResourcesBytes) throw errors.invalid("单个 Skill 的资源文件总量不能超过 1 MiB")
}

export function parseHarness(input: unknown): HarnessConfig {
  let value: HarnessConfig
  try { value = Schema.decodeUnknownSync(Harness)(input) } catch {
    throw errors.invalid("Harness 配置格式不正确，请检查各分类的字段和必填项")
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 4 * 1024 * 1024) throw errors.invalid("Harness 配置总量不能超过 4 MiB")
  for (const [kind, items] of Object.entries({ agents: value.agents, skills: value.skills, mcps: value.mcps, commands: value.commands, tools: value.tools, plugins: value.plugins })) {
    if (items.length > 50) throw errors.invalid(`${kind} 最多配置 50 项`)
    const ids = items.map((entry) => "id" in entry ? entry.id : entry.name)
    if (ids.some((id) => !id.trim())) throw errors.invalid(`${kind} 的标识不能为空`)
    if (new Set(ids).size !== ids.length) throw errors.invalid(`${kind} 中存在重复标识`)
  }
  const selected = value.agents.find((entry) => entry.id === value.agent)
  if (!value.agent.trim() || (selected && (selected.config.disabled || selected.config.mode === "subagent"))) throw errors.invalid("默认 Agent 必须是已启用的主 Agent")
  for (const content of [value.agentsMd, ...value.agents.map((entry) => entry.config.system ?? ""), ...value.skills.map((entry) => entry.content)]) {
    if (Buffer.byteLength(content, "utf8") > 256 * 1024) throw errors.invalid("单项指令正文不能超过 256 KiB")
  }
  for (const entry of value.mcps) {
    if (entry.config.type === "remote") {
      try { if (!["http:", "https:"].includes(new URL(entry.config.url).protocol)) throw new Error() } catch { throw errors.invalid("远程 MCP 地址必须是 HTTP 或 HTTPS URL") }
    }
  }
  for (const skill of value.skills) validateSkillResources(skill.resources ?? [])
  for (const command of value.commands) {
    if (Buffer.byteLength(command.template, "utf8") > SessionCommand.MaxTemplateBytes) throw errors.invalid("单个 Command 模板不能超过 256 KiB")
  }
  return value
}

export function sealHarness(config: HarnessConfig): { version: 1; encrypted: string } {
  return { version: 1, encrypted: encryptSecret(JSON.stringify(config)) }
}

export function readHarness(appConfig: unknown): HarnessConfig {
  if (!appConfig || typeof appConfig !== "object" || !("harness" in appConfig)) return emptyHarness()
  const stored = appConfig.harness
  if (!stored || typeof stored !== "object" || !("encrypted" in stored) || typeof stored.encrypted !== "string") throw errors.internal("应用 Harness 配置无法读取，请联系管理员")
  return parseHarness(JSON.parse(decryptSecret(stored.encrypted)))
}

/** 仅对新会话下发；错误时禁止调用模型，不把密钥或代码写入消息。 */
export async function applyHarness(sessionID: string, config: HarnessConfig): Promise<void> {
  const request = async (resource: string, body: unknown) => {
    const response = await saasFetch(`/api/session/${encodeURIComponent(sessionID)}/${resource}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    if (!response.ok || response.headers.get("content-type")?.includes("text/html")) throw errors.internal(`Harness 下发失败：${resource}（HTTP ${response.status}），未启动开发`)
  }
  for (const kind of ["agents", "skills", "mcps", "commands", "tools", "plugins"] as const) {
    for (const definition of config[kind]) await request(kind, definition)
  }
  if (config.agentsMd) await request("agents-md", { content: config.agentsMd })
  if (config.agent !== "build") await request("agent", { agent: config.agent })
}
