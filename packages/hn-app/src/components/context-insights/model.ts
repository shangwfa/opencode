import type { SessionContextInsights as C } from "@opencode/schema/session-context-insights"

export const categories: C.Category[] = ["system", "tools", "user", "inject", "assistant", "tool"]
export const colors = ["#64748b", "#6366f1", "#0891b2", "#d97706", "#16a34a", "#e11d48"]
export const tokenTotal = (usage: C.Usage) => usage.tokens.input + usage.tokens.output + usage.tokens.reasoning + usage.tokens.cache.read + usage.tokens.cache.write
export const cacheRate = (usage: C.Usage): number | null => {
  const input = usage.tokens.input + usage.tokens.cache.read + usage.tokens.cache.write
  return input ? usage.tokens.cache.read / input : null
}
export const sumUsage = (members: ReadonlyArray<C.SessionCard>) => members.reduce((sum, member) => sum + tokenTotal(member.usage), 0)
export const trendPoints = (points: ReadonlyArray<C.Point>, granularity: "step" | "turn"): C.Point[] => {
  if (granularity === "step") return [...points]
  const turns = new Map<string, C.Point>()
  for (const point of points) turns.set(`${point.request.kind}:${point.turn}`, point)
  const grouped = Array.from(turns.values()).sort((a, b) => a.seq - b.seq)
  return grouped.map((point, index) => ({ ...point, delta: index ? point.request.estimatedTokens - grouped[index - 1].request.estimatedTokens : null }))
}
export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
export const compact = (value: number) => Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value)
export const money = (value: number) => `$${value.toFixed(value < 0.01 ? 6 : 4)}`
/** Coarse elapsed label for session/agent durations. */
export const elapsed = (value: number | null) => {
  if (value === null || !Number.isFinite(value) || value < 0) return "—"
  const seconds = Math.floor(value / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`
}

export const duration = (value: number | null) => value === null ? "—" : value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(1)} s`
/** A line delta is only shown when the input actually described one; absence is not zero. */
export const lineDelta = (file: { readonly added?: number; readonly removed?: number }) =>
  (file.added ?? 0) + (file.removed ?? 0) > 0
export const filterEvents = <T extends { readonly type: string }>(events: ReadonlyArray<T>, type: string) =>
  type === "all" ? [...events] : events.filter((event) => event.type === type)
export const filterFiles = <T extends { readonly path: string; readonly action: string }>(
  files: ReadonlyArray<T>,
  query: string,
  action: string,
) =>
  files.filter(
    (file) => file.path.toLowerCase().includes(query.toLowerCase()) && (action === "all" || file.action === action),
  )

/** Rows arrive newest-first; only the explicit sort modes reorder them. */
export const sortFiles = <T extends { readonly path: string; readonly calls: number; readonly lastSeq: number }>(
  files: ReadonlyArray<T>,
  sort: "recent" | "calls" | "path",
) =>
  sort === "recent"
    ? [...files]
    : [...files].sort(
        sort === "calls" ? (a, b) => b.calls - a.calls || b.lastSeq - a.lastSeq : (a, b) => a.path.localeCompare(b.path),
      )

export type LayoutNode = {
  readonly id: string
  readonly depth: number
  readonly x: number
  readonly parent?: string
  readonly running: boolean
  readonly chain: readonly string[]
}
export type LayoutEdge = { readonly from: string; readonly to: string; readonly running: boolean }
export type FamilyLayout = { readonly nodes: readonly LayoutNode[]; readonly edges: readonly LayoutEdge[] }

/** Tidy tree layout: leaves get sequential columns, parents center over their children. */
export function familyLayout(
  members: ReadonlyArray<{ sessionID: string; parentID: string | null; running: boolean }>,
  rootID: string,
): FamilyLayout {
  const byId = new Map(members.map((m) => [m.sessionID, m]))
  const children = new Map<string, string[]>()
  const roots: string[] = []
  for (const m of members) {
    const parent = m.parentID && byId.has(m.parentID) ? m.parentID : undefined
    if (parent) children.set(parent, [...(children.get(parent) ?? []), m.sessionID])
    else roots.push(m.sessionID)
  }
  const orderedRoots = roots.includes(rootID) ? [rootID, ...roots.filter((id) => id !== rootID)] : roots
  let next = 0
  const pos = new Map<string, number>()
  const depth = new Map<string, number>()
  const chain = new Map<string, string[]>()
  const place = (id: string, d: number, trail: readonly string[]) => {
    depth.set(id, d)
    chain.set(id, [...trail, id])
    const kids = children.get(id) ?? []
    if (kids.length === 0) {
      pos.set(id, next++)
      return
    }
    for (const kid of kids) place(kid, d + 1, [...trail, id])
    const xs = kids.map((kid) => pos.get(kid) ?? 0)
    pos.set(id, (Math.min(...xs) + Math.max(...xs)) / 2)
  }
  for (const root of orderedRoots) place(root, 0, [])
  const nodes: LayoutNode[] = members.map((m) => {
    const parent = m.parentID && byId.has(m.parentID) ? m.parentID : undefined
    return {
      id: m.sessionID,
      depth: depth.get(m.sessionID) ?? 0,
      x: pos.get(m.sessionID) ?? 0,
      running: m.running,
      chain: chain.get(m.sessionID) ?? [m.sessionID],
      ...(parent ? { parent } : {}),
    }
  })
  const edges: LayoutEdge[] = members.flatMap((m) => {
    const parent = m.parentID && byId.has(m.parentID) ? m.parentID : undefined
    return parent ? [{ from: parent, to: m.sessionID, running: m.running }] : []
  })
  return { nodes, edges }
}

export type Preferences = {
  locale: "zh" | "en"
  granularity: "step" | "turn"
  trend: "total" | "delta"
  browser: "list" | "dna"
  /** Default overview window in days; 400 stands for "all" (server caps at 400). */
  overviewRange: 1 | 7 | 30 | 90 | 400
  /** Where the session panel opens from the Context button. */
  placement: "dock" | "dialog"
  /** Show the Agent family tab. */
  fleetTab: boolean
  /** Default ordering of file activity rows. */
  fileSort: "recent" | "calls" | "path"
  /** Trend rendering: bars per request, or one compressed band. */
  trendView: "bars" | "band"
  /** Delta baseline: the previous request, or the first request of the page. */
  deltaBase: "previous" | "session"
  /** Default ordering of tool definition rows. */
  toolSort: "order" | "size" | "name"
  /** Sidebar entry visibility for the overview page. */
  insightsEntry: "show" | "hide"
  /** Show the per-request duration curve under the trend. */
  durationCurve: "show" | "hide"
}
export function readPreferences(): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem("context-insights:v1") ?? "null")
    if (value && typeof value === "object") {
      const data = value as Partial<Preferences>
      return {
        locale: data.locale === "en" ? "en" : "zh",
        granularity: data.granularity === "turn" ? "turn" : "step",
        trend: data.trend === "delta" ? "delta" : "total",
        browser: data.browser === "dna" ? "dna" : "list",
        overviewRange: data.overviewRange === 1 || data.overviewRange === 7 || data.overviewRange === 90 || data.overviewRange === 400
          ? data.overviewRange
          : 30,
        placement: data.placement === "dialog" ? "dialog" : "dock",
        fleetTab: data.fleetTab !== false,
        fileSort: data.fileSort === "calls" || data.fileSort === "path" ? data.fileSort : "recent",
        trendView: data.trendView === "band" ? "band" : "bars",
        deltaBase: data.deltaBase === "session" ? "session" : "previous",
        toolSort: data.toolSort === "size" || data.toolSort === "name" ? data.toolSort : "order",
        insightsEntry: data.insightsEntry === "hide" ? "hide" : "show",
        durationCurve: data.durationCurve === "hide" ? "hide" : "show",
      }
    }
  } catch { /* Preferences are optional; unavailable storage must not break the page. */ }
  return { locale: "zh", granularity: "step", trend: "total", browser: "list", overviewRange: 30, placement: "dock", fleetTab: true, fileSort: "recent", trendView: "bars", deltaBase: "previous", toolSort: "order", insightsEntry: "show", durationCurve: "show" }
}
export function writePreferences(preferences: Preferences) {
  try { localStorage.setItem("context-insights:v1", JSON.stringify(preferences)) } catch { /* Storage is optional. */ }
}

