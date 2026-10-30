import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes, useLocation } from "react-router"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { browserApi } from "@/lib/browser"
import { CdpHome } from "./home"

vi.mock("@/hooks/use-provider-list", () => ({
  useProviderList: () => ({ providers: { all: [{ id: "test", models: { chat: { name: "测试模型" } } }] } }),
  pickFirstModel: () => ({ providerID: "test", modelID: "chat" }),
}))
vi.mock("@/context/local", () => ({ useLocal: () => ({ model: { current: () => undefined, set: vi.fn() } }) }))
vi.mock("@/lib/browser", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/browser")>(),
  browserApi: { scripts: vi.fn(), create: vi.fn() },
}))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
function Destination() {
  const location = useLocation()
  return <pre data-testid="destination">{JSON.stringify({ path: location.pathname, state: location.state })}</pre>
}
const editor = () => container.querySelector("textarea")!
const start = () => container.querySelector<HTMLButtonElement>('[aria-label="开始浏览器任务"]')!
async function fill(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor(), text)
    editor().dispatchEvent(new Event("input", { bubbles: true }))
  })
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  vi.mocked(browserApi.scripts).mockResolvedValue({ items: [] })
  vi.mocked(browserApi.create).mockResolvedValue({ session: { id: "ses_browser" }, status: "preparing", ready: false, error: null })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<MemoryRouter><Routes><Route path="/" element={<CdpHome />} /><Route path="/cdp/session/:id" element={<Destination />} /></Routes></MemoryRouter>))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it("空任务禁用开始，示例入口可填入任务且保留模型选择入口", async () => {
  expect(start().disabled).toBe(true)
  const example = [...container.querySelectorAll("button")].find((button) => button.textContent?.includes("浏览与信息整理"))!
  await act(async () => example.click())
  expect(editor().value).toContain("https://example.com")
  expect(start().disabled).toBe(false)
  expect(container.querySelector('[aria-label="选择浏览器任务模型"]')).not.toBeNull()
})

it("不再展示执行流程与 UI 走查入口；输入法确认及换行不创建任务，提交携带原任务和模型", async () => {
  expect([...container.querySelectorAll("button")].some((button) => /执行流程|UI 走查/.test(button.textContent ?? ""))).toBe(false)
  await fill("检查 https://example.com")
  await act(async () => {
    editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }))
    editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }))
    editor().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }))
  })
  expect(browserApi.create).not.toHaveBeenCalled()
  await act(async () => start().click())
  expect(browserApi.create).toHaveBeenCalledWith({ title: "检查 https://example.com" })
  expect(JSON.parse(container.querySelector('[data-testid="destination"]')!.textContent!)).toEqual({
    path: "/cdp/session/ses_browser",
    state: { prompt: "检查 https://example.com", model: { providerID: "test", modelID: "chat" } },
  })
})

it("从脚本库带入的流程显示为可取消标签，提交时仍引用脚本", async () => {
  vi.mocked(browserApi.scripts).mockResolvedValue({ items: [{ id: "scr_1", name: "订单导出", version: 2 } as never] })
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<MemoryRouter initialEntries={["/?script=scr_1"]}><Routes><Route path="/" element={<CdpHome />} /><Route path="/cdp/session/:id" element={<Destination />} /></Routes></MemoryRouter>))
  expect(container.querySelector(".cdp-script-chip")?.textContent).toContain("订单导出")
  await act(async () => start().click())
  const destination = JSON.parse(container.querySelector('[data-testid="destination"]')!.textContent!)
  expect(destination.state.prompt).toContain("/workspace/output/published-script.js")
  expect(vi.mocked(browserApi.create).mock.calls[0]?.[0]).toMatchObject({ title: "订单导出", scriptId: "scr_1" })
})

it("可以取消脚本标签，取消后不再随任务提交脚本", async () => {
  vi.mocked(browserApi.scripts).mockResolvedValue({ items: [{ id: "scr_1", name: "订单导出", version: 2 } as never] })
  await act(async () => root.unmount())
  container.remove()
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<MemoryRouter initialEntries={["/?script=scr_1"]}><Routes><Route path="/" element={<CdpHome />} /><Route path="/cdp/session/:id" element={<Destination />} /></Routes></MemoryRouter>))
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="移除流程"]')!.click())
  expect(container.querySelector(".cdp-script-chip")).toBeNull()
  await fill("只要普通任务")
  await act(async () => start().click())
  expect(vi.mocked(browserApi.create).mock.calls[0]?.[0]).not.toHaveProperty("scriptId")
})

it("创建失败显示原因并保留草稿，可继续重试", async () => {
  vi.mocked(browserApi.create).mockRejectedValueOnce(new Error("浏览器暂不可用"))
  await fill("保留这条浏览器任务")
  await act(async () => start().click())
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("浏览器暂不可用")
  expect(editor().value).toBe("保留这条浏览器任务")
  expect(start().disabled).toBe(false)
})
