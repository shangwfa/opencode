import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { SessionTimeline } from "./session-timeline"

const scroll = vi.hoisted(() => ({ pinned: true, overflowing: true, scrollToBottom: vi.fn() }))
vi.mock("@/hooks/use-stick-to-bottom", () => ({
  useStickToBottom: () => ({ ...scroll, anchorRef: { current: null } }),
}))

it("回到底部按钮显隐不增加或移除 flex 子项，避免 gap 改变导致滚动反馈循环", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement("div")
  const root = createRoot(container)
  const render = () => root.render(<SessionTimeline messages={[]} parts={{}} working={false} />)
  try {
    await act(async () => render())
    const timeline = container.firstElementChild!
    const slot = timeline.lastElementChild!
    const count = timeline.children.length
    expect(slot.classList.contains("h-0")).toBe(true)
    expect(slot.querySelector("button")).toBeNull()

    scroll.pinned = false
    await act(async () => render())
    expect(timeline.children.length).toBe(count)
    expect(timeline.lastElementChild).toBe(slot)
    expect(slot.querySelector('[aria-label="回到底部"]')).not.toBeNull()

    scroll.pinned = true
    await act(async () => render())
    expect(timeline.children.length).toBe(count)
    expect(timeline.lastElementChild).toBe(slot)
    expect(slot.querySelector("button")).toBeNull()
  } finally {
    scroll.pinned = true
    await act(async () => root.unmount())
  }
})
