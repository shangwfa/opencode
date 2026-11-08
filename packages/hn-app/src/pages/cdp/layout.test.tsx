import { act } from "react"
import { createRoot } from "react-dom/client"
import { Link, MemoryRouter, Route, Routes } from "react-router"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { SESSION_PANEL_COLLAPSED_KEY } from "@/hooks/use-session-panel"
import { browserApi } from "@/lib/browser"
import { BrowserNavigationToggle, CdpLayout } from "./layout"
import { AutomationDetailPage, AutomationsPage } from "@/pages/automations"

vi.mock("@/lib/auth", () => ({ authEnabled: true }))
vi.mock("@/lib/browser", () => ({ browserApi: { sessions: vi.fn(async () => ({ items: [] })) } }))

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
function Page() {
  return <><BrowserNavigationToggle /><Link data-testid="scripts-link" to="/cdp/scripts">测试导航</Link></>
}
async function mount() {
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/cdp"]}>
      <Routes><Route path="/cdp" element={<CdpLayout />}><Route index element={<Page />} /><Route path="scripts" element={<Page />} /></Route></Routes>
    </MemoryRouter>,
  ))
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  vi.clearAllMocks()
  vi.mocked(browserApi.sessions).mockResolvedValue({ items: [] })
  localStorage.removeItem(SESSION_PANEL_COLLAPSED_KEY)
  container = document.createElement("div")
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  localStorage.removeItem(SESSION_PANEL_COLLAPSED_KEY)
})

it("页头按钮将侧栏完全收起并持久化，切换子页后仍可展开", async () => {
  await mount()
  const sidebar = () => container.querySelector<HTMLElement>('[aria-label="浏览器导航栏"]')!
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="收起浏览器导航"]')!.click())
  expect(sidebar().classList.contains("w-0")).toBe(true)
  expect(sidebar().getAttribute("aria-hidden")).toBe("true")
  expect(sidebar().hasAttribute("inert")).toBe(true)
  expect(localStorage.getItem(SESSION_PANEL_COLLAPSED_KEY)).toBe("1")
  await act(async () => container.querySelector<HTMLAnchorElement>('[data-testid="scripts-link"]')!.click())
  expect(sidebar().getAttribute("aria-hidden")).toBe("true")
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="展开浏览器导航"]')!.click())
  expect(sidebar().getAttribute("aria-hidden")).toBe("false")
  expect(sidebar().classList.contains("w-60")).toBe(true)
  expect(container.querySelector('[aria-label="刷新最近任务"]')).toBeNull()
})

it("桌面和移动导航都只显示一个应用入口", async () => {
  await mount()
  const desktop = container.querySelector('[aria-label="浏览器工作区导航"]')!
  const mobile = container.querySelector('[aria-label="浏览器导航"]')!
  expect(desktop.querySelectorAll('a[href="/cdp/apps"]')).toHaveLength(1)
  expect(mobile.querySelectorAll('a[href="/cdp/apps"]')).toHaveLength(1)
  expect(container.querySelectorAll('a[href="/cdp/instruction-apps"]')).toHaveLength(0)
})

it("自动化应用详情页可收起侧栏并重新展开", async () => {
  await act(async () => root.render(
    <MemoryRouter initialEntries={["/cdp/apps/auto_x"]}>
      <Routes>
        <Route path="/cdp" element={<CdpLayout />}>
          <Route path="apps" element={<AutomationsPage />} />
          <Route path="apps/:automationId" element={<AutomationDetailPage />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  ))
  const sidebar = () => container.querySelector<HTMLElement>('[aria-label="浏览器导航栏"]')!
  const toggle = () => container.querySelector<HTMLButtonElement>('[aria-label="收起浏览器导航"], [aria-label="展开浏览器导航"]')
  for (let i = 0; i < 30 && !toggle(); i++) await act(async () => new Promise((resolve) => setTimeout(resolve, 50)))
  expect(toggle()).not.toBeNull()
  await act(async () => toggle()!.click())
  expect(sidebar().classList.contains("w-0")).toBe(true)
  expect(localStorage.getItem(SESSION_PANEL_COLLAPSED_KEY)).toBe("1")
  await act(async () => toggle()!.click())
  expect(sidebar().classList.contains("w-60")).toBe(true)
  expect(localStorage.getItem(SESSION_PANEL_COLLAPSED_KEY)).toBe("0")
})

it("沿用自由对话的折叠偏好与 Ctrl+B 快捷键", async () => {
  localStorage.setItem(SESSION_PANEL_COLLAPSED_KEY, "1")
  await mount()
  expect(container.querySelector('[aria-label="展开浏览器导航"]')).not.toBeNull()
  await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "b", ctrlKey: true, bubbles: true })))
  expect(container.querySelector('[aria-label="收起浏览器导航"]')).not.toBeNull()
  expect(localStorage.getItem(SESSION_PANEL_COLLAPSED_KEY)).toBe("0")
})

it("仅列表加载失败时显示重试，成功后自动移除", async () => {
  vi.mocked(browserApi.sessions).mockRejectedValueOnce(new Error("任务列表加载失败"))
  await mount()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("任务列表加载失败")
  const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "重试")!
  await act(async () => retry.click())
  expect(browserApi.sessions).toHaveBeenCalledTimes(2)
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect([...container.querySelectorAll("button")].some((button) => button.textContent === "重试")).toBe(false)
})

it("切换页面只给内容容器添加过渡，不重挂布局；减少动态效果时不播放", async () => {
  const animate = vi.fn((_frames: unknown, _options: unknown) => ({ cancel: vi.fn() }))
  const original = HTMLElement.prototype.animate
  HTMLElement.prototype.animate = animate as never
  const matchMedia = window.matchMedia
  window.matchMedia = vi.fn((query: string) => ({ matches: false, media: query })) as never
  try {
    await mount()
    const sidebar = container.querySelector('[aria-label="浏览器导航栏"]')
    const content = container.querySelector(".cdp-route-content")
    await act(async () => container.querySelector<HTMLAnchorElement>('[data-testid="scripts-link"]')!.click())
    expect(container.querySelector('[aria-label="浏览器导航栏"]')).toBe(sidebar)
    expect(container.querySelector(".cdp-route-content")).toBe(content)
    expect(animate).toHaveBeenCalledTimes(1)
    expect(animate.mock.calls[0]?.[1]).toMatchObject({ duration: 190 })
  } finally {
    HTMLElement.prototype.animate = original
    window.matchMedia = matchMedia
  }
})

it("减少动态效果时切换页面不播放动画", async () => {
  const animate = vi.fn()
  const original = HTMLElement.prototype.animate
  const matchMedia = window.matchMedia
  HTMLElement.prototype.animate = animate as never
  window.matchMedia = vi.fn((query: string) => ({ matches: query.includes("prefers-reduced-motion"), media: query })) as never
  try {
    await mount()
    await act(async () => container.querySelector<HTMLAnchorElement>('[data-testid="scripts-link"]')!.click())
    expect(animate).not.toHaveBeenCalled()
  } finally {
    HTMLElement.prototype.animate = original
    window.matchMedia = matchMedia
  }
})
