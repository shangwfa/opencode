import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, expect, it, vi } from "vitest"
import { automationApi, type AutomationDraft } from "@/lib/automation-apps"
import { baseFetch } from "@/lib/base-api"
import { AppDistill } from "./app-distill"

vi.mock("@/lib/base-api", () => ({ baseFetch: vi.fn() }))
vi.mock("@/lib/base-sse", () => ({ subscribeSessionEvents: vi.fn(() => () => {}) }))
vi.mock("./instruction-drafts", () => ({ InstructionDrafts: () => null }))
vi.mock("@/lib/automation-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automation-apps")>()),
  automationApi: { drafts: vi.fn(), draftRuns: vi.fn(), importDraft: vi.fn(), draftStart: vi.fn(), draftResult: vi.fn() },
}))

const draft: AutomationDraft = {
  id: "adraft_1", ownerId: "u", sessionId: "ses_1", version: 1, contentHash: "hash", publishedAppId: null, timeCreated: 0, timeUpdated: 0,
  definition: { name: "影刀社区最新文章导出Excel", description: "抓取并导出", parameters: [], steps: [
    { id: "scrape", title: "抓取并导出", businessStage: "采集", operation: { type: "script", runtime: "python", source: "print(1)" } },
  ] },
}

let root: ReturnType<typeof createRoot> | undefined
let element: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  element?.remove()
  vi.clearAllMocks()
})

it("入口收起时也会自动导入沙箱草稿，并提示已有草稿", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // 沙箱里有 AI 写好的固定应用请求标记；入口默认是收起状态。
  vi.mocked(baseFetch).mockResolvedValue({ content: JSON.stringify({ ready: true, execution: "fixed", requestedAt: Date.now() }) })
  vi.mocked(automationApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(automationApi.importDraft).mockResolvedValue(draft)
  vi.mocked(automationApi.draftRuns).mockResolvedValue({ items: [] })
  element = document.createElement("div"); document.body.append(element); root = createRoot(element)
  await act(async () => root?.render(<MemoryRouter><AppDistill sessionId="ses_1" /></MemoryRouter>))

  // 即使从未点开「沉淀应用」，导入也必须发生（否则用户会以为 AI 说了却没沉淀）。
  await vi.waitFor(() => expect(automationApi.importDraft).toHaveBeenCalled(), { timeout: 5000 })
  expect(vi.mocked(automationApi.importDraft).mock.calls[0]?.[0]).toBe("ses_1")
  await vi.waitFor(() => expect(element?.textContent).toContain("已生成 1 个应用草稿"), { timeout: 5000 })
  // 自动展开，让用户能看到测试与发布入口。
  expect(element?.textContent).toContain("测试运行")
}, 15_000)
