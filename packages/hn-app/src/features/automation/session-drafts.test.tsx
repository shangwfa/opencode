import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, expect, it, vi } from "vitest"
import { automationApi, type AutomationDraft, type AutomationRun } from "@/lib/automation-apps"
import { baseFetch } from "@/lib/base-api"
import { subscribeSessionEvents, type SseEvent } from "@/lib/base-sse"
import { SessionDrafts } from "./session-drafts"

vi.mock("@/lib/base-api", () => ({ baseFetch: vi.fn() }))
vi.mock("@/lib/base-sse", () => ({ subscribeSessionEvents: vi.fn() }))
vi.mock("@/lib/automation-apps", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/automation-apps")>(),
  automationApi: { drafts: vi.fn(), draftStart: vi.fn(), draftResult: vi.fn(), createDraft: vi.fn(), importDraft: vi.fn(), draftRuns: vi.fn(), testDraft: vi.fn(), status: vi.fn(), publishDraft: vi.fn(), resume: vi.fn(), applyDraftRepair: vi.fn(), distill: vi.fn() },
}))

const draft: AutomationDraft = {
  id: "draft_1", ownerId: "u", sessionId: "ses_1", version: 1, contentHash: "hash", publishedAppId: null, timeCreated: 0, timeUpdated: 0,
  definition: { name: "整理订单", description: "只读汇总", parameters: [], steps: [{ id: "open", title: "打开页面", businessStage: "获取订单", operation: { type: "browser", action: "navigate", value: "https://example.com" } }] },
}
const queued: AutomationRun = { id: "run_1", appId: null, draftId: draft.id, draftHash: draft.contentHash, ownerId: "u", sessionId: "ses_1", targetId: null, requestKey: "key", appVersion: 1, definition: draft.definition, parameters: {}, status: "queued", cursor: 0, results: [], error: null, repairApplied: false, timeCreated: 0, timeUpdated: 0 }
let root: ReturnType<typeof createRoot> | undefined
let element: HTMLDivElement | undefined
afterEach(async () => { if (root) await act(async () => root?.unmount()); element?.remove(); vi.clearAllMocks(); vi.mocked(baseFetch).mockReset() })

it("固定脚本标记自动导入草稿并展示待测试步骤", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const requestedAt = Date.now()
  vi.mocked(baseFetch).mockResolvedValue({ content: JSON.stringify({ ready: true, execution: "fixed", requestedAt }) })
  vi.mocked(automationApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(automationApi.importDraft).mockResolvedValue(draft)
  vi.mocked(automationApi.draftRuns).mockResolvedValue({ items: [] })
  element = document.createElement("div"); document.body.append(element); root = createRoot(element)
  await act(async () => root?.render(<MemoryRouter><SessionDrafts sessionId="ses_1" /></MemoryRouter>))
  expect(automationApi.importDraft).toHaveBeenCalledWith("ses_1", `fixed-${requestedAt}`)
  expect(element.textContent).toContain("获取订单")
  expect(element.textContent).toContain("测试运行")
})

it("纯沙箱会话可根据已验证记录生成固定草稿：订阅进度并落库，仍需测试才可发布", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(baseFetch).mockRejectedValue(new Error("没有自动生成标记"))
  vi.mocked(automationApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(automationApi.draftStart).mockResolvedValue({ sessionId: "gen_1", promptId: "msg_gen", sourceSessionId: "ses_1" })
  let emitProgress: ((event: SseEvent) => void) | undefined
  vi.mocked(subscribeSessionEvents).mockImplementation((_sid, onEvent) => { emitProgress = onEvent; return () => {} })
  const results: Array<{ status: "generating" } | { status: "ready"; draft: AutomationDraft }> = [
    { status: "generating" },
    { status: "ready", draft },
  ]
  vi.mocked(automationApi.draftResult).mockImplementation(async () => results.shift() ?? { status: "ready", draft })
  vi.mocked(automationApi.draftRuns).mockResolvedValue({ items: [] })
  element = document.createElement("div"); document.body.append(element); root = createRoot(element)
  await act(async () => root?.render(<MemoryRouter><SessionDrafts sessionId="ses_1" /></MemoryRouter>))
  await act(async () => [...element!.querySelectorAll("button")].find((item) => item.textContent?.includes("根据会话生成固定草稿"))!.click())
  // 临时生成会话必须被订阅，用户才能在对话区看到实时进度而不是“点了没反应”。
  expect(automationApi.draftStart).toHaveBeenCalledWith("ses_1")
  expect(subscribeSessionEvents).toHaveBeenCalledWith("gen_1", expect.any(Function))
  await act(async () => emitProgress?.({ type: "session.reasoning.ended", properties: {} }))
  expect(element.textContent).toContain("正在核对是否有足够证据")
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2600)))
  expect(element.textContent).toContain("测试运行")
  expect(element.textContent).not.toContain("确认结果并创建应用")
  expect(automationApi.draftResult).toHaveBeenCalledWith({ sessionId: "gen_1", promptId: "msg_gen" }, "ses_1")
}, 15_000)

