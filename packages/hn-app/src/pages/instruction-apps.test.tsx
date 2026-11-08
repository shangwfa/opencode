import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, expect, it, vi } from "vitest"
import { instructionApi, type InstructionApp, type InstructionRun } from "@/lib/instruction-apps"
import { automationApi } from "@/lib/automation-apps"
import { InstructionAppDetailPage, InstructionAppsPage } from "./instruction-apps"

vi.mock("@/lib/base-api", () => ({
  baseFetch: vi.fn(async (_path: string, init?: { method?: string }) =>
    init?.method === "POST" ? { session: { id: "ses_new" } } : { items: [] },
  ),
}))
vi.mock("@/lib/instruction-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instruction-apps")>()),
  instructionApi: {
    apps: vi.fn(),
    app: vi.fn(),
    appRuns: vi.fn(),
    runApp: vi.fn(),
    status: vi.fn(),
    runMessages: vi.fn(),
    resume: vi.fn(),
  },
}))
vi.mock("@/lib/automation-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automation-apps")>()),
  automationApi: { fromLegacy: vi.fn() },
}))

const definition = {
  name: "整理订单",
  description: "只读汇总",
  parameters: [],
  instructions: [{ id: "read", title: "读取订单", text: "读取订单并输出汇总" }],
}
const app: InstructionApp = { id: "inst_1", ownerId: "u", definition, version: 2, timeCreated: 0, timeUpdated: 0 }
const queued: InstructionRun = {
  id: "irun_1", appId: app.id, draftId: null, draftHash: null, ownerId: "u", sessionId: "ses_new",
  requestKey: "key", appVersion: 2, definition, parameters: {}, promptId: null, steps: [], status: "queued",
  output: null, error: null, regeneratedVersion: null, timeCreated: 0, timeUpdated: 0,
}
let root: ReturnType<typeof createRoot> | undefined
let element: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  element?.remove()
  vi.clearAllMocks()
})
async function mount(ui: React.ReactNode, initialEntries = ["/"]) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  await act(async () => root?.render(<MemoryRouter initialEntries={initialEntries}>{ui}</MemoryRouter>))
  return element
}
const button = (text: string) =>
  [...element!.querySelectorAll("button")].find((item) => item.textContent?.includes(text))

it("全局列表展示指令应用与版本", async () => {
  vi.mocked(instructionApi.apps).mockResolvedValue({ items: [app] })
  const container = await mount(<InstructionAppsPage />)
  expect(container.textContent).toContain("整理订单")
  expect(container.textContent).toContain("1 个业务步骤")
  expect(container.textContent).toContain("v2")
})

it("成功运行可以生成固定草稿，旧应用本身不被改写", async () => {
  const succeeded: InstructionRun = {
    ...queued, status: "succeeded", steps: [{ index: 0, title: "读取订单", promptId: "msg_1", status: "succeeded", output: "已核对" }],
  }
  vi.mocked(instructionApi.app).mockResolvedValue(app)
  vi.mocked(instructionApi.appRuns).mockResolvedValue({ items: [succeeded] })
  vi.mocked(automationApi.fromLegacy).mockResolvedValue({
    id: "adraft_1", ownerId: "u", sessionId: "ses_new", version: 1, contentHash: "hash", publishedAppId: null,
    timeCreated: 0, timeUpdated: 0, definition: { name: "整理订单", description: "只读汇总", parameters: [], steps: [] },
  })
  const container = await mount(<Routes>
    <Route path="/cdp/instruction-apps/:appId" element={<InstructionAppDetailPage />} />
    <Route path="/cdp/session/:sessionId" element={<p>固定草稿设计台</p>} />
  </Routes>, ["/cdp/instruction-apps/inst_1"])
  await act(async () => button("从成功运行升级为固定流程")!.click())
  expect(automationApi.fromLegacy).toHaveBeenCalledWith(app.id, succeeded.id)
  expect(container.textContent).toContain("固定草稿设计台")
  expect(app.definition.instructions).toHaveLength(1)
})

