import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, afterEach, expect, test, vi } from "vitest"
import { HarnessEditor } from "./app-harness"

let cleanup = () => {}
const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousAct = actGlobal.IS_REACT_ACT_ENVIRONMENT
actGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => { actGlobal.IS_REACT_ACT_ENVIRONMENT = previousAct })
afterEach(() => { act(cleanup); document.body.innerHTML = "" })

function renderEditor(props: Parameters<typeof HarnessEditor>[0]) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<HarnessEditor {...props} />))
  cleanup = () => root.unmount()
}

test("Commands 使用表单并保留高级字段", async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  renderEditor({ kind: "commands", initial: { name: "review", description: "审查", template: "检查代码", hints: ["path"], subtask: true }, saving: false, onClose: vi.fn(), onSave: save })
  expect(document.body.textContent).toContain("命令名称")
  expect(document.body.textContent).toContain("命令提示词")
  expect(document.body.textContent).not.toContain("定义 JSON")
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "保存到应用默认")!
  await act(async () => button.click())
  expect(save).toHaveBeenCalledWith({ name: "review", description: "审查", template: "检查代码", hints: ["path"], subtask: true })
})

test("MCP 远程编辑保留认证信息与超时", async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  renderEditor({ kind: "mcps", initial: { name: "docs", config: { type: "remote", url: "https://example.com/mcp", headers: { Authorization: "Bearer test" }, timeout: { startup: 3000 } } }, saving: false, onClose: vi.fn(), onSave: save })
  expect(document.querySelector('input[type="password"]')).not.toBeNull()
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "保存到应用默认")!
  await act(async () => button.click())
  expect(save).toHaveBeenCalledWith({ name: "docs", config: { type: "remote", url: "https://example.com/mcp", oauth: false, disabled: false, codemode: true, headers: { Authorization: "Bearer test" }, timeout: { startup: 3000 } } })
})

test("MCP 本地编辑保留含空格的单个参数", async () => {
  const save = vi.fn().mockResolvedValue(undefined)
  renderEditor({ kind: "mcps", initial: { name: "local", config: { type: "local", command: ["node", "script with spaces.js", "--flag"], environment: { TOKEN: "test" } } }, saving: false, onClose: vi.fn(), onSave: save })
  const button = [...document.querySelectorAll("button")].find((node) => node.textContent === "保存到应用默认")!
  await act(async () => button.click())
  expect(save.mock.calls[0]?.[0].config.command).toEqual(["node", "script with spaces.js", "--flag"])
  expect(save.mock.calls[0]?.[0].config.environment).toEqual({ TOKEN: "test" })
})

test("未保存修改需要确认放弃", async () => {
  const close = vi.fn()
  renderEditor({ kind: "mcps", saving: false, onClose: close, onSave: vi.fn() })
  const add = [...document.querySelectorAll("button")].find((node) => node.textContent?.includes("添加认证头"))!
  act(() => add.click())
  const cancel = [...document.querySelectorAll("button")].find((node) => node.textContent === "取消")!
  act(() => cancel.click())
  expect(close).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain("有未保存的修改")
  const discard = [...document.querySelectorAll("button")].find((node) => node.textContent === "放弃修改")!
  act(() => discard.click())
  expect(close).toHaveBeenCalledOnce()
})
