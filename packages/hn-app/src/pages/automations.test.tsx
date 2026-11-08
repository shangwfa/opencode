import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { automationApi, repairSaveNotice, stepDisplayStatus, type AutomationApp, type AutomationRun } from "@/lib/automation-apps"
import { instructionApi } from "@/lib/instruction-apps"
import { browserApi } from "@/lib/browser"
import { AutomationDetailPage, AutomationsPage } from "./automations"

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
       list: vi.fn(),
      detail: vi.fn(),
      run: vi.fn(),
      status: vi.fn(),
      resume: vi.fn(),
      repair: vi.fn(),
      applyRepair: vi.fn(),
    },
  }
})
vi.mock("@/lib/instruction-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instruction-apps")>()),
  instructionApi: { apps: vi.fn() },
}))

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
  vi.mocked(automationApi.list).mockResolvedValue({ items: [original] })
  vi.mocked(instructionApi.apps).mockResolvedValue({ items: [] })
  vi.mocked(browserApi.create).mockResolvedValue({ session: { id: "ses_1" } } as Awaited<ReturnType<typeof browserApi.create>>)
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
       // 后端在运行成功时自动固化修复；前端轮询拿到的是已保存后的状态。
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
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it("统一入口同时列出固定流程和旧版 AI 应用，保留旧详情地址", async () => {
  vi.mocked(instructionApi.apps).mockResolvedValue({ items: [{
    id: "inst_1", ownerId: "u", version: 1, timeCreated: 0, timeUpdated: 0,
    definition: { name: "旧版订单整理", description: "旧指令", parameters: [], instructions: [{ id: "read", title: "读取", text: "读取订单" }] },
  }] })
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps"]}><Routes><Route path="/cdp/apps" element={<AutomationsPage />} /></Routes></MemoryRouter>))
  await until(() => container.textContent?.includes("旧版订单整理") ?? false, "旧版应用加载")
  expect(container.querySelector('a[href="/cdp/apps/auto_1"]')?.textContent).toContain("固定流程")
  expect(container.querySelector('a[href="/cdp/instruction-apps/inst_1"]')?.textContent).toContain("待升级 · AI 执行")
})

it("运行后在同一份步骤列表显示逐步状态，不重复展示执行步骤", async () => {
  detailApp = { ...original, definition: { ...original.definition, steps: [
    { id: "visit", title: "访问页面", operation: { type: "browser", action: "navigate", value: "https://example.com" } },
    { id: "extract", title: "提取数据", operation: { type: "browser", action: "extract", selector: "h1" } },
  ] } }
  vi.mocked(automationApi.run).mockResolvedValue(run({ status: "queued", definition: detailApp.definition }))
  state = run({ status: "running", definition: detailApp.definition, cursor: 1,
    results: [{ stepId: "visit", status: "succeeded", output: "页面已打开", repairAttempts: 0 }],
  })
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  await until(() => !!button("运行应用"), "运行按钮")
  expect(container.querySelectorAll('section[aria-label="运行详情"]')).toHaveLength(0)
  expect(container.querySelectorAll("ol > li")).toHaveLength(2)
  await act(async () => button("运行应用")!.click())
  await until(() => text().includes("已完成 1/2"), "步骤推进")
  expect(container.querySelectorAll("ol")).toHaveLength(1)
  expect(container.querySelectorAll("ol > li")).toHaveLength(2)
  expect(text()).toContain("执行中")
  expect(text()).toContain("已完成")
})

it("当前步骤执行时后续步骤只显示待执行，暂停和修复只属于当前步骤", async () => {
  const steps = [
    { id: "compute", title: "计算乘积", operation: { type: "script" as const, runtime: "python" as const, source: "print(42)" } },
    { id: "write", title: "生成报告", operation: { type: "script" as const, runtime: "python" as const, source: "print(42)" } },
    { id: "ready", title: "就绪登记", operation: { type: "script" as const, runtime: "python" as const, source: "print(42)" } },
  ]
  detailApp = { ...original, definition: { ...original.definition, steps } }
  const stale = [{ stepId: "compute", status: "running" as const, repairAttempts: 0 },
    { stepId: "write", status: "paused" as const, repairAttempts: 0 },
    { stepId: "ready", status: "paused" as const, repairAttempts: 0 }]
  state = run({ status: "running", definition: detailApp.definition, cursor: 0, results: stale })
  expect(steps.map((_, index) => stepDisplayStatus(state, index))).toEqual(["执行中", "待执行", "待执行"])
  vi.mocked(automationApi.run).mockResolvedValue(state)
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  await until(() => !!button("运行应用"), "运行按钮")
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
  await act(async () => button("运行应用")!.click())
  await until(() => text().includes("正在执行"), "运行状态")
  expect([...container.querySelectorAll("ol > li")].map((item) => item.textContent?.match(/执行中|已暂停|待执行/)?.[0])).toEqual(["执行中", "待执行", "待执行"])
  state = run({ ...state, status: "paused", cursor: 1, results: [
    { stepId: "compute", status: "succeeded", repairAttempts: 0 },
    { stepId: "write", status: "paused", repairAttempts: 0 },
    { stepId: "ready", status: "paused", repairAttempts: 0 },
  ] })
  expect(steps.map((_, index) => stepDisplayStatus(state, index))).toEqual(["已完成", "已暂停", "待执行"])
  expect(stepDisplayStatus({ ...state, status: "repairing" }, 1)).toBe("修复中")
})

