/** 聊天与浏览器任务共用的侧栏日期分组。 */
export type SessionRow = {
  id: string
  title?: string
  time?: { created?: number; updated?: number }
  [key: string]: unknown
}

export function groupSessions(sessions: readonly SessionRow[], now = new Date()) {
  const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const today = startOfDay(now)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  const groups = ["今天", "昨天", "更早"].map((label) => ({ label, sessions: [] as SessionRow[] }))
  const created = (session: SessionRow) => {
    const value = session.time?.created
    return typeof value === "number" && Number.isFinite(value) ? value : 0
  }

  // 沿用创建时间倒序，不修改接口返回的数组；缺失或无效日期归入“更早”。
  for (const session of [...sessions].sort((a, b) => created(b) - created(a))) {
    const day = startOfDay(new Date(session.time?.created ?? NaN))
    groups[day === today ? 0 : day === yesterday ? 1 : 2]!.sessions.push(session)
  }
  return groups.filter((group) => group.sessions.length > 0)
}
