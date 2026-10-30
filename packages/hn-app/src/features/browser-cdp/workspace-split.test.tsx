import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { BrowserWorkspaceSplit } from "./workspace-split"

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
let width = 1000
let resize: () => void
const handle = () => container.querySelector<HTMLElement>('[role="separator"]')!
const value = () => Number(handle().getAttribute("aria-valuenow"))
async function pointer(type: string, clientX = 0) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX })
  Object.defineProperty(event, "pointerId", { value: 1 })
  await act(async () => handle().dispatchEvent(event))
}
beforeEach(async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  width = 1000
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    left: 100, right: 100 + width, width, top: 0, bottom: 600, height: 600, x: 100, y: 0, toJSON: () => ({}),
  }))
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback }
    observe() {}
    disconnect() {}
  })
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root.render(<BrowserWorkspaceSplit chat={<input aria-label="聊天草稿" defaultValue="保留草稿" />} panel={<div>浏览器</div>} showPanel={false} />))
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it("拖动分割线调整比例，松手停止，聊天节点和草稿不重挂", async () => {
  const editor = container.querySelector("input")!
  expect(value()).toBe(52)
  await pointer("pointerdown", 620)
  await pointer("pointermove", 750)
  expect(value()).toBe(65)
  expect(container.querySelector("input")).toBe(editor)
  expect(editor.value).toBe("保留草稿")
  await pointer("pointerup", 750)
  await pointer("pointermove", 500)
  expect(value()).toBe(65)
  expect(container.querySelector("[data-resizing]")).toBeNull()
})

it("两侧最小宽度受限，容器缩小时重新夹取，双击恢复默认", async () => {
  await pointer("pointerdown")
  await pointer("pointermove", 2000)
  expect(value()).toBe(Number(handle().getAttribute("aria-valuemax")))
  await pointer("pointermove", -100)
  expect(value()).toBe(Number(handle().getAttribute("aria-valuemin")))
  await pointer("pointermove", 750)
  await pointer("pointerup")
  width = 760
  await act(async () => resize())
  expect(value()).toBe(Number(handle().getAttribute("aria-valuemax")))
  await act(async () => handle().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })))
  expect(value()).toBe(52)
})

it("支持方向键和极限位置，RTL 按实际方向调整", async () => {
  await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })))
  expect(value()).toBe(54)
  await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })))
  expect(value()).toBe(Number(handle().getAttribute("aria-valuemin")))
  await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })))
  expect(value()).toBe(Number(handle().getAttribute("aria-valuemax")))
  container.querySelector<HTMLElement>(".cdp-session-layout")!.style.direction = "rtl"
  await pointer("pointerdown")
  await pointer("pointermove", 450)
  expect(value()).toBe(65)
  await pointer("pointercancel")
  await act(async () => handle().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })))
  expect(value()).toBe(67)
  expect(container.querySelector("[data-resizing]")).toBeNull()
})

it("切换窄屏面板不重挂聊天草稿", async () => {
  const editor = container.querySelector("input")!
  await act(async () => root.render(<BrowserWorkspaceSplit chat={<input aria-label="聊天草稿" defaultValue="保留草稿" />} panel={<div>浏览器</div>} showPanel />))
  expect(container.querySelector("input")).toBe(editor)
  expect(container.querySelector(".cdp-chat-pane")?.classList.contains("hidden")).toBe(true)
  expect(container.querySelector('[aria-label="浏览器工具面板"]')?.classList.contains("hidden")).toBe(false)
})
