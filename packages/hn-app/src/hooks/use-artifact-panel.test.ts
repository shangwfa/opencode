import { beforeEach, describe, expect, it } from "vitest"
import {
  ARTIFACT_PANEL_COLLAPSED_KEY,
  isArtifactPanelShortcut,
  readArtifactPanelCollapsed,
  writeArtifactPanelCollapsed,
} from "./use-artifact-panel"

function fakeStorage(initial?: string) {
  const map = new Map<string, string>(initial === undefined ? [] : [[ARTIFACT_PANEL_COLLAPSED_KEY, initial]])
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    dump: () => Object.fromEntries(map),
  }
}

describe("artifact panel collapse state", () => {
  it("读取：'1' 收起，其它/缺省/无存储 展开", () => {
    expect(readArtifactPanelCollapsed(fakeStorage("1"))).toBe(true)
    expect(readArtifactPanelCollapsed(fakeStorage("0"))).toBe(false)
    expect(readArtifactPanelCollapsed(fakeStorage())).toBe(false)
    expect(readArtifactPanelCollapsed(null)).toBe(false)
  })

  it("读取遇异常安全回退为展开", () => {
    expect(
      readArtifactPanelCollapsed({
        getItem: () => {
          throw new Error("denied")
        },
      }),
    ).toBe(false)
  })

  it("写入并往返一致", () => {
    const s = fakeStorage()
    writeArtifactPanelCollapsed(true, s)
    expect(s.dump()[ARTIFACT_PANEL_COLLAPSED_KEY]).toBe("1")
    expect(readArtifactPanelCollapsed(s)).toBe(true)
    writeArtifactPanelCollapsed(false, s)
    expect(readArtifactPanelCollapsed(s)).toBe(false)
  })

  it("写入无存储/异常不抛出", () => {
    expect(() => writeArtifactPanelCollapsed(true, null)).not.toThrow()
    expect(() =>
      writeArtifactPanelCollapsed(true, {
        setItem: () => {
          throw new Error("quota")
        },
      }),
    ).not.toThrow()
  })
})

describe("isArtifactPanelShortcut", () => {
  it("⌘. / Ctrl+. 命中", () => {
    expect(isArtifactPanelShortcut({ key: ".", metaKey: true, ctrlKey: false })).toBe(true)
    expect(isArtifactPanelShortcut({ key: ".", metaKey: false, ctrlKey: true })).toBe(true)
  })

  it("缺修饰键 / 非 . 键不命中", () => {
    expect(isArtifactPanelShortcut({ key: ".", metaKey: false, ctrlKey: false })).toBe(false)
    expect(isArtifactPanelShortcut({ key: "b", metaKey: true, ctrlKey: false })).toBe(false)
  })

  it("输入框与可编辑区域内不拦截", () => {
    expect(
      isArtifactPanelShortcut({ key: ".", metaKey: true, ctrlKey: false, target: document.createElement("input") }),
    ).toBe(false)
    expect(
      isArtifactPanelShortcut({
        key: ".",
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

  it("默认走 window.localStorage 且用例间不残留", () => {
    writeArtifactPanelCollapsed(true)
    expect(readArtifactPanelCollapsed()).toBe(true)
    window.localStorage.clear()
    expect(readArtifactPanelCollapsed()).toBe(false)
  })
})