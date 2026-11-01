import { act, useState } from "react"
import { createRoot } from "react-dom/client"
import { expect, it, vi } from "vitest"
import { Markdown } from "./markdown"
import { FilePreviewDialog } from "./file-preview-dialog"
import { readSandboxFile } from "@/lib/rest"

vi.mock("@/lib/rest", () => ({ readSandboxFile: vi.fn(async () => ({ content: "# 测试报告", binary: false })) }))
vi.mock("./file-viewer-preview", () => ({ default: ({ file }: { file: File }) => <div data-testid="file-viewer">{file.name}</div> }))

it.each(["click", "Enter", " "])("正文行内文件路径通过 %s 打开当前会话的 file-viewer", async (input) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const path = "/workspace/output/影刀官网-产品与定价整理.md"
  const onOpen = vi.fn()
  function Probe() {
    const [href, setHref] = useState<string>()
    return <><Markdown content={`完整版已保存到：\`${path}\``} onFileLink={(value) => { onOpen(value); setHref(value) }} /><FilePreviewDialog href={href} directory="/workspace" sessionId="ses_report" onOpenChange={(open) => { if (!open) setHref(undefined) }} /></>
  }
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Probe />))
    const link = container.querySelector<HTMLElement>("a[data-sandbox-href]")!
    expect(link.textContent).toBe(path)
    await act(async () => {
      if (input === "click") link.click()
      else link.dispatchEvent(new KeyboardEvent("keydown", { key: input, bubbles: true }))
    })
    expect(onOpen).toHaveBeenCalledWith(`file://${path}`)
    expect(readSandboxFile).toHaveBeenCalledWith(path, { directory: "/workspace", sessionId: "ses_report", mime: "text/markdown" })
    expect(document.querySelector('[data-testid="file-viewer"]')?.textContent).toBe("影刀官网-产品与定价整理.md")
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="关闭弹窗"]')!
    expect(close.classList.contains("rounded-full")).toBe(true)
    await act(async () => close.click())
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  } finally { await act(async () => root.unmount()); container.remove() }
})
