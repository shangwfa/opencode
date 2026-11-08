import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { instructionApi, type InstructionDraft, type InstructionRun } from "@/lib/instruction-apps"
import { InstructionDrafts } from "./instruction-drafts"

vi.mock("@/lib/base-api", () => ({
  baseFetch: vi.fn(async () => { throw new Error("missing") }),
}))
vi.mock("@/lib/instruction-apps", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/instruction-apps")>()),
  instructionApi: {
    drafts: vi.fn(),
    generate: vi.fn(),
    draftRuns: vi.fn(),
    testDraft: vi.fn(),
    status: vi.fn(),
    publish: vi.fn(),
    app: vi.fn(),
    runApp: vi.fn(),
    resume: vi.fn(),
  },
}))

const definition = {
  name: "整理订单",
  description: "只读汇总",
  parameters: [],
  instructions: [{ id: "read", title: "读取订单", text: "读取订单并输出汇总" }],
}
const draft: InstructionDraft = {
  id: "idraft_1", ownerId: "u", sessionId: "ses_1", definition, version: 1, contentHash: "hash",
  publishedAppId: null, timeCreated: 0, timeUpdated: 0,
}
const queued: InstructionRun = {
  id: "irun_1", appId: null, draftId: draft.id, draftHash: "hash", ownerId: "u", sessionId: "ses_1",
  requestKey: "key", appVersion: 1, definition, parameters: {}, promptId: null, steps: [], status: "queued",
  output: null, error: null, regeneratedVersion: null, timeCreated: 0, timeUpdated: 0,
}
const succeeded: InstructionRun = { ...queued, promptId: "msg_1", status: "succeeded", output: "订单报告完成" }

let root: ReturnType<typeof createRoot> | undefined
let element: HTMLDivElement | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  element?.remove()
  vi.clearAllMocks()
})

async function mount(onOpenFile?: (path: string) => void) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  element = document.createElement("div")
  document.body.append(element)
  root = createRoot(element)
  await act(async () => root?.render(<InstructionDrafts sessionId="ses_1" onOpenFile={onOpenFile} />))
  return element
}
const button = (text: string) =>
  [...element!.querySelectorAll("button")].find((item) => item.textContent?.includes(text))

it("会话中生成指令草稿，执行成功后确认创建并可再次执行", async () => {
  vi.mocked(instructionApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(instructionApi.generate).mockResolvedValue({ definition, draft })
  vi.mocked(instructionApi.draftRuns).mockResolvedValue({ items: [] })
  vi.mocked(instructionApi.testDraft).mockResolvedValue(queued)
  vi.mocked(instructionApi.status).mockResolvedValue(succeeded)
  vi.mocked(instructionApi.publish).mockResolvedValue({ id: "inst_1", ownerId: "u", definition, version: 1, timeCreated: 0, timeUpdated: 0 })
  vi.mocked(instructionApi.app).mockResolvedValue({ id: "inst_1", ownerId: "u", definition, version: 1, timeCreated: 0, timeUpdated: 0 })
  vi.mocked(instructionApi.runApp).mockResolvedValue({ ...queued, id: "irun_2", appId: "inst_1", draftId: null, draftHash: null })

  const container = await mount()
  await act(async () => button("根据会话生成")!.click())
  expect(container.textContent).toContain("读取订单并输出汇总")
  expect(button("确认结果并创建应用")).toBeUndefined()

  await act(async () => button("测试执行")!.click())
  expect(instructionApi.testDraft).toHaveBeenCalledWith("idraft_1", {
    version: 1,
    requestKey: expect.any(String),
    parameters: {},
    confirmed: false,
  })
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2300)))
  expect(container.textContent).toContain("执行成功不代表业务结果正确")
  expect(button("确认结果并创建应用")!.disabled).toBe(true)
  await act(async () => (container.querySelector('input[type="checkbox"]') as HTMLInputElement).click())
  await act(async () => button("确认结果并创建应用")!.click())
  expect(instructionApi.publish).toHaveBeenCalledWith("idraft_1", 1, "irun_1")
  expect(container.textContent).toContain("应用已创建")
  await act(async () => button("执行应用")!.click())
  expect(instructionApi.runApp).toHaveBeenCalledWith("inst_1", {
    sessionId: "ses_1",
    requestKey: expect.any(String),
    parameters: {},
    confirmed: false,
  })
}, 15_000)

it("刷新后恢复最近草稿及测试结果，切换草稿重置参数", async () => {
  const first = { ...draft, definition: { ...definition, parameters: [{ key: "date", label: "日期", required: true, defaultValue: "今天" }] } }
  const second = { ...first, id: "idraft_2", definition: { ...first.definition, name: "另一个应用", parameters: [{ ...first.definition.parameters[0]!, defaultValue: "明天" }] } }
  const published = { ...second, id: "idraft_0", publishedAppId: "inst_1" }
  vi.mocked(instructionApi.drafts).mockResolvedValue({ items: [first, second, published] })
  vi.mocked(instructionApi.draftRuns).mockResolvedValue({ items: [succeeded] })
  vi.mocked(instructionApi.app).mockResolvedValue({ id: "inst_1", ownerId: "u", definition: second.definition, version: 1, timeCreated: 0, timeUpdated: 0 })
  const container = await mount()
  expect(container.textContent).toContain("订单报告完成")
  // 优先恢复最近更新的草稿，避免新的修订被旧应用遮住。
  expect((container.querySelector("select") as HTMLSelectElement).value).toBe("idraft_1")
  const select = container.querySelector("select")!
  await act(async () => { select.value = second.id; select.dispatchEvent(new Event("change", { bubbles: true })) })
  expect((container.querySelector('input:not([type="checkbox"])') as HTMLInputElement).value).toBe("明天")
})

