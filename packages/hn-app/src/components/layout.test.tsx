import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { expect, it, vi } from "vitest"
import { AppLayout } from "./layout"

vi.mock("@/components/user-menu", () => ({ UserMenu: () => null }))
vi.mock("@/components/context-insights/model", () => ({ readPreferences: () => ({}) }))

it.each(["/free-chat", "/free-chat/session/ses_1", "/cdp", "/cdp/session/ses_1", "/cdp/scripts", "/dashboard"])("工作区主题仅作用于聊天和 Browser Use：%s", async (path) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  const container = document.createElement("div")
  const root = createRoot(container)
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route element={<AppLayout />}><Route path="*" element={<div>页面内容</div>} /></Route></Routes>
      </MemoryRouter>,
    ))
    expect(container.firstElementChild?.classList.contains("chat-shell")).toBe(path !== "/dashboard")
    expect(container.querySelector("main")?.textContent).toBe("页面内容")
    const active = container.querySelector('nav a[aria-current="page"]')
    expect(active?.getAttribute("aria-label")).toBe(path.startsWith("/free-chat") ? "自由对话" : path.startsWith("/cdp") ? "Browser Use" : "仪表盘")
  } finally {
    await act(async () => root.unmount())
  }
})
