import { describe, expect, test } from "bun:test"
import {
  buildMenuTree,
  computeLinkRemoval,
  extractPlainText,
  KB_SLUG_RESERVED,
  validateKbSlug,
  validateMenuSlug,
  type MenuRowLike,
} from "./utils.js"

function row(overrides: Partial<MenuRowLike> & { id: string }): MenuRowLike {
  return {
    parentId: null,
    previousId: null,
    name: overrides.id,
    type: "doc",
    iconUrl: null,
    slug: null,
    enable: 1,
    docUniqueId: null,
    ...overrides,
  }
}

describe("validateKbSlug", () => {
  test("合法 slug 通过", () => {
    expect(() => validateKbSlug("abc")).not.toThrow()
    expect(() => validateKbSlug("a-b-c-123")).not.toThrow()
    expect(() => validateKbSlug("knowledge-base")).not.toThrow()
  })

  test("非法格式拒绝", () => {
    expect(() => validateKbSlug("ab")).toThrow() // 太短
    expect(() => validateKbSlug("Abc")).toThrow() // 大写
    expect(() => validateKbSlug("-abc")).toThrow() // 连字符开头
    expect(() => validateKbSlug("a b")).toThrow() // 空白
    expect(() => validateKbSlug("a".repeat(65))).toThrow() // 超长
  })

  test("保留字拒绝", () => {
    for (const reserved of KB_SLUG_RESERVED) {
      expect(() => validateKbSlug(reserved)).toThrow(/保留字/)
    }
  })
})

describe("validateMenuSlug", () => {
  test("合法通过,含 / 或空白拒绝", () => {
    expect(() => validateMenuSlug("intro")).not.toThrow()
    expect(() => validateMenuSlug("快速入门/01")).toThrow()
    expect(() => validateMenuSlug("a b")).toThrow()
  })
})

describe("buildMenuTree", () => {
  test("按兄弟链表排序建树,并计算 path", () => {
    const rows: MenuRowLike[] = [
      row({ id: "f1", name: "快速入门", type: "folder" }),
      row({ id: "d3", name: "03 概念", parentId: "f1", previousId: "d2" }),
      row({ id: "d1", name: "01 界面", parentId: "f1" }), // 链头
      row({ id: "d2", name: "02 流程", parentId: "f1", previousId: "d1" }),
      row({ id: "d0", name: "概述" }), // 根级链头
      row({ id: "d9", name: "结尾", previousId: "d0" }),
    ]
    const tree = buildMenuTree(rows)
    // f1(独立链头)与 d0→d9(链)按组内链头顺序串联
    expect(tree.map((n) => n.id)).toEqual(["f1", "d0", "d9"])
    const f1 = tree.find((n) => n.id === "f1")!
    expect(f1.menuTrees.map((n) => n.id)).toEqual(["d1", "d2", "d3"])
    expect(f1.path).toEqual(["快速入门"])
    expect(f1.menuTrees[0].path).toEqual(["快速入门", "01 界面"])
  })

  test("includeDisabled=false 过滤禁用节点(含其后代不在索引范围)", () => {
    const rows: MenuRowLike[] = [
      row({ id: "a", name: "A" }),
      row({ id: "b", name: "B", enable: 0, previousId: "a" }),
    ]
    const tree = buildMenuTree(rows, { includeDisabled: false })
    expect(tree.map((n) => n.id)).toEqual(["a"])
    const all = buildMenuTree(rows, { includeDisabled: true })
    expect(all.map((n) => n.id)).toEqual(["a", "b"])
  })

  test("断链容错:previous 指向不存在节点时作为链头", () => {
    const rows: MenuRowLike[] = [
      row({ id: "x", name: "X", previousId: "ghost" }),
      row({ id: "y", name: "Y", previousId: "x" }),
    ]
    const tree = buildMenuTree(rows)
    expect(tree.map((n) => n.id)).toEqual(["x", "y"])
  })
})

describe("computeLinkRemoval", () => {
  test("摘除中间节点:后继接前驱", () => {
    const siblings = [row({ id: "a" }), row({ id: "b", previousId: "a" }), row({ id: "c", previousId: "b" })]
    expect(computeLinkRemoval(siblings, "b")).toEqual([{ id: "c", previousId: "a" }])
  })

  test("摘除尾节点:无补丁", () => {
    const siblings = [row({ id: "a" }), row({ id: "b", previousId: "a" })]
    expect(computeLinkRemoval(siblings, "b")).toEqual([])
  })

  test("摘除链头:后继指向 null", () => {
    const siblings = [row({ id: "a" }), row({ id: "b", previousId: "a" })]
    expect(computeLinkRemoval(siblings, "a")).toEqual([{ id: "b", previousId: null }])
  })
})

describe("extractPlainText", () => {
  test("从 TipTap JSON 提取纯文本,块级换行", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "你好" }, { type: "text", text: "世界" }],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "标题" }],
        },
      ],
    }
    expect(extractPlainText(doc)).toBe("你好世界\n标题")
  })

  test("空/异常输入返回空串", () => {
    expect(extractPlainText(null)).toBe("")
    expect(extractPlainText({})).toBe("")
    expect(extractPlainText("not-json")).toBe("")
  })
})