it("步骤详情直接展示，过长省略并可 hover 查看全文", async () => {
  detailApp = { ...original, definition: { ...original.definition, steps: [
    { id: "open", title: "打开影刀社区文章频道并与当前页面元素进行核对", operation: { type: "browser", action: "navigate", value: "https://www.yingdao.com/community/" } },
  ] } }
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  await until(() => text().includes("打开影刀社区文章频道"), "步骤详情直出")
  // 不再需要展开：没有「查看执行细节」折叠，详情文本直接在文档里。
  expect(text()).not.toContain("查看执行细节")
  const detail = [...container.querySelectorAll("p")].find((item) => item.textContent?.includes("打开影刀社区文章频道"))!
  expect(detail.className).toContain("truncate")
  expect(detail.getAttribute("title")).toContain("网页操作")
})

it("执行中的指令自动展开详情，执行完成后自动收起", async () => {
  detailApp = { ...original, definition: { ...original.definition, steps: [
    { id: "a", title: "生成数据", businessStage: "准备数据", operation: { type: "script", runtime: "python", source: "print(1)" } },
    { id: "b", title: "汇总", businessStage: "统计", operation: { type: "script", runtime: "python", source: "print(2)" } },
  ] } }
  const output = "wrote output/orders_a.csv\ndata rows: 6"
  state = run({ status: "running", definition: detailApp.definition, cursor: 0,
    results: [{ stepId: "a", status: "running", repairAttempts: 0, output }] })
  vi.mocked(automationApi.status).mockImplementation(async () => state)
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1?run=arun_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  // 执行中：无需点击，详情已展开。
  await until(() => text().includes("data rows: 6"), "执行中自动展开")
  expect(button("收起执行详情")).toBeDefined()

  // 该阶段完成后：自动收起，输出不再直接铺开。
  state = run({ status: "running", definition: detailApp.definition, cursor: 1,
    results: [{ stepId: "a", status: "succeeded", repairAttempts: 0, output }, { stepId: "b", status: "running", repairAttempts: 0 }] })
  await until(() => !text().includes("data rows: 6"), "完成后自动收起")
  expect(button("查看执行详情")).toBeDefined()
})

it("执行详情就地展开在指令卡片内，可展开与收起", async () => {
  detailApp = { ...original, definition: { ...original.definition, steps: [
    { id: "a", title: "生成数据", businessStage: "准备数据", operation: { type: "script", runtime: "python", source: "print(1)" } },
  ] } }
  const output = "wrote output/orders_a.csv\ndata rows: 6"
  state = run({ status: "succeeded", definition: detailApp.definition, cursor: 1,
    results: [{ stepId: "a", status: "succeeded", repairAttempts: 0, output }] })
  vi.mocked(automationApi.status).mockImplementation(async () => state)
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1?run=arun_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  await until(() => !!button("查看执行详情"), "详情入口")
  // 默认收起：卡片内无输出，右侧也没有独立详情面板。
  expect(text()).not.toContain("data rows: 6")
  expect(container.querySelector('section[aria-label="执行详情"]')).toBeNull()
  await act(async () => button("查看执行详情")!.click())
  await until(() => text().includes("data rows: 6"), "详情展开")
  // 详情就在步骤卡片自身的列表项里，不另开面板。
  expect(container.querySelector('section[aria-label="执行详情"]')).toBeNull()
  const item = [...container.querySelectorAll("ol > li")].find((node) => node.textContent?.includes("准备数据"))!
  expect(item.textContent).toContain("data rows: 6")
  expect(item.closest("aside")).toBeNull()
  await act(async () => button("收起执行详情")!.click())
  await until(() => !text().includes("data rows: 6"), "详情收起")
})

