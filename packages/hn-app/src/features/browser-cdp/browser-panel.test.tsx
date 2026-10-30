import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { BrowserPanel } from "./browser-panel"

const command = vi.hoisted(() => vi.fn().mockResolvedValue({}))
vi.mock("./use-cdp-viewer", () => ({
  useCdpViewer: () => ({
    targets: [{ id: "page", title: "示例", url: "https://example.com" }],
    target: "page",
    setTarget: vi.fn(),
    frame: { data: "test", metadata: { deviceWidth: 100, deviceHeight: 100 } },
    status: "live",
    error: "",
    history: { currentIndex: 0, entries: [{ id: 1, url: "https://example.com" }] },
    url: "https://example.com",
    command,
    restart: vi.fn(),
    openTab: vi.fn(),
    closeTab: vi.fn(),
  }),
}))

it("接管等待服务端暂停；AI 新任务开始时退出接管，避免同时输入", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement("div")
  const root = createRoot(container)
  let paused: () => void = () => {}
  const takeover = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        paused = resolve
      }),
  )
  try {
    await act(async () => root.render(<BrowserPanel sessionId="ses_test" onTakeover={takeover} />))
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="接管浏览器"]')!
    await act(async () => button.click())
    expect(takeover).toHaveBeenCalledTimes(1)
    expect(button.disabled).toBe(true)
    expect(button.getAttribute("aria-pressed")).toBe("false")
    await act(async () => paused())
    expect(button.getAttribute("aria-pressed")).toBe("true")
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(false)
    const keyboard = container.querySelector<HTMLTextAreaElement>("textarea")!
    const pasteKey = new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true })
    await act(async () => keyboard.dispatchEvent(pasteKey))
    expect(pasteKey.defaultPrevented).toBe(false)
    const paste = new Event("paste", { bubbles: true, cancelable: true })
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "粘贴的中文" } })
    await act(async () => {
      keyboard.dispatchEvent(paste)
      await Promise.resolve()
    })
    expect(command).toHaveBeenCalledWith("Input.insertText", { text: "粘贴的中文" })
    await act(async () => root.render(<BrowserPanel sessionId="ses_test" onTakeover={takeover} working />))
    expect(button.getAttribute("aria-pressed")).toBe("false")
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.disabled).toBe(true)
  } finally {
    await act(async () => root.unmount())
  }
})
