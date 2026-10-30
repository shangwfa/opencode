import { act } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { createPromptController } from "@/context/prompt-store"
import { Composer } from "./composer"

vi.mock("@/hooks/use-provider-list", () => ({
  useProviderList: () => ({ providers: [] }),
  selectAvailableModels: () => [],
}))
vi.mock("./attachments", () => ({
  usePromptAttachments: () => ({ addAttachments: vi.fn(), removeAttachment: vi.fn(), handlePaste: vi.fn() }),
}))

it("保留发送、换行和停止交互，中文输入法确认不触发发送", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  const onSubmit = vi.fn()
  const onAbort = vi.fn()
  const props = {
    working: false, agent: "build", model: { providerID: "test", modelID: "chat-model" },
    onAgentChange: vi.fn(), onModelChange: vi.fn(), onSubmit, onAbort,
    prompt: createPromptController(),
  }
  try {
    await act(async () => root.render(<Composer {...props} />))
    const editor = container.querySelector("textarea")!
    const send = container.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!
    expect(send.disabled).toBe(true)
    expect(container.querySelector('[aria-label="选择 Agent"]')?.textContent).toContain("执行")
    expect(container.querySelector('[aria-label="添加图片"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="选择模型"]')?.textContent).toContain("chat-model")
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(editor, "你好")
      editor.dispatchEvent(new Event("input", { bubbles: true }))
    })
    expect(send.disabled).toBe(false)
    await act(async () => {
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }))
      editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true }))
    })
    expect(onSubmit).not.toHaveBeenCalled()
    await act(async () => editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })))
    expect(onSubmit).toHaveBeenCalledWith({ text: "你好", clear: expect.any(Function) })
    await act(async () => root.render(<Composer {...props} working />))
    expect(container.querySelector('[aria-label="发送消息"]')).toBeNull()
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="停止生成"]')!.click())
    expect(onAbort).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<Composer {...props} agent="plan" />))
    expect(container.querySelector('[aria-label="选择 Agent"]')?.textContent).toContain("规划")
    await act(async () => root.render(<Composer {...props} agent="custom-agent" />))
    expect(container.querySelector('[aria-label="选择 Agent"]')?.textContent).toContain("custom-agent")
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