it("业务阶段之间用连接线连成时间线，最后一段无尾线", async () => {
  detailApp = { ...original, definition: { ...original.definition, steps: [
    { id: "a", title: "生成数据", businessStage: "准备数据", operation: { type: "script", runtime: "python", source: "print(1)" } },
    { id: "b", title: "合并去重", businessStage: "整理数据", operation: { type: "script", runtime: "python", source: "print(2)" } },
    { id: "c", title: "生成报告", businessStage: "输出报告", operation: { type: "script", runtime: "python", source: "print(3)" } },
  ] } }
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  await until(() => text().includes("准备数据"), "阶段列表")
  const items = [...container.querySelectorAll("ol > li")]
  expect(items).toHaveLength(3)
  // 前两段有连接线，最后一段没有。
  expect(items[0]!.querySelector('[aria-hidden][class*="start-"]')).not.toBeNull()
  expect(items[1]!.querySelector('[aria-hidden][class*="start-"]')).not.toBeNull()
  expect(items[2]!.querySelector('[aria-hidden][class*="start-"]')).toBeNull()
  // 连接线是垂直的细线，视觉上把节点串起来。
  expect(items[0]!.querySelector('[aria-hidden][class*="w-px"]')).not.toBeNull()
})

it("加载时显示贴合布局的骨架屏，而不是一行灰字", async () => {
  let resolveDetail: ((value: { app: AutomationApp; runs: AutomationRun[] }) => void) | undefined
  vi.mocked(automationApi.detail).mockImplementation(
    () => new Promise((resolve) => { resolveDetail = resolve }),
  )
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  await until(() => !!container.querySelector('[aria-busy="true"]'), "加载骨架")
  const status = container.querySelector('[role="status"]')!
  expect(status.getAttribute("aria-busy")).toBe("true")
  // 骨架由多个占位块组成，而非单行文字。
  expect(status.querySelectorAll(".animate-pulse [class*='bg-slate-200'], .animate-pulse .bg-slate-300\\/70").length).toBeGreaterThan(5)
  expect(status.textContent).toContain("正在加载应用")
  await act(async () => resolveDetail!({ app: original, runs: [] }))
  await until(() => !!button("运行应用"), "加载完成")
  expect(container.querySelector('[aria-busy="true"]')).toBeNull()
})

it("长业务说明默认收起，运行状态保留在首屏摘要", async () => {
  detailApp = { ...original, definition: { ...original.definition, description: "完成一次数据处理；脚本路径和产物写入等较长的技术细节" } }
  await act(async () => root.render(<MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
    <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
  </MemoryRouter>))
  await until(() => text().includes("完成一次数据处理"), "业务摘要")
  const description = [...container.querySelectorAll("details")].find((item) => item.textContent?.includes("查看完整业务说明"))
  expect(description?.open).toBe(false)
  expect(description?.textContent).toContain("脚本路径和产物")
  // 未运行时只说明阶段数，不显示“等待启动/待执行”这类未发生状态。
  expect(text()).toContain("1 个业务阶段")
  expect(text()).not.toContain("等待启动")
  expect(text()).not.toContain("待执行")
})

it("界面完整走通：失败暂停 → AI 修复 → 继续执行 → 确认更新应用", async () => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/cdp/apps/auto_1"]}>
      <Routes><Route path="/cdp/apps/:automationId" element={<AutomationDetailPage />} /></Routes>
    </MemoryRouter>,
  ))
  await until(() => !!button("运行应用"), "运行按钮")
  expect(text()).toContain("通过 API 运行")
  expect(text()).toContain("POST /api/automation-apps/auto_1/runs")
  expect(text()).toContain("paused")
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
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
  await until(() => text().includes("修复已自动保存为新版本"), "修复自动保存")
  expect(automationApi.resume).toHaveBeenLastCalledWith("arun_1", "confirm")
  // 自动保存，无需手动点「确认更新应用」。
  expect(button("确认更新应用")).toBeUndefined()
  expect(detailApp.version).toBe(2)
  expect(text()).toContain("v2")
}, 60_000)

it("修复保存提示：重跑成功为已保存，含跳过步骤则不保存", () => {
  const verified = run({ status: "succeeded", repairApplied: true, results: [{ stepId: "data", status: "succeeded", repairAttempts: 1, repairedOperation }] })
  expect(repairSaveNotice(verified)).toBe("saved")
  const skipped = run({ status: "succeeded", results: [
    { stepId: "data", status: "succeeded", skipped: true, repairAttempts: 1, repairedOperation },
  ] })
  expect(repairSaveNotice(skipped)).toBe("skipped")
  expect(repairSaveNotice(run({ status: "succeeded", results: [{ stepId: "data", status: "succeeded", repairAttempts: 0 }] }))).toBeNull()
})
