import { describe, expect, it } from "vitest"
import { browserPrompt, normalizeBrowserUrl, readBrowserFrames } from "./browser"
import { browserCoordinates } from "@/features/browser-cdp/browser-panel"
import { visibleFormFields } from "@/features/browser-cdp/session-forms"
import type { Form } from "@opencode/schema/form"

describe("浏览器任务迁移", () => {
  it("普通任务、走查和流程参数不会互相覆盖", () => {
    expect(browserPrompt("  打开官网  ", false)).toBe("打开官网")
    expect(browserPrompt("检查登录", true)).toBe("UI走查：检查登录")
    expect(browserPrompt("城市=杭州", false, "/workspace/output/published-script.js")).toContain("城市=杭州")
    expect(browserPrompt("检查登录", true, "/workspace/output/published-script.js")).toContain("UI走查：检查登录")
  })
  it("地址补全并保持端口、查询和片段", () => {
    expect(normalizeBrowserUrl("example.com/path?q=1#top")).toBe("https://example.com/path?q=1#top")
    expect(normalizeBrowserUrl("localhost:3000/test")).toBe("https://localhost:3000/test")
    expect(normalizeBrowserUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000/")
  })
  it.each(["", "javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "ftp://example.com", "foo bar"])(
    "拒绝危险或无效地址 %s",
    (value) => {
      expect(() => normalizeBrowserUrl(value)).toThrow()
    },
  )
  it("坐标按实际图像尺寸缩放，边界不越界", () => {
    const rect = { left: 100, top: 50, width: 500, height: 300 }
    expect(browserCoordinates(350, 200, rect, 1000, 600)).toEqual({ x: 500, y: 300 })
    expect(browserCoordinates(0, 0, rect, 1000, 600)).toEqual({ x: 0, y: 0 })
    expect(browserCoordinates(2000, 2000, rect, 1000, 600)).toEqual({ x: 999, y: 599 })
  })
  it("画面 SSE 支持跨 chunk、CRLF、心跳和多行 data", async () => {
    const chunks = [
      ": heartbeat\r\n\r\nda",
      'ta: {\r\ndata: "data":"帧"}\r\n\r\n',
      'data: {"connected":true}\n\n',
      "data: invalid\n\n",
    ]
    const response = new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
          controller.close()
        },
      }),
    )
    const frames: unknown[] = []
    await readBrowserFrames(response, (frame) => frames.push(frame))
    expect(frames).toEqual([{ data: "帧" }, { connected: true }])
  })
  it("SSE 认证失败不能被显示为正常画面", async () => {
    await expect(readBrowserFrames(new Response(null, { status: 401 }), () => {})).rejects.toThrow("401")
  })
  it("表单隐藏字段及其依赖不参与回答", () => {
    const fields: Form.Field[] = [
      { key: "mode", type: "string" },
      { key: "city", type: "string", when: [{ key: "mode", op: "eq", value: "query" }] },
      { key: "district", type: "string", when: [{ key: "city", op: "eq", value: "杭州" }] },
      { key: "other", type: "string", when: [{ key: "mode", op: "neq", value: "query" }] },
    ]
    expect(visibleFormFields(fields, { mode: "review", city: "杭州" }).map((field) => field.key)).toEqual([
      "mode",
      "other",
    ])
    expect(visibleFormFields(fields, {}).map((field) => field.key)).toEqual(["mode"])
    expect(visibleFormFields(fields, { mode: "query", city: "杭州" }).map((field) => field.key)).toEqual([
      "mode",
      "city",
      "district",
    ])
  })
})