it("会话中读取草稿、测试成功后用户确认创建应用", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(automationApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(automationApi.importDraft).mockResolvedValue(draft)
  vi.mocked(automationApi.draftRuns).mockResolvedValue({ items: [] })
  vi.mocked(automationApi.testDraft).mockResolvedValue(queued)
  vi.mocked(automationApi.status).mockResolvedValue({ ...queued, status: "succeeded", cursor: 1, results: [{ stepId: "open", status: "succeeded", output: "已完成", repairAttempts: 0 }] })
  vi.mocked(automationApi.publishDraft).mockResolvedValue({ id: "app_1", ownerId: "u", definition: draft.definition, version: 1, timeCreated: 0, timeUpdated: 0 })
  element = document.createElement("div"); document.body.append(element); root = createRoot(element)
  await act(async () => root?.render(<MemoryRouter><SessionDrafts sessionId="ses_1" /></MemoryRouter>))
  const button = (text: string) => [...element!.querySelectorAll("button")].find((item) => item.textContent?.includes(text))
  await act(async () => button("读取会话草稿")!.click())
  expect(element.textContent).toContain("获取订单")
  expect(button("确认结果并创建应用")).toBeUndefined()
  await act(async () => button("测试运行")!.click())
  expect(automationApi.testDraft).toHaveBeenCalledWith("draft_1", { version: 1, requestKey: expect.any(String), parameters: {} })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 1700)))
  expect(element.textContent).toContain("运行成功不代表业务结果正确")
  await act(async () => button("确认结果并创建应用")!.click())
  expect(automationApi.publishDraft).toHaveBeenCalledWith("draft_1", 1, "run_1")
  expect(element.textContent).toContain("查看已创建应用")
}, 15_000)

it("跳过动作的测试不能从卡片发布", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(automationApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(automationApi.importDraft).mockResolvedValue(draft)
  vi.mocked(automationApi.draftRuns).mockResolvedValue({ items: [{ ...queued, status: "succeeded", cursor: 1, results: [{ stepId: "open", status: "succeeded", skipped: true, repairAttempts: 0 }] }] })
  element = document.createElement("div"); document.body.append(element); root = createRoot(element)
  await act(async () => root?.render(<MemoryRouter><SessionDrafts sessionId="ses_1" /></MemoryRouter>))
  const importButton = [...element.querySelectorAll("button")].find((item) => item.textContent?.includes("读取会话草稿"))
  await act(async () => importButton!.click())
  expect(element.textContent).not.toContain("确认结果并创建应用")
  expect(automationApi.publishDraft).not.toHaveBeenCalled()
})

it("AI 请求沉淀后由平台自动测试并发布，无需用户再点一次", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const requestedAt = Date.now()
  vi.mocked(baseFetch).mockResolvedValue({ content: JSON.stringify({ ready: true, execution: "fixed", requestedAt }) })
  vi.mocked(automationApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(automationApi.importDraft).mockResolvedValue(draft)
  vi.mocked(automationApi.draftRuns).mockResolvedValue({ items: [] })
  // 第一次 distill 返回 testing，测试成功后第二次返回 published。
  vi.mocked(automationApi.distill)
    .mockResolvedValueOnce({ status: "testing", draftId: draft.id, version: 1, runId: "run_1" })
    .mockResolvedValue({ status: "published", appId: "app_new", runId: "run_1" })
  vi.mocked(automationApi.status).mockResolvedValue({ ...queued, status: "succeeded", cursor: 1,
    results: [{ stepId: "open", status: "succeeded", output: "已完成", repairAttempts: 0 }] })
  element = document.createElement("div"); document.body.append(element); root = createRoot(element)
  await act(async () => root?.render(<MemoryRouter><SessionDrafts sessionId="ses_1" /></MemoryRouter>))

  await vi.waitFor(() => expect(vi.mocked(automationApi.distill)).toHaveBeenCalled(), { timeout: 5000 })
  // 平台自己发起测试并发布，最终给出明确的完成提示。
  await vi.waitFor(() => expect(element?.textContent).toContain("应用已沉淀完成"), { timeout: 8000 })
  expect(vi.mocked(automationApi.distill).mock.calls[0]?.[0]).toBe("ses_1")
  expect(vi.mocked(automationApi.distill).mock.calls[0]?.[1]).toEqual({ draftId: draft.id })
}, 20_000)
