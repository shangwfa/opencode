import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import type { Message, Part } from "@/types/opencode"
import { SessionTimeline } from "./session-timeline"

it("上滚暂停后发送新消息立即贴底并恢复跟随，后续上滚仍可暂停", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const scroller = document.createElement("div")
  scroller.dataset.slot = "scroll-area-viewport"
  document.body.append(scroller)
  let height = 1500
  let top = 0
  Object.defineProperties(scroller, {
    clientHeight: { get: () => 500 },
    scrollHeight: { get: () => height },
    scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 500)) } },
  })
  const root = createRoot(scroller)
  let messages = [{ id: "u1", role: "user", time: { created: 1 } }] as Message[]
  let parts: Record<string, Part[]> = {}
  const render = () => root.render(<SessionTimeline messages={messages} parts={parts} working />)
  const scrollUp = async () => act(async () => {
    scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -400 }))
    scroller.scrollTop = 200
    scroller.dispatchEvent(new Event("scroll"))
  })
  try {
    await act(async () => render())
    await scrollUp()
    // AI 的新消息不能解除用户主动暂停。
    messages = [...messages, { id: "a1", role: "assistant", time: { created: 2 } } as Message]
    height = 1700
    await act(async () => render())
    expect(scroller.scrollTop).toBe(200)
    expect(scroller.querySelector('[data-chat-role="assistant"]')?.textContent).toBe("")

    messages = [...messages, { id: "u2", role: "user", time: { created: 3 } } as Message]
    height = 1800
    await act(async () => render())
    expect(scroller.scrollTop).toBe(1300)
    expect(scroller.querySelector('[aria-label="回到底部"]')).toBeNull()

    height = 2000
    parts = { a1: [] }
    await act(async () => render())
    expect(scroller.scrollTop).toBe(1500)

    await scrollUp()
    height = 2200
    // 消息快照换引用、同一用户消息重复同步均不应抢滚动。
    messages = messages.map((message) => ({ ...message }))
    parts = { a1: [] }
    await act(async () => render())
    expect(scroller.scrollTop).toBe(200)
  } finally {
    await act(async () => root.unmount())
    scroller.remove()
  }
})
