import { act, StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { useCdpViewer } from "./use-cdp-viewer"

const mocks = vi.hoisted(() => ({ start: vi.fn(), targets: vi.fn(), frames: vi.fn(), command: vi.fn() }))
vi.mock("@/lib/browser", () => ({
  browserApi: mocks,
  readBrowserFrames: async () => {},
}))

let root: ReturnType<typeof createRoot> | undefined
afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = undefined
  vi.clearAllMocks()
})

it("StrictMode 不重复启动沙箱；切换会话重新绑定，卸载取消画面", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  mocks.start.mockResolvedValue({ ready: true })
  mocks.targets.mockResolvedValue({ items: [{ id: "PAGE", title: "test", url: "https://example.com", type: "page" }] })
  mocks.frames.mockResolvedValue(new Response())
  mocks.command.mockResolvedValue({ currentIndex: 0, entries: [{ id: 1, url: "https://example.com" }] })
  function Probe({ id }: { id: string }) {
    const viewer = useCdpViewer(id)
    return <span>{viewer.target}</span>
  }
  const container = document.createElement("div")
  root = createRoot(container)
  await act(async () => {
    root!.render(
      <StrictMode>
        <Probe id="ses_one" />
      </StrictMode>,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(mocks.start).toHaveBeenCalledTimes(1)
  expect(mocks.start).toHaveBeenCalledWith("ses_one")
  expect(container.textContent).toBe("PAGE")
  const signal = mocks.frames.mock.calls[0]![2] as AbortSignal
  await act(async () => {
    root!.render(
      <StrictMode>
        <Probe id="ses_two" />
      </StrictMode>,
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(signal.aborted).toBe(true)
  expect(mocks.start).toHaveBeenCalledTimes(2)
  expect(mocks.start).toHaveBeenLastCalledWith("ses_two")
  await act(async () => {
    root!.unmount()
    root = undefined
  })
  const lastSignal = mocks.frames.mock.calls.at(-1)![2] as AbortSignal
  expect(lastSignal.aborted).toBe(true)
})

it("会话没有浏览器记录时标记为不可用，而不是连接故障", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const { BaseApiError } = await import("@/lib/base-api")
  mocks.start.mockRejectedValue(new BaseApiError(404, "not_found", "资源不存在或无权访问"))
  function Probe() {
    const viewer = useCdpViewer("ses_none")
    return <span>{viewer.status}</span>
  }
  const container = document.createElement("div")
  root = createRoot(container)
  await act(async () => {
    root!.render(<Probe />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(container.textContent).toBe("unavailable")
})
