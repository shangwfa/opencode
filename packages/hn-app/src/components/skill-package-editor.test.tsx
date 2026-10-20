import { act } from "react"
import { createRoot } from "react-dom/client"
import { afterAll, afterEach, expect, test, vi } from "vitest"
import { SkillPackageEditor } from "./skill-package-editor"

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previous = actGlobal.IS_REACT_ACT_ENVIRONMENT
actGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => { actGlobal.IS_REACT_ACT_ENVIRONMENT = previous })
let cleanup = () => {}
afterEach(() => { act(cleanup); document.body.innerHTML = "" })
const initial = { id: "complex", name: "复杂技能", description: "审查前", autoinvoke: true, content: "查看 references/guide.md", resources: [{ path: "references/guide.md", type: "doc", content: "详细说明" }, { path: "scripts/check.py", type: "script", content: "print(1)" }] }
function mount(save = vi.fn().mockResolvedValue(undefined), close = vi.fn()) {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  act(() => root.render(<SkillPackageEditor initial={initial} saving={false} onClose={close} onSave={save} />))
  cleanup = () => root.unmount()
  return { save, close }
}
function button(text: string) { return [...document.querySelectorAll("button")].find((item) => item.textContent === text)! }

test("保存完整技能包，保留多个文件与调用策略", async () => {
  const { save } = mount()
  await act(async () => button("保存到应用默认").click())
  expect(save).toHaveBeenCalledWith(initial)
})
test("资源编辑器显示文件及正文，新增文件后离开需确认", () => {
  const { close } = mount()
  act(() => button("资源文件 (2)").click())
  expect(document.body.textContent).toContain("references/guide.md")
  expect(document.querySelector("textarea")?.value).toBe("详细说明")
  act(() => button("新增文件").click())
  expect(document.body.textContent).toContain("references/note-1.md")
  act(() => button("取消").click())
  expect(close).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain("有未保存的技能包修改")
})
test("资源文件删除需要单独确认，不误删除其他文件", async () => {
  const { save } = mount()
  act(() => button("资源文件 (2)").click())
  act(() => button("移除文件").click())
  expect(document.body.textContent).toContain("确认删除此文件")
  act(() => button("删除文件").click())
  await act(async () => button("保存到应用默认").click())
  expect(save.mock.calls[0]?.[0].resources).toEqual([initial.resources[1]])
})
