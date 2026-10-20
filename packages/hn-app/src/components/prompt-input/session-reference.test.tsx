import { createRoot } from "react-dom/client"
import { act } from "react"
import { afterEach, describe, expect, test } from "vitest"
import type { Prompt } from "@/context/prompt"
import {
  SessionReferenceIcon,
  formatSessionReference,
  serializePromptText,
  sessionReferenceAdapter,
} from "./session-reference-adapter"

const cleanups: Array<() => void> = []

function renderReact(node: React.ReactElement, host: HTMLElement) {
  const root = createRoot(host)
  act(() => {
    root.render(node)
  })
  cleanups.push(() => root.unmount())
}

afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup())
})

describe("session references", () => {
  test("formats a session id as an explicit cross-session marker", () => {
    expect(formatSessionReference({ sessionId: " ses_target " })).toBe("关联会话 ses_target:")
  })

  test("uses default icon sizing and allows size and stroke overrides", () => {
    const defaults = document.createElement("div")
    renderReact(<SessionReferenceIcon />, defaults)
    expect(defaults.querySelector("svg")?.getAttribute("width")).toBe("14")
    expect(defaults.querySelector("svg")?.getAttribute("height")).toBe("14")
    expect(defaults.querySelector("svg")?.getAttribute("stroke-width")).toBe("2")

    const custom = document.createElement("div")
    renderReact(<SessionReferenceIcon size={18} strokeWidth={1.5} />, custom)
    expect(custom.querySelector("svg")?.getAttribute("width")).toBe("18")
    expect(custom.querySelector("svg")?.getAttribute("height")).toBe("18")
    expect(custom.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.5")
  })

  test("creates and parses a reusable session reference pill", () => {
    const part = sessionReferenceAdapter.createPart({ sessionId: " ses_target ", title: " 登录页改版 " }, 3)
    expect(part).toEqual({
      type: "session",
      sessionId: "ses_target",
      title: "登录页改版",
      content: "登录页改版",
      start: 3,
      end: 8,
    })

    const pill = sessionReferenceAdapter.createPillElement(part!, {
      icon: { size: 16, strokeWidth: 1.25 },
    })
    if (!pill) throw new Error("expected a valid session reference pill")
    expect(pill.dataset.sessionId).toBe("ses_target")
    expect(pill.getAttribute("contenteditable")).toBe("false")
    expect(pill.querySelector("svg")?.getAttribute("width")).toBe("16")
    expect(pill.querySelector("svg")?.getAttribute("stroke-width")).toBe("1.25")
    expect(sessionReferenceAdapter.parseElement(pill, 10)).toEqual({ ...part, start: 10, end: 15 })
  })

  test("falls back missing titles and rejects references without a session id", () => {
    expect(sessionReferenceAdapter.createPart({ sessionId: "ses_target", title: " " })?.title).toBe("未命名会话")
    expect(sessionReferenceAdapter.createPart({ sessionId: " ", title: "登录页改版" })).toBeUndefined()
    expect(
      sessionReferenceAdapter.createPillElement({
        type: "session",
        sessionId: " ",
        title: "登录页改版",
        content: "登录页改版",
        start: 0,
        end: 5,
      }),
    ).toBeUndefined()

    const invalid = document.createElement("span")
    invalid.dataset.type = "session"
    invalid.textContent = "登录页改版"
    expect(sessionReferenceAdapter.parseElement(invalid)).toBeUndefined()
  })

  test("serializes the visible title pill to the session marker", () => {
    const prompt: Prompt = [
      {
        type: "session",
        sessionId: "ses_target",
        title: "登录页改版",
        content: "登录页改版",
        start: 0,
        end: 5,
      },
      { type: "text", content: " 当前修改了什么？", start: 5, end: 14 },
    ]

    expect(serializePromptText(prompt)).toBe("关联会话 ses_target: 当前修改了什么？")
  })
})