it("显示测试使用的输入，并提示当前输入与测试结果不一致", async () => {
  const withInput = { ...draft, definition: { ...definition, parameters: [{ key: "date", label: "日期", required: true, defaultValue: "明天" }] } }
  const previous = { ...succeeded, definition: withInput.definition, parameters: { date: "今天" } }
  vi.mocked(instructionApi.drafts).mockResolvedValue({ items: [withInput] })
  vi.mocked(instructionApi.draftRuns).mockResolvedValue({ items: [previous] })
  const container = await mount()
  expect(container.textContent).toContain("当前输入已修改")
  expect(container.textContent).toContain("日期：今天")
  expect(button("重新测试")).toBeDefined()
  expect(button("确认结果并创建应用")?.disabled).toBe(true)
})

it("从测试结果打开本次运行的隔离产物", async () => {
  const verified = { ...draft, definition: { ...definition, verification: { path: "output/report.json" } } }
  vi.mocked(instructionApi.drafts).mockResolvedValue({ items: [verified] })
  vi.mocked(instructionApi.draftRuns).mockResolvedValue({ items: [{ ...succeeded, definition: verified.definition }] })
  const open = vi.fn()
  await mount(open)
  await act(async () => button("查看本次产物")!.click())
  expect(open).toHaveBeenCalledWith("/workspace/output/automation/irun_1/output/report.json")
})

it("高风险指令必须勾选确认后才能执行", async () => {
  const guarded = {
    ...draft,
    definition: { ...draft.definition, instructions: [{ ...draft.definition.instructions[0]!, requiresConfirmation: true }] },
  }
  vi.mocked(instructionApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(instructionApi.generate).mockResolvedValue({ definition: guarded.definition, draft: guarded })
  vi.mocked(instructionApi.draftRuns).mockResolvedValue({ items: [] })
  vi.mocked(instructionApi.testDraft).mockResolvedValue(queued)

  const container = await mount()
  await act(async () => button("根据会话生成")!.click())
  expect(container.textContent).toContain("需确认")
  expect(button("测试执行")!.disabled).toBe(true)
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement
  await act(async () => checkbox.click())
  expect(button("测试执行")!.disabled).toBe(false)
  await act(async () => button("测试执行")!.click())
  expect(instructionApi.testDraft).toHaveBeenCalledWith("idraft_1", expect.objectContaining({ confirmed: true }))
}, 15_000)

it("会话写入生成请求后卡片自动生成草稿", async () => {
  const { baseFetch } = await import("@/lib/base-api")
  vi.mocked(baseFetch).mockResolvedValueOnce({ content: JSON.stringify({ ready: true, execution: "instruction", requestedAt: Date.now() }) } as never)
  vi.mocked(instructionApi.drafts).mockResolvedValueOnce({ items: [] }).mockResolvedValue({ items: [draft] })
  vi.mocked(instructionApi.generate).mockResolvedValue({ definition, draft })
  vi.mocked(instructionApi.draftRuns).mockResolvedValue({ items: [] })

  const container = await mount()
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(instructionApi.generate).toHaveBeenCalledWith("ses_1", expect.stringMatching(/^marker-/))
  expect(container.textContent).toContain("已生成业务应用草稿")
}, 15_000)

it("应用脚本写同名标记不会被误判成生成请求", async () => {
  const { baseFetch } = await import("@/lib/base-api")
  // 登记类应用的产物：只有 ready/requestedAt，没有 execution 声明
  vi.mocked(baseFetch).mockResolvedValueOnce({ content: JSON.stringify({ ready: true, requestedAt: Date.now() }) } as never)
  vi.mocked(instructionApi.drafts).mockResolvedValue({ items: [] })
  await mount()
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
  expect(instructionApi.generate).not.toHaveBeenCalled()
}, 15_000)

it("执行报错时提示已自动重新生成，并要求重新执行", async () => {
  vi.mocked(instructionApi.drafts).mockResolvedValue({ items: [] })
  vi.mocked(instructionApi.generate).mockResolvedValue({ definition, draft })
  vi.mocked(instructionApi.draftRuns).mockResolvedValue({ items: [] })
  vi.mocked(instructionApi.testDraft).mockResolvedValue(queued)
  vi.mocked(instructionApi.status).mockResolvedValue({
    ...queued,
    status: "failed",
    error: "找不到订单表\n\n已根据错误自动重新生成应用定义 v2，请审阅后再次运行。",
    regeneratedVersion: 2,
  })

  const container = await mount()
  await act(async () => button("根据会话生成")!.click())
  await act(async () => button("测试执行")!.click())
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2300)))
  expect(container.textContent).toContain("已生成待审核草稿 v2")
  expect(button("确认结果并创建应用")).toBeUndefined()
  expect(instructionApi.publish).not.toHaveBeenCalled()
}, 15_000)
