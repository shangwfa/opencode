import { expect, test } from "bun:test"
import { PAGE_ACTION } from "../src/lib/browser-automation-cdp"

test("读取文档标题不要求可见，其他隐藏元素仍不可操作", () => {
  const hidden = { textContent: "Example Domain", getClientRects: () => [] }
  const action = new Function("document", `return (${PAGE_ACTION})`)({ querySelectorAll: () => [hidden] })
  expect(action({ action: "extract", selector: "title" })).toEqual({ output: "Example Domain" })
  expect(action({ action: "extract", selector: "#hidden" })).toMatchObject({ missing: true })
  expect(action({ action: "click", selector: "title" })).toMatchObject({ missing: true })
})
