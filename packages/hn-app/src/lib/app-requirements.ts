export type AppRequirement = {
  id: string
  title: string
  status: string
  kind: string | null
  priority: string | null
  timeCreated: number
  timeUpdated: number
  sessionId: string | null
}

export function selectAppRequirements(items: AppRequirement[], query = "", limit?: number): AppRequirement[] {
  const keyword = query.trim().toLocaleLowerCase()
  const sorted = items.filter((item) => !keyword || `${item.title}\n${item.id}`.toLocaleLowerCase().includes(keyword))
    .sort((a, b) => b.timeUpdated - a.timeUpdated || b.timeCreated - a.timeCreated || a.id.localeCompare(b.id))
  return limit === undefined ? sorted : sorted.slice(0, limit)
}