export const labels = {
  zh: { title: "上下文洞察", summary: "组成与趋势", browser: "上下文浏览器", fleet: "Agent 家族", events: "上下文事件", files: "文件活动", refresh: "刷新", retry: "重试", empty: "暂无已采集的请求", historical: "只展示上线后采集的语义请求；估算组成不等于实际计费用量。", incomplete: "含省略或不可见内容", estimate: "输入估算", actual: "实际计费 Token", cost: "预估成本", cache: "缓存命中率", requests: "已采集请求", elapsed: "请求耗时", first: "首内容延迟", model: "模型流耗时", toolsTime: "工具并集耗时", older: "加载更早请求", latest: "最近请求", search: "筛选名称或路径", open: "展开正文", close: "收起正文", omitted: "正文未保留", step: "请求", turn: "轮次末请求", total: "总量", delta: "增量", list: "分类", dna: "模型输入顺序", unknown: "未知", running: "运行中", completed: "已完成", failed: "失败", retried: "已重试", interrupted: "已中断", coverage: "当前请求页事件达到上限，指标可能不完整", scope: "搜索范围（非命中文件）", read: "读取", write: "写入", searchAction: "搜索", nested: "嵌套调用", noEvents: "当前页没有相关事件", noFiles: "当前页没有可归因的文件操作", noFamily: "没有可见的家族成员", overview: "跨会话总览", days: "天", today: "今天", allTime: "全部", wall: "墙钟", heatmap: "每日用量 · UTC 结算事件", selected: "所选时间范围", lifetime: "会话累计", openSession: "查看会话", filtered: "家族可能因权限或数量限制不完整", utc: "按 UTC 结算日归因；缺失的持久化事件不补造为零", back: "返回对话", primary: "主请求", compaction: "压缩", generate: "生成", titleRequest: "标题", system: "系统提示词", tools: "工具定义", user: "用户消息", inject: "指令注入", assistant: "助手消息", tool: "工具结果", mcp: "MCP", sessionTool: "会话工具", all: "全部", remaining: "剩余可用", outputReserve: "输出预留", skills: "技能目录", settings: "设置", placement: "面板位置", dock: "侧栏", dialog: "对话框", calls: "调用次数", notRetained: "正文未保留", attachmentsFilter: "附件", noAttachments: "当前页没有附件", untitled: "未命名附件", ops: "操作日志", totals: "合计", markers: "事件标记", overviewBand: "总览", bars: "柱状", attachments: "附件（仅描述，未存正文）", contextStats: "上下文统计", ceiling: "上下文上限", treemap: "内容分布", introduced: "引入于", pendingInputs: "下一次请求尚未发送的输入", epochs: "提示词/工具集变更", skillTokens: "技能估算", timingStrip: "会话时序", elapsedLabel: "时长", turnsLabel: "轮次", stepsLabel: "请求", injectShort: "注入", compactions: "压缩", skillsCount: "技能", toolCalls: "工具调用", commands: "命令", arguments: "调用参数", insightsEntry: "侧栏入口", deltaBase: "增量基准", previous: "上一请求", durationCurve: "时长曲线", steps: "请求数", window: "窗口占用", source: "来源", sevenDay: "近 7 天用量", donut: "组成合计", live: "实时预览" },
  en: { title: "Context insights", summary: "Composition & trend", browser: "Context browser", fleet: "Agent family", events: "Context events", files: "File activity", refresh: "Refresh", retry: "Retry", empty: "No captured requests", historical: "Captured semantic requests only. Composition estimates are not billed token counts.", incomplete: "Includes omitted or opaque content", estimate: "Estimated input", actual: "Billed tokens", cost: "Estimated cost", cache: "Cache hit rate", requests: "Captured requests", elapsed: "Request elapsed", first: "First content delay", model: "Model stream", toolsTime: "Tool interval union", older: "Load earlier requests", latest: "Latest request", search: "Filter names or paths", open: "Expand content", close: "Collapse content", omitted: "Content not retained", step: "Request", turn: "Last request per turn", total: "Total", delta: "Delta", list: "Categories", dna: "Model input order", unknown: "Unknown", running: "Running", completed: "Completed", failed: "Failed", retried: "Retried", interrupted: "Interrupted", coverage: "Event limit reached for this page; metrics may be incomplete", scope: "Search scope (not matched files)", read: "Read", write: "Write", searchAction: "Search", nested: "Nested calls", noEvents: "No relevant events in this page", noFiles: "No attributable file operations in this page", noFamily: "No visible family members", overview: "Session overview", days: "days", today: "Today", allTime: "All time", wall: "Wall", heatmap: "Daily usage · UTC settlements", selected: "Selected period", lifetime: "Session lifetime", openSession: "Open session", filtered: "Family may be incomplete due to permissions or limits", utc: "Attributed to UTC settlement dates; missing durable events are not invented as zero", back: "Back to chat", primary: "Primary", compaction: "Compaction", generate: "Generation", titleRequest: "Title", system: "System prompt", tools: "Tool schemas", user: "User messages", inject: "Injected instructions", assistant: "Assistant messages", tool: "Tool results", mcp: "MCP", sessionTool: "Session tool", all: "All", remaining: "Remaining window", outputReserve: "Output reserve", skills: "Skill catalog", settings: "Settings", placement: "Panel placement", dock: "Side panel", dialog: "Dialog", calls: "Calls", notRetained: "Body not retained", attachmentsFilter: "Attachments", noAttachments: "No attachments in this page", untitled: "Untitled attachment", ops: "Operation log", totals: "Totals", markers: "Event markers", overviewBand: "Overview", bars: "Bars", attachments: "Attachments (descriptors only)", contextStats: "Context stats", ceiling: "Context ceiling", treemap: "Content map", introduced: "Introduced at", pendingInputs: "Inputs not yet sent", epochs: "Prompt/tool changes", skillTokens: "Skill estimate", timingStrip: "Session timing", elapsedLabel: "Elapsed", turnsLabel: "Turns", stepsLabel: "Requests", injectShort: "Injects", compactions: "Compactions", skillsCount: "Skills", toolCalls: "Tool calls", commands: "Commands", arguments: "Arguments", insightsEntry: "Sidebar entry", deltaBase: "Delta base", previous: "Previous", durationCurve: "Duration curve", steps: "Requests", window: "Window use", source: "Source", sevenDay: "Last 7 days", donut: "Composition", live: "Live preview" },
} as const
export type Labels = { [K in keyof typeof labels.zh]: string }
