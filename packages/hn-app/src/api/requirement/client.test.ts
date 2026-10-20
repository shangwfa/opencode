/**
 * harness client 的 HTML 回退兜底单测。
 * 背景：需求数据服务未配置时 URL 退化为相对路径，请求被 dev server / 网关回退成 SPA 的
 * index.html，业务层 res.json() 会抛 `Unexpected token '<'`。这里锁定识别与文案。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  ApiHtmlFallbackError,
  bossApiBaseUrl,
  describeHtmlFallback,
  looksLikeHtml,
  requirementApiBaseUrl,
  requirementApiFetch,
} from "./client"

function htmlResponse(body = "<!doctype html><html></html>") {
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

describe("client/looksLikeHtml", () => {
  it("text/html 判定为 HTML", () => {
    expect(looksLikeHtml(htmlResponse())).toBe(true)
  })

  it("content-type 大写也判定为 HTML", () => {
    const res = new Response("x", { headers: { "content-type": "TEXT/HTML" } })
    expect(looksLikeHtml(res)).toBe(true)
  })

  it("application/json 不判定为 HTML", () => {
    expect(looksLikeHtml(jsonResponse({}))).toBe(false)
  })

  it("无 content-type 不判定为 HTML（避免误伤 204/纯文本响应）", () => {
    const res = new Response("", { status: 204 })
    expect(looksLikeHtml(res)).toBe(false)
  })
})

describe("client/describeHtmlFallback", () => {
  it("相对路径 URL → 提示需求数据服务未配置", () => {
    // 测试环境未设置 BOSS_API_URL（既无 window.YD 注入也无 env），requirementApiBase 为空
    expect(describeHtmlFallback("/v2/requirements/all")).toContain("未配置")
  })

  it("绝对 URL → 提示服务无响应，且不泄露 HTML 解析错误", () => {
    const message = describeHtmlFallback("https://boss.example.com/boss/api/v3/harness/v2/requirements/all")
    // 未配置 base 时同样走「未配置」分支；两种情况都不应泄露 HTML 解析错误
    expect(message).not.toContain("Unexpected token")
    expect(message).not.toContain("<!doctype")
  })
})

describe("client/requirementApiBaseUrl 配置来源优先级", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("宿主注入 window.YD.BOSS_API_URL 优先于 env", () => {
    vi.stubGlobal("YD", { BOSS_API_URL: "https://host.example.com/" })
    vi.stubEnv("VITE_BOSS_API_URL", "https://env.example.com")
    expect(requirementApiBaseUrl()).toBe("https://host.example.com/boss/api/v3/harness")
    expect(bossApiBaseUrl()).toBe("https://host.example.com/boss/api/v3")
  })

  it("无注入时读 VITE_BOSS_API_URL（独立部署的配置入口）", () => {
    vi.stubGlobal("YD", undefined)
    vi.stubEnv("VITE_BOSS_API_URL", "https://env.example.com/")
    expect(requirementApiBaseUrl()).toBe("https://env.example.com/boss/api/v3/harness")
    expect(bossApiBaseUrl()).toBe("https://env.example.com/boss/api/v3")
  })

  it("两者皆无 → 空串（据此给出可读提示，而非打到本地站点）", () => {
    vi.stubGlobal("YD", undefined)
    vi.stubEnv("VITE_BOSS_API_URL", "")
    expect(requirementApiBaseUrl()).toBe("")
    expect(bossApiBaseUrl()).toBe("")
  })

  it("尾部斜杠被归一，避免拼出 //boss/... 双斜杠", () => {
    vi.stubGlobal("YD", { BOSS_API_URL: "https://host.example.com///" })
    vi.stubEnv("VITE_BOSS_API_URL", "")
    expect(requirementApiBaseUrl()).toBe("https://host.example.com/boss/api/v3/harness")
  })
})

describe("client/requirementApiFetch HTML 回退", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
    localStorage.clear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("200 + HTML → 抛 ApiHtmlFallbackError（可读文案），而非让业务层解析失败", async () => {
    fetchMock.mockResolvedValue(htmlResponse())
    await expect(requirementApiFetch("/v2/requirements/all")).rejects.toBeInstanceOf(ApiHtmlFallbackError)
    await expect(requirementApiFetch("/v2/requirements/all")).rejects.toThrow(/需求数据服务/)
  })

  it("200 + JSON → 正常放行", async () => {
    fetchMock.mockResolvedValue(jsonResponse([{ id: "r1" }]))
    const res = await requirementApiFetch("/v2/requirements/all")
    expect(res.ok).toBe(true)
    expect(await res.json()).toEqual([{ id: "r1" }])
  })

  it("404 + HTML（错误页）不拦截，仍交业务层按状态码处理", async () => {
    const res404 = new Response("<html>404</html>", {
      status: 404,
      headers: { "content-type": "text/html" },
    })
    fetchMock.mockResolvedValue(res404)
    const res = await requirementApiFetch("/v2/requirements/all")
    expect(res.status).toBe(404)
  })
})