import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it } from "vitest"
import { useStickToBottom } from "./use-stick-to-bottom"

it("初始无溢出也绑定监听，上滚后流式增量不抢位置，回到底部恢复跟随", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  let state!: ReturnType<typeof useStickToBottom>
  function Probe({ revision }: { revision: number }) {
    state = useStickToBottom([revision])
    // Radix 在滚动条挂载前先使用 hidden，监听不能依赖此刻的 overflow 样式。
    return <div data-slot="scroll-area-viewport" style={{ overflowY: "hidden" }}><div ref={state.anchorRef} /></div>
  }
  try {
    await act(async () => root.render(<Probe revision={0} />))
    const scroller = container.firstElementChild as HTMLElement
    let height = 1000
    let top = 0
    Object.defineProperties(scroller, {
      clientHeight: { get: () => 500 },
      scrollHeight: { get: () => height },
      scrollTop: { get: () => top, set: (value: number) => { top = Math.max(0, Math.min(value, height - 500)) } },
    })
    scroller.style.overflowY = "auto"
    await act(async () => root.render(<Probe revision={1} />))
    expect(scroller.scrollTop).toBe(500)

    // 模拟刚开始上滚：仍在旧的 64px 阈值内。
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent("wheel", { deltaY: -10 }))
      scroller.scrollTop = 490
      scroller.dispatchEvent(new Event("scroll"))
    })
    expect(state.pinned).toBe(false)
    height = 1200
    await act(async () => root.render(<Probe revision={2} />))
    expect(scroller.scrollTop).toBe(490)
    expect(state.overflowing).toBe(true)

    await act(async () => state.scrollToBottom())
    expect(state.pinned).toBe(true)

    // 新内容先改变高度、后触发 effect，不能把这个间隙当成用户离开底部。
    height = 1600
    await act(async () => scroller.dispatchEvent(new Event("scroll")))
    expect(state.pinned).toBe(true)
    await act(async () => root.render(<Probe revision={4} />))
    expect(scroller.scrollTop).toBe(1100)
    height = 1400
    await act(async () => root.render(<Probe revision={3} />))
    expect(scroller.scrollTop).toBe(900)

    // 折叠内容时浏览器会向上夹取 scrollTop，但用户仍在底部，不应再次显示按钮。
    height = 1300
    await act(async () => {
      scroller.scrollTop = 800
      scroller.dispatchEvent(new Event("scroll"))
    })
    expect(state.pinned).toBe(true)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
