import { beforeEach, describe, expect, it } from "vitest"
import {
  SESSION_PANEL_COLLAPSED_KEY,
  isSessionPanelShortcut,
  readSessionPanelCollapsed,
  writeSessionPanelCollapsed,
} from "./use-session-panel"

function fakeStorage(initial?: string) {
  const map = new Map<string, string>(initial === undefined ? [] : [[SESSION_PANEL_COLLAPSED_KEY, initial]])
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  }
}

describe("readSessionPanelCollapsed", () => {
  it("值为 '1' 时收起", () => {
    expect(readSessionPanelCollapsed(fakeStorage("1"))).toBe(true)
  })

  it("其它值 / 缺省 / 无存储 → 展开", () => {
    expect(readSessionPanelCollapsed(fakeStorage("0"))).toBe(false)
    expect(readSessionPanelCollapsed(fakeStorage())).toBe(false)
    expect(readSessionPanelCollapsed(null)).toBe(false)
  })

  it("存储抛异常时安全回退为展开", () => {
    expect(
      readSessionPanelCollapsed({
        getItem: () => {
          throw new Error("denied")
        },
      }),
    ).toBe(false)
  })
})

describe("writeSessionPanelCollapsed", () => {
  it("收起写 '1'、展开写 '0'，往返一致", () => {
    const s = fakeStorage()
    writeSessionPanelCollapsed(true, s)
    expect(s.dump()[SESSION_PANEL_COLLAPSED_KEY]).toBe("1")
    writeSessionPanelCollapsed(false, s)
    expect(readSessionPanelCollapsed(s)).toBe(false)
    writeSessionPanelCollapsed(true, s)
    expect(readSessionPanelCollapsed(s)).toBe(true)
  })

  it("无存储 / 抛异常不抛出", () => {
    expect(() => writeSessionPanelCollapsed(true, null)).not.toThrow()
    expect(() =>
      writeSessionPanelCollapsed(true, {
        setItem: () => {
          throw new Error("quota")
        },
      }),
    ).not.toThrow()
  })

  it("默认走 window.localStorage", () => {
    window.localStorage.clear()
    writeSessionPanelCollapsed(true)
    expect(window.localStorage.getItem(SESSION_PANEL_COLLAPSED_KEY)).toBe("1")
    expect(readSessionPanelCollapsed()).toBe(true)
  })
})

describe("isSessionPanelShortcut", () => {
  it("⌘B / Ctrl+B 命中（大小写不敏感）", () => {
    expect(isSessionPanelShortcut({ key: "b", metaKey: true, ctrlKey: false })).toBe(true)
    expect(isSessionPanelShortcut({ key: "B", metaKey: false, ctrlKey: true })).toBe(true)
  })

  it("缺修饰键或非 B 键不命中", () => {
    expect(isSessionPanelShortcut({ key: "b", metaKey: false, ctrlKey: false })).toBe(false)
    expect(isSessionPanelShortcut({ key: "k", metaKey: true, ctrlKey: false })).toBe(false)
  })

  it("输入框 / 可编辑区域内不拦截", () => {
    expect(
      isSessionPanelShortcut({ key: "b", metaKey: true, ctrlKey: false, target: document.createElement("input") }),
    ).toBe(false)
    expect(
      isSessionPanelShortcut({
        key: "b",
        metaKey: true,
        ctrlKey: false,
        target: document.createElement("textarea"),
      }),
    ).toBe(false)
    expect(
      isSessionPanelShortcut({
        key: "b",
        metaKey: true,
        ctrlKey: false,
        target: { tagName: "DIV", isContentEditable: true },
      }),
    ).toBe(false)
  })
})

describe("localStorage 隔离", () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it("两个用例之间互不残留", () => {
    writeSessionPanelCollapsed(true)
    expect(readSessionPanelCollapsed()).toBe(true)
    window.localStorage.clear()
    expect(readSessionPanelCollapsed()).toBe(false)
  })
})