import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router"
import { afterEach, expect, it, vi } from "vitest"
import { signIn } from "@/lib/auth"
import { LoginPage } from "./login"

vi.mock("@/lib/auth", () => ({
  authEnabled: true,
  fetchAuthConfig: vi.fn(async () => ({ providers: [] })),
  signIn: vi.fn(async () => ({})),
  signUp: vi.fn(async () => ({})),
  signInSocial: vi.fn(async () => ({})),
  useAuth: () => ({ loading: false, user: null, refresh: vi.fn(async () => {}) }),
}))
vi.mock("@/components/toast", () => ({ useToast: () => vi.fn() }))
vi.mock("@/components/auth-gate", () => ({ AuthGate: ({ children }: { children: unknown }) => children }))

let container: HTMLDivElement | null = null
afterEach(() => { container?.remove(); container = null })

it("浏览器自动填充未触发 onChange 时，登录使用表单实际值", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes><Route path="/login" element={<LoginPage />} /><Route path="/" element={<div>首页</div>} /></Routes>
      </MemoryRouter>,
    ))
    // 模拟 Chrome 自动填充：只改 DOM 值，不派发 input 事件（React state 仍是空串）。
    const email = container.querySelector<HTMLInputElement>("#email")!
    const password = container.querySelector<HTMLInputElement>("#password")!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(email, "demo@example.com ")
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(password, "ab123456")
    })
    await act(async () => container!.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    expect(signIn).toHaveBeenCalledWith("demo@example.com", "ab123456")
  } finally {
    await act(async () => root.unmount())
  }
}, 30_000)
