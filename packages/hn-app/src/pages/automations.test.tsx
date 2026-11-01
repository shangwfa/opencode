import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { automationApi, type AutomationApp, type AutomationRun } from "@/lib/automation-apps"
import { AutomationDetailPage } from "./automations"

vi.mock("@/features/browser-cdp/browser-panel", () => ({ BrowserPanel: () => null }))
vi.mock("@/lib/browser", () => ({ browserApi: { create: vi.fn() } }))
vi.mock("@/lib/base-api", () => ({
  baseFetch: vi.fn(async (_path: string, init?: { method?: string }) =>
    init?.method === "POST" ? { session: { id: "ses_1" } } : { items: [] },
  ),
}))
vi.mock("@/lib/automation-apps", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/automation-apps")>()
  return {
    ...real,
    automationApi: {
      detail: vi.fn(),
      run: vi.fn(),
      status: vi.fn(),
      resume: vi.fn(),
      repair: vi.fn(),
      applyRepair: vi.fn(),
    },
  }
})

const original: AutomationApp = {
  id: "auto_1",
  ownerId: "u",
  version: 1,
  timeCreated: 0,
  timeUpdated: 0,
  definition: {
    name: "界面修复验收",
    description: "失败后 AI 修复并确认更新",
    model: { id: "glm-5.3-flash", providerID: "Yd-GLM" } as AutomationApp["definition"]["model"],
    parameters: [],
    steps: [{ id: "data", title: "计算报告总数", operation: { type: "script", runtime: "python", source: "print(bad)" } }],
  },
}
const repairedOperation = { type: "script" as const, runtime: "python" as const, source: "print(1)" }
let detailApp = original
let state: AutomationRun

function run(over: Partial<AutomationRun>): AutomationRun {
  return {
    id: "arun_1",
    appId: "auto_1",
    ownerId: "u",
    sessionId: "ses_1",
    targetId: null,
    requestKey: "k",
    appVersion: 1,
    definition: original.definition,
    parameters: {},
    status: "queued",
    cursor: 0,
    results: [],
    error: null,
    repairApplied: false,
    timeCreated: 0,
    timeUpdated: 0,
    ...over,
  }
}

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
const button = (text: string) => [...container.querySelectorAll("button")].find((item) => item.textContent?.includes(text))
const text = () => container.textContent ?? ""
async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 150; i++) {
    if (check()) return
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)))
  }
  throw new Error(`等待超时：${label}｜当前内容：${text().replace(/\s+/g, " ").slice(0, 300)}`)
}

beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  detailApp = original
  state = run({
    status: "paused",
    error: "将执行固定的数据处理脚本，可能读写当前会话文件，请确认",
    results: [{ stepId: "data", status: "paused", repairAttempts: 0, pauseReason: "confirmation", error: "将执行固定的数据处理脚本，可能读写当前会话文件，请确认" }],
  })
  vi.mocked(automationApi.detail).mockImplementation(async () => ({ app: detailApp, runs: [] }))
  vi.mocked(automationApi.run).mockResolvedValue(run({ status: "queued" }))
  vi.mocked(automationApi.status).mockImplementation(async () => state)
  vi.mocked(automationApi.resume).mockImplementation(async (_id, action) => {
    const step = state.results[0]
    if (action === "confirm" && step?.pauseReason === "confirmation")
      state = run({
        status: "paused",
        error: "数据处理未完成（退出码 1）",
        results: [{ stepId: "data", status: "paused", repairAttempts: 0, approved: true, pauseReason: "uncertain", error: "数据处理未完成（退出码 1）" }],
      })
    else if (action === "confirm" && step?.pauseReason === "repair_review") {
      detailApp = { ...original, version: 2, definition: { ...original.definition, steps: [{ ...original.definition.steps[0]!, operation: repairedOperation }] } }
      state = run({
        status: "succeeded",
        cursor: 1,
        repairApplied: true,
        results: [{ stepId: "data", status: "succeeded", repairAttempts: 1, repairedOperation, output: '{"total": 3}' }],
      })
    }
    return state
  })
  vi.mocked(automationApi.repair).mockImplementation(async () => {
    // 登记后异步生成：接口立即返回 repairing，随后轮询拿到待审核方案。
    const repairing = run({
      status: "repairing",
      error: "正在生成此步骤的修复方案",
      results: [{ stepId: "data", status: "paused", repairAttempts: 1, pauseReason: "repair_running", error: "正在生成此步骤的修复方案" }],
    })
    state = run({
      status: "paused",
      error: "已生成此步骤的修复方案，请审核固定脚本并确认后执行",
      results: [{ stepId: "data", status: "paused", repairAttempts: 1, pauseReason: "repair_review", repairedOperation, error: "已生成此步骤的修复方案，请审核固定脚本并确认后执行" }],
    })
    return repairing
  })
  vi.mocked(automationApi.applyRepair).mockImplementation(async () => {
    detailApp = { ...original, version: 2, definition: { ...original.definition, steps: [{ ...original.definition.steps[0]!, operation: repairedOperation }] } }
    return { applied: true }
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
        <Routes>
          <Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} />
        </Routes>
      </MemoryRouter>,
    ),
  )
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it("界面完整走通：失败暂停 → AI 修复 → 再次确认 → 成功后自动更新应用", async () => {
  await until(() => !!button("运行应用"), "运行按钮")
  expect(text()).toContain("通过 API 运行")
  expect(text()).toContain("POST /api/automation-apps/auto_1/runs")
  expect(text()).toContain("paused")
  await act(async () => button("运行应用")!.click())
  await until(() => text().includes("请确认"), "确认暂停")
  expect(automationApi.run).toHaveBeenCalledTimes(1)

  await act(async () => button("已核实，确认执行此步")!.click())
  await until(() => text().includes("数据处理未完成"), "失败暂停")
  expect(automationApi.resume).toHaveBeenCalledWith("arun_1", "confirm")
  expect(text()).toContain("v1")

  await until(() => !!button("让 AI 修复此步"), "修复按钮")
  await act(async () => button("让 AI 修复此步")!.click())
  await until(() => text().includes("已生成此步骤的修复方案"), "修复方案待审核")
  expect(automationApi.repair).toHaveBeenCalledWith("arun_1")
  // 修复方案只是候选：确认前应用版本不变、不被调用更新。
  expect(automationApi.applyRepair).not.toHaveBeenCalled()
  expect(detailApp.version).toBe(1)

  await act(async () => button("已核实，确认执行此步")!.click())
  await until(() => text().includes("修复后的运行已完成，应用已更新"), "修复执行成功")
  expect(automationApi.resume).toHaveBeenLastCalledWith("arun_1", "confirm")
  expect(automationApi.applyRepair).not.toHaveBeenCalled()

  expect(button("确认更新应用")).toBeUndefined()
  await until(() => text().includes("v2"), "应用版本升级")
  expect(text()).toContain("v2")
}, 60_000)
