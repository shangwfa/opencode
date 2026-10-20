import type { SlashCommand } from "./slash-popover"

export type SessionSkillResource = {
  path: string
  type: string
  size: number
  digest: string
}

export type SessionSkill = {
  name: string
  description: string
  content: string
  id: string
  resources: SessionSkillResource[]
}

type FetchSessionSkillsInput = {
  baseUrl: string
  sessionId: string
  fetcher?: typeof fetch
}

const validSkill = (value: unknown): value is SessionSkill => {
  if (!value || typeof value !== "object") return false
  const item = value as Partial<SessionSkill>
  return typeof item.name === "string" && typeof item.description === "string"
}

// The generated SDK does not expose session-scoped skills yet; keep this raw
// endpoint isolated so PromptInput only deals with normalized slash commands.
export async function fetchSessionSkills(input: FetchSessionSkillsInput): Promise<SessionSkill[]> {
  const base = input.baseUrl.replace(/\/+$/, "")
  const sessionId = input.sessionId.trim()
  if (!base || !sessionId) return []

  const fetcher = input.fetcher ?? fetch
  const res = await fetcher(`${base}/session/${encodeURIComponent(sessionId)}/skills`)
  if (!res.ok) throw new Error(`Failed to load session skills (${res.status})`)

  const data = await res.json()
  if (!Array.isArray(data)) return []
  return data.filter(validSkill)
}

export function toSessionSkillCommands(
  skills: readonly SessionSkill[],
  existingTriggers: ReadonlySet<string> = new Set(),
): SlashCommand[] {
  const seen = new Set(existingTriggers)
  const commands: SlashCommand[] = []

  for (const skill of skills) {
    const trigger = skill.name.trim()
    if (!trigger || seen.has(trigger)) continue
    seen.add(trigger)
    commands.push({
      id: `session-skill.${skill.id || trigger}`,
      trigger,
      title: trigger,
      description: skill.description,
      type: "custom",
      source: "skill",
    })
  }

  return commands
}