it("详情页可新建会话运行并显示结果", async () => {
  vi.mocked(instructionApi.app).mockResolvedValue(app)
  vi.mocked(instructionApi.appRuns).mockResolvedValue({ items: [] })
  vi.mocked(instructionApi.runApp).mockResolvedValue(queued)
  vi.mocked(instructionApi.status).mockResolvedValue({
    ...queued, status: "succeeded", output: "订单报告完成", promptId: "msg_1",
  })
  await mount(
    <Routes>
      <Route path="/cdp/instruction-apps/:appId" element={<InstructionAppDetailPage />} />
    </Routes>,
    ["/cdp/instruction-apps/inst_1"],
  )
  expect(element!.textContent).toContain("读取订单并输出汇总")
  await act(async () => button("运行应用")!.click())
  expect(instructionApi.runApp).toHaveBeenCalledWith("inst_1", {
    sessionId: "ses_new",
    requestKey: expect.any(String),
    parameters: {},
    confirmed: false,
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2300)))
  expect(element!.textContent).toContain("订单报告完成")
}, 15_000)

it("详情页按步骤显示执行进度，不跳到会话", async () => {
  const stepped = {
    ...queued,
    status: "running" as const,
    promptId: "msg_2",
    steps: [
      { index: 0, title: "读取订单", promptId: "msg_1", status: "succeeded" as const, output: "**已读取订单**" },
      { index: 1, title: "生成报告", promptId: "msg_2", status: "running" as const, output: null },
    ],
  }
  vi.mocked(instructionApi.app).mockResolvedValue(app)
  vi.mocked(instructionApi.appRuns).mockResolvedValue({ items: [stepped] })
  vi.mocked(instructionApi.runMessages).mockResolvedValue({
    data: [
      { id: "msg_1", type: "assistant", promptMessageID: "msg_1", time: { created: 1, completed: 2 }, content: [{ type: "text", text: "第一步完成" }] },
      { id: "msg_2", type: "assistant", promptMessageID: "msg_2", time: { created: 3 }, content: [{ type: "tool", id: "t1", name: "read", state: { status: "running" } }] },
    ],
  })
  await mount(
    <Routes>
      <Route path="/cdp/instruction-apps/:appId" element={<InstructionAppDetailPage />} />
    </Routes>,
    ["/cdp/instruction-apps/inst_1"],
  )
  await act(async () => new Promise((resolve) => setTimeout(resolve, 200)))
  const progress = element!.querySelector('[aria-label="步骤进度"]')!
  expect(progress.textContent).toContain("读取订单")
  expect(progress.textContent).toContain("已完成")
  expect(progress.textContent).toContain("生成报告")
  expect(progress.textContent).toContain("执行中")
  // 结论优先显示；工具日志折叠在本步骤内，而不是混进结果。
  expect(progress.textContent).toContain("已读取订单")
  expect(progress.querySelector("strong")?.textContent).toBe("已读取订单")
  expect(element!.querySelector('[aria-label="执行过程"]')!.textContent).toContain("read")
  expect(element!.querySelector('details summary')?.textContent).toContain("执行明细")
  expect(element!.textContent).not.toContain("打开会话查看执行过程")
})

it("切换历史运行时只展示所选运行的结果", async () => {
  const old = { ...queued, id: "irun_old", status: "succeeded" as const, steps: [{ index: 0, title: "旧步骤", promptId: "msg_old", status: "succeeded" as const, output: "旧结果" }] }
  const recent = { ...queued, id: "irun_recent", status: "succeeded" as const, steps: [{ index: 0, title: "新步骤", promptId: "msg_new", status: "succeeded" as const, output: "新结果" }] }
  vi.mocked(instructionApi.app).mockResolvedValue(app)
  vi.mocked(instructionApi.appRuns).mockResolvedValue({ items: [recent, old] })
  vi.mocked(instructionApi.runMessages).mockResolvedValue({ data: [] })
  await mount(<Routes><Route path="/cdp/instruction-apps/:appId" element={<InstructionAppDetailPage />} /></Routes>, ["/cdp/instruction-apps/inst_1"])
  const detail = () => element!.querySelector('[aria-label="运行详情"]')!
  expect(detail().textContent).toContain("新结果")
  await act(async () => element!.querySelector("ul li:last-child button")!.dispatchEvent(new MouseEvent("click", { bubbles: true })))
  expect(detail().textContent).toContain("旧结果")
  expect(detail().textContent).not.toContain("新结果")
  expect(instructionApi.runMessages).toHaveBeenCalledWith("irun_old")
})
