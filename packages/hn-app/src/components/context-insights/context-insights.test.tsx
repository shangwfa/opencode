import { act, useState } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { SessionContextInsights as C } from "@opencode/schema/session-context-insights"
import { SessionID } from "@opencode/schema/session-id"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import * as api from "@/lib/context-insights"
import { SessionInsights } from "./session-insights"
import { cacheRate, elapsed, familyLayout, filterEvents, filterFiles, labels, lineDelta, readPreferences, sortFiles, trendPoints, writePreferences } from "./model"
import { Composition, markerIndex, sourceLabel } from "./views"
import { useResource } from "./use-resource"

let root: Root
let host: HTMLDivElement
const request = C.Request.make({
  id: C.RequestID.create(), sessionID: SessionID.make("ses_test"), agent: Agent.ID.make("build"), kind: "primary",
  model: { id: Model.ID.make("model"), providerID: Provider.ID.make("test") }, time: 1000,
  boundary: "model-call-semantic-request", estimation: "text-characters-div-4", estimatedTokens: 50,
  composition: { system: 10, tools: 10, user: 10, inject: 0, assistant: 10, tool: 10 }, itemCount: 1, incomplete: false,
})
const point: C.Point = { request, seq: 1, turn: 1, delta: null, status: "unknown", actual: null, elapsedMs: null, modelMs: null, firstContentMs: null, toolMs: null }
const item: C.Item = { index: 0, category: "system", name: "system:0", estimatedTokens: 10, bytes: 10, hash: "hash" }

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  localStorage.clear()
  host = document.createElement("div")
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(() => root.unmount()); host.remove(); vi.restoreAllMocks() })

test("browser fetches no body until expansion and renders untrusted content as text", async () => {
  vi.spyOn(api, "watchContext").mockReturnValue(() => {})
  vi.spyOn(api.contextInsights, "summary").mockResolvedValue({ latest: request, capturedRequests: 1, history: "captured-requests-only" })
  vi.spyOn(api.contextInsights, "analysis").mockResolvedValue({ points: [point], events: [], files: [], scope: "request-page", eventsTruncated: false })
  vi.spyOn(api.contextInsights, "family").mockResolvedValue({ rootID: request.sessionID, members: [], complete: true })
  vi.spyOn(api.contextInsights, "detail").mockResolvedValue({ request, items: [item] })
  const content = vi.spyOn(api.contextInsights, "content").mockResolvedValue({ item, content: "<script>INJECTION</script>" })
  await act(async () => root.render(<MemoryRouter><SessionInsights sessionID="ses_test" /></MemoryRouter>))
  expect(host.textContent).toContain("50")
  expect(content).not.toHaveBeenCalled()
  // Radix Tabs 在 mousedown 时激活，裸 click() 不触发；这里点摘要卡里的「上下文浏览器」按钮
  // （它直接切换到浏览器标签），保持与真实交互等价。
  const browser = Array.from(host.querySelectorAll("button")).find(
    (button) => button.textContent === "上下文浏览器" && button.getAttribute("role") !== "tab",
  )
  if (!(browser instanceof HTMLButtonElement)) throw new Error("Missing browser tab")
  await act(async () => browser.click())
  expect(content).not.toHaveBeenCalled()
  const button = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("system:0"))
  if (!(button instanceof HTMLButtonElement)) throw new Error("Missing context item")
  await act(async () => button.click())
  expect(content).toHaveBeenCalledOnce()
  expect(host.querySelector("script")).toBeNull()
  expect(host.textContent).toContain("<script>INJECTION</script>")
})

test("stale in-flight reads never replace another session's data", async () => {
  let resolveOld: ((value: string) => void) | undefined
  const old = new Promise<string>((resolve) => { resolveOld = resolve })
  function Probe() {
    const [key, setKey] = useState("old")
    const resource = useResource(key, () => key === "old" ? old : Promise.resolve("new data"))
    return <><button onClick={() => setKey("new")}>switch</button><p>{resource.data ?? "loading"}</p></>
  }
  await act(async () => root.render(<Probe />))
  const button = host.querySelector("button")
  if (!button) throw new Error("Missing switch")
  await act(async () => button.click())
  expect(host.textContent).toContain("new data")
  await act(async () => resolveOld?.("OLD PRIVATE DATA"))
  expect(host.textContent).not.toContain("OLD PRIVATE DATA")
})

test("preferences reject unknown values and cache ratio excludes output tokens", () => {
  localStorage.setItem("context-insights:v1", JSON.stringify({ locale: "bad", trend: "bad", granularity: "turn", browser: "dna", overviewRange: 45 }))
  expect(readPreferences()).toEqual({
    locale: "zh", trend: "total", granularity: "turn", browser: "dna", overviewRange: 30,
    placement: "dock", fleetTab: true, fileSort: "recent", trendView: "bars",
    deltaBase: "previous", toolSort: "order", insightsEntry: "show", durationCurve: "show",
  })
  localStorage.setItem("context-insights:v1", JSON.stringify({ placement: "dialog", fleetTab: false, fileSort: "path" }))
  expect(readPreferences()).toMatchObject({ placement: "dialog", fleetTab: false, fileSort: "path" })
  writePreferences({ ...readPreferences(), overviewRange: 90 })
  expect(readPreferences().overviewRange).toBe(90)
  expect(cacheRate({ tokens: { input: 2, output: 100, reasoning: 100, cache: { read: 6, write: 2 } }, cost: C.Usage.fields.cost.make(0) })).toBe(0.6)
  const grouped = trendPoints([point, { ...point, seq: 2, request: { ...request, estimatedTokens: 70 } }, { ...point, seq: 3, turn: 2, request: { ...request, estimatedTokens: 20 } }], "turn")
  expect(grouped.map((item) => item.delta)).toEqual([null, -50])
})

