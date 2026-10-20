import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { saasCreateSession, saasRunShell, saasFetch, saasMcpFetch } from "../src/lib/saas.js"

type Call = { url: string; init?: RequestInit }

const originalFetch = globalThis.fetch
let calls: Call[] = []

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    return handler(url, init)
  }) as typeof fetch
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
const html = () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })

beforeEach(() => {
  calls = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("saasCreateSession", () => {
  test("用 body.location 指定工作目录（query 不生效）", async () => {
    mockFetch(() => json({ data: { id: "ses_v2" } }))

    const id = await saasCreateSession({ directory: "/workspace", title: "需求", agent: "build" })

    expect(id).toBe("ses_v2")
    const call = calls[0]!
    expect(call.url).toContain("/api/session")
    expect(JSON.parse(String(call.init?.body))).toEqual({
      title: "需求",
      agent: "build",
      location: { directory: "/workspace" },
    })
  })

  test("创建失败时直接抛错", async () => {
    mockFetch(() => html())

    expect(saasCreateSession({ directory: "/workspace" })).rejects.toThrow("创建会话失败")
    expect(calls).toHaveLength(1)
  })
})

describe("saasRunShell", () => {
  test("从结束事件读取真实退出码和同级 output", async () => {
    mockFetch((url) => url.includes("/log?")
      ? json([{ type: "session.shell.ended", data: {
          shell: { command: "printf probe", exit: 0, status: "exited" },
          output: { output: "probe" },
        } }])
      : new Response(null, { status: 204 }))
    expect(await saasRunShell("ses_1", "printf probe")).toEqual({ exit: 0, output: "probe" })
    expect(calls.every((call) => new URL(call.url).pathname.startsWith("/api/"))).toBe(true)
  })
  test("沙箱命令接口缺失时拒绝在宿主机执行", async () => {
    mockFetch((url) =>
      url.includes("/api/session/")
        ? html()
        : json({ parts: [{ type: "tool", state: { status: "completed", output: "PREPARE_OK\n" } }] }),
    )

    await expect(saasRunShell("ses_1", "git clone x", {
      successMarker: "PREPARE_OK",
      messageID: "msg_prepare_abc",
    })).rejects.toThrow("命令未执行")
    expect(calls).toHaveLength(1)
  })

  test("沙箱命令接口失败时不重复执行", async () => {
    mockFetch((url) =>
      url.includes("/api/session/")
        ? new Response("不可用", { status: 503 })
        : json({ parts: [{ type: "tool", state: { status: "completed", output: "fatal: boom" } }] }),
    )

    await expect(saasRunShell("ses_1", "git clone x")).rejects.toThrow("命令未执行")
    expect(calls).toHaveLength(1)
  })
})

describe("MCP 专用凭据通道", () => {
  test("普通服务调用始终使用服务身份，不信任传入的 Authorization", async () => {
    mockFetch(() => json({}))
    await saasFetch("/api/info", { headers: { authorization: "Bearer untrusted" } })
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toStartWith("Basic ")
  })
  test("MCP 通道保留 Bearer 和协议头，禁止跟随重定向", async () => {
    mockFetch(() => new Response(null, { status: 202 }))
    const path = `/api/connector/mcp/cmcp_${"a".repeat(32)}`
    const response = await saasMcpFetch(path, { method: "POST", headers: { authorization: "Bearer test", "mcp-protocol-version": "2025-06-18" }, body: "{}" })
    expect(response.status).toBe(202)
    expect(new Headers(calls[0]?.init?.headers).get("authorization")).toBe("Bearer test")
    expect(new Headers(calls[0]?.init?.headers).get("mcp-protocol-version")).toBe("2025-06-18")
    expect(calls[0]?.init?.redirect).toBe("manual")
  })
  test("拒绝将 MCP 凭据发往任意 API、查询参数或路径穿越地址", async () => {
    mockFetch(() => json({}))
    for (const path of ["/api/info", "/api/connector/mcp/../info", "/api/connector/mcp?url=https://evil.invalid", "https://evil.invalid/api/connector/mcp"]) {
      await expect(saasMcpFetch(path, { headers: { authorization: "Bearer test" } })).rejects.toThrow("无效")
    }
    expect(calls).toHaveLength(0)
  })
  test("缺少 Bearer 时不向上游发请求", async () => {
    mockFetch(() => json({}))
    await expect(saasMcpFetch("/api/connector/mcp", { headers: { authorization: "Basic test" } })).rejects.toThrow("凭据")
    expect(calls).toHaveLength(0)
  })
})
