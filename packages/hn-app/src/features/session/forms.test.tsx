import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import type { Form } from "@opencode/schema/form"
import { SessionForms } from "./forms"

const providerForm = {
  id: "frm_ws",
  sessionID: "ses_1",
  title: "Web Search",
  fields: [
    {
      key: "provider",
      title: "选择搜索服务",
      type: "string",
      required: true,
      custom: false,
      options: [
        { value: "exa", label: "Exa" },
        { value: "tavily", label: "Tavily" },
      ],
    },
  ],
} as unknown as Form.Info

/** 聊天会话没有表单入口时，用户无法回答 websearch provider 这类必需问题。 */
it("聊天会话能渲染待回答问题并提交答案", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const load = vi.fn(async () => ({ data: [providerForm] }))
  const reply = vi.fn(async () => ({}))
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () =>
      root.render(<SessionForms sessionId="ses_1" load={load} reply={reply} active />),
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(container.textContent).toContain("Web Search")
    expect(container.textContent).toContain("AI 正在等待你的回答")
    expect(container.querySelector('[aria-label="待确认问题"]')?.className).not.toContain("overflow-y-auto")
    const select = container.querySelector("select")!
    await act(async () => {
      select.value = "exa"
      select.dispatchEvent(new Event("change", { bubbles: true }))
    })
    await act(async () => container.querySelector("form")!.requestSubmit())
    expect(reply).toHaveBeenCalledWith("ses_1", "frm_ws", { provider: "exa" })
  } finally {
    await act(async () => root.unmount())
  }
})

it("空闲挂载仍检查一次待回答问题，但不启动轮询", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const load = vi.fn(async () => ({ data: [] }))
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () => root.render(<SessionForms sessionId="ses_1" load={load} reply={vi.fn()} active={false} />))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(load).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
  }
})
