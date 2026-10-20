import type { SessionSkill } from "@opencode/schema/session-skill"

export type SkillResource = SessionSkill.ResourceInput
export type SkillDraft = { id: string; name: string; description: string; autoinvoke: boolean; content: string; resources: SkillResource[] }
export const skillBytes = (value: string) => new TextEncoder().encode(value).length

export function validateSkillPackage(value: SkillDraft): void {
  if (!value.id.trim()) throw new Error("请填写技能标识")
  if (!value.content.trim()) throw new Error("请填写 SKILL.md 正文")
  if (skillBytes(value.content) > 256 * 1024) throw new Error("SKILL.md 正文不能超过 256 KiB")
  if (value.resources.length > 64) throw new Error("最多支持 64 个资源文件")
  let total = 0
  const paths = new Set<string>()
  for (const item of value.resources) {
    const path = item.path
    if (!path || path.includes("\0") || path.includes("\\") || path.startsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new Error(`资源路径无效：${path || "（空）"}`)
    if (["SKILL.md", "resources.json"].some((name) => path === name || path.startsWith(`${name}/`))) throw new Error(`资源路径为系统保留名称：${path}`)
    if (paths.has(path)) throw new Error(`资源路径重复：${path}`)
    if (value.resources.some((other) => other.path !== path && (other.path.startsWith(`${path}/`) || path.startsWith(`${other.path}/`)))) throw new Error(`文件与目录路径冲突：${path}`)
    if (!["doc", "script", "template", "asset"].includes(item.type)) throw new Error(`资源类型无效：${path}`)
    if (typeof item.content !== "string") throw new Error(`资源内容必须是文本：${path}`)
    paths.add(path)
    const size = skillBytes(item.content)
    if (size > 256 * 1024) throw new Error(`资源文件超过 256 KiB：${path}`)
    total += size
  }
  if (total > 1024 * 1024) throw new Error("资源文件总量不能超过 1 MiB")
}

export function parseSkillPackage(input: string): SkillDraft {
  const value: unknown = JSON.parse(input)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("技能配置必须是 JSON 对象")
  const raw = value as Record<string, unknown>
  const unknown = Object.keys(raw).filter((key) => !["id", "name", "description", "autoinvoke", "content", "resources"].includes(key))
  if (unknown.length) throw new Error(`当前服务不支持字段：${unknown.join("、")}`)
  if (typeof raw.id !== "string" || typeof raw.content !== "string" || (raw.name !== undefined && typeof raw.name !== "string") || (raw.description !== undefined && typeof raw.description !== "string") || (raw.autoinvoke !== undefined && typeof raw.autoinvoke !== "boolean") || (raw.resources !== undefined && !Array.isArray(raw.resources))) throw new Error("技能字段格式错误")
  const resources = (raw.resources ?? []) as unknown[]
  if (resources.some((item) => !item || typeof item !== "object" || typeof (item as SkillResource).path !== "string" || typeof (item as SkillResource).content !== "string" || !["doc", "script", "template", "asset"].includes((item as SkillResource).type))) throw new Error("资源文件须包含 path、type、content")
  const result: SkillDraft = { id: raw.id, name: raw.name as string ?? "", description: raw.description as string ?? "", autoinvoke: raw.autoinvoke === true, content: raw.content, resources: resources as SkillResource[] }
  validateSkillPackage(result)
  return result
}

export function resourceType(path: string): SkillResource["type"] {
  if (/^templates?\//.test(path)) return "template"
  if (/^(scripts?|bin)\//.test(path) || /\.(sh|py|js|ts|mjs|cjs)$/.test(path)) return "script"
  if (/\.(md|txt|rst)$/.test(path)) return "doc"
  return "asset"
}

/** 资源 API 仅支持文本；禁止把二进制静默替换为乱码。 */
export function decodeSkillFile(bytes: Uint8Array, path: string): string {
  if (bytes.byteLength > 256 * 1024) throw new Error(`文件超过 256 KiB：${path}`)
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    if (text.includes("\0")) throw new Error()
    return text
  } catch { throw new Error(`当前仅支持 UTF-8 文本资源，请移除二进制文件：${path}`) }
}
