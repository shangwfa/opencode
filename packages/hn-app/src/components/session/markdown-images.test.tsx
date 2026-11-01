import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterEach, expect, it, vi } from "vitest"
import { Markdown } from "./markdown"
import { readSandboxFile } from "@/lib/rest"

vi.mock("@/lib/rest", () => ({ readSandboxFile: vi.fn(async () => ({ content: "aGVsbG8=", binary: true })) }))
afterEach(() => vi.restoreAllMocks())

it("会话截图直接显示并复用文件预览，同一图片不重复加载", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const create = vi.fn(() => "blob:preview"), revoke = vi.fn()
  Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke })
  const open = vi.fn(), container = document.createElement("div"), root = createRoot(container)
  try {
    await act(async () => root.render(<Markdown content={"截图：`output/a.png`，以及 `output/a.png`"} sessionId="ses_1" directory="/workspace" onFileLink={open} />))
    expect(vi.mocked(readSandboxFile)).toHaveBeenCalledTimes(1)
    expect(readSandboxFile).toHaveBeenCalledWith("/workspace/output/a.png", { sessionId: "ses_1", directory: "/workspace", mime: "image/png" })
    expect(container.querySelector("img")?.getAttribute("src")).toBe("blob:preview")
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="预览 a.png"]')!.click())
    expect(open).toHaveBeenCalledWith("file:///workspace/output/a.png")
  } finally { await act(async () => root.unmount()) }
  expect(revoke).toHaveBeenCalledWith("blob:preview")
})

it("图片读取失败时展示文件名并允许重试", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.mocked(readSandboxFile).mockRejectedValueOnce(new Error("文件不存在"))
  const container = document.createElement("div"), root = createRoot(container)
  try {
    await act(async () => root.render(<Markdown content="`output/missing.png`" sessionId="ses_1" />))
    expect(container.textContent).toContain("missing.png")
    expect(container.textContent).toContain("图片加载失败，点击重试")
  } finally { await act(async () => root.unmount()) }
})