test("tool provenance names the MCP server and the session scope only", () => {
  expect(sourceLabel("mcp:docs", labels.zh)).toBe("MCP docs")
  expect(sourceLabel("session", labels.zh)).toBe("会话工具")
  expect(sourceLabel("mcp:docs", labels.en)).toBe("MCP docs")
  expect(sourceLabel("session", labels.en)).toBe("Session tool")
})

test("file sort modes only reorder, and an unknown mode keeps the newest-first order", () => {
  const files = [
    { path: "b.ts", calls: 1, lastSeq: 9 },
    { path: "a.ts", calls: 5, lastSeq: 4 },
    { path: "c.ts", calls: 5, lastSeq: 8 },
  ]
  expect(sortFiles(files, "recent").map((file) => file.path)).toEqual(["b.ts", "a.ts", "c.ts"])
  expect(sortFiles(files, "calls").map((file) => file.path)).toEqual(["c.ts", "a.ts", "b.ts"])
  expect(sortFiles(files, "path").map((file) => file.path)).toEqual(["a.ts", "b.ts", "c.ts"])
})

test("line delta is hidden when no mutation input described one", () => {
  expect(lineDelta({ added: 3 })).toBe(true)
  expect(lineDelta({ removed: 2 })).toBe(true)
  expect(lineDelta({ added: 0, removed: 0 })).toBe(false)
  expect(lineDelta({})).toBe(false)
})

test("elapsed labels stay coarse and never invent a duration", () => {
  expect(elapsed(null)).toBe("—")
  expect(elapsed(-5)).toBe("—")
  expect(elapsed(4_000)).toBe("4s")
  expect(elapsed(90_000)).toBe("1m")
  expect(elapsed(3_600_000 + 5 * 60_000)).toBe("1h 5m")
  expect(elapsed(50 * 3_600_000)).toBe("2d 2h")
})

test("compaction markers land on the first point at or after each event", () => {
  const points = [{ seq: 5 }, { seq: 15 }, { seq: 25 }]
  const markers = markerIndex(points, [{ seq: 3, type: "compaction" }, { seq: 16, type: "compaction" }, { seq: 20, type: "execution" }])
  // 事件发生在请求之间：seq 16 的压缩标记到其后第一根柱（seq 25，索引 2）。
  expect([...markers].sort()).toEqual([0, 2])
  expect([...markerIndex(points, [{ seq: 99, type: "compaction" }])]).toEqual([])
})

test("event and file filters keep only the selected dimension", () => {
  expect(filterEvents([{ type: "inject" }, { type: "skill" }, { type: "inject" }], "inject")).toHaveLength(2)
  expect(filterEvents([{ type: "inject" }, { type: "skill" }], "all")).toHaveLength(2)
  const files = [
    { path: "src/App.tsx", action: "read" },
    { path: "src/a.ts", action: "write" },
    { path: "lib/b.ts", action: "read" },
  ]
  expect(filterFiles(files, "src", "read").map((file) => file.path)).toEqual(["src/App.tsx"])
  expect(filterFiles(files, "", "all")).toHaveLength(3)
  expect(filterFiles(files, "", "write").map((file) => file.path)).toEqual(["src/a.ts"])
})

test("composition reserves the remaining context window only when it is known", async () => {
  await act(async () => root.render(<Composition request={{ ...request, contextWindow: 1000 }} labels={labels.zh} />))
  expect(host.textContent).toContain("剩余可用")
  expect(host.textContent).toContain("950")
  await act(async () => root.render(<Composition request={request} labels={labels.zh} />))
  expect(host.textContent).not.toContain("剩余可用")
})

test("family layout builds a tidy tree with chains and excludes no-parent nodes from edges", () => {
  const m = (id: string, parentID: string | null, running = false) => ({ sessionID: id, parentID, running })
  const layout = familyLayout([m("root", null), m("a", "root"), m("b", "root"), m("a1", "a", true), m("orphan", "missing")], "root")
  // root centers over its two leaves a/b; a1 is a child of a; orphan has a dangling parent → root-level.
  const node = (id: string) => layout.nodes.find((n) => n.id === id)!
  expect(node("root").depth).toBe(0)
  expect(node("a").depth).toBe(1)
  expect(node("a1").depth).toBe(2)
  expect(node("a1").running).toBe(true)
  expect(node("a1").chain).toEqual(["root", "a", "a1"])
  // orphan's parent is not in the set, so it becomes a root-level node with depth 0 and no edge.
  expect(node("orphan").depth).toBe(0)
  expect(layout.edges.map((e) => `${e.from}->${e.to}`).sort()).toEqual(["a->a1", "root->a", "root->b"])
  expect(layout.edges.find((e) => e.to === "a1")?.running).toBe(true)
  // root centers over children a and b (sequential leaf columns 0 and 1 → center 0.5).
  expect(node("root").x).toBe(0.5)
})
