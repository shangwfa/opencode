import { describe, expect, it } from "vitest"
import {
  filenameOf,
  guessMimeType,
  isPreviewableFileHref,
  parentDirectoryOf,
  parseSandboxFileHref,
  previewKindOf,
} from "./file-preview-url"

describe("parseSandboxFileHref", () => {
  it("解析 file:// 绝对路径", () => {
    expect(parseSandboxFileHref("file:///workspace/demo.html")).toEqual({
      path: "/workspace/demo.html",
      filename: "demo.html",
    })
  })

  it("解析带 localhost 的 file:// 形式", () => {
    expect(parseSandboxFileHref("file://localhost/workspace/a/b.md")?.path).toBe("/workspace/a/b.md")
  })

  it("百分号编码解码", () => {
    expect(parseSandboxFileHref("file:///workspace/my%20page.html")?.path).toBe("/workspace/my page.html")
  })

  it("去掉 query 与 hash", () => {
    expect(parseSandboxFileHref("file:///workspace/a.html?v=1#top")?.path).toBe("/workspace/a.html")
  })

  it("识别裸绝对路径", () => {
    expect(parseSandboxFileHref("/workspace/demo.html")?.filename).toBe("demo.html")
  })

  it("拒绝 http(s)、相对路径与空值", () => {
    expect(parseSandboxFileHref("https://example.com/a.html")).toBeNull()
    expect(parseSandboxFileHref("./a.html")).toBeNull()
    expect(parseSandboxFileHref("")).toBeNull()
    expect(parseSandboxFileHref(undefined)).toBeNull()
    expect(parseSandboxFileHref("file://")).toBeNull()
    expect(parseSandboxFileHref("file:///")).toBeNull()
  })
})

describe("previewKindOf", () => {
  it("html 走 iframe 预览", () => {
    expect(previewKindOf("/workspace/a.html")).toBe("html")
    expect(previewKindOf("/workspace/a.htm")).toBe("html")
  })

  it("图片 / markdown / 文本分类", () => {
    expect(previewKindOf("/workspace/a.png")).toBe("image")
    expect(previewKindOf("/workspace/a.SVG")).toBe("image")
    expect(previewKindOf("/workspace/a.md")).toBe("markdown")
    expect(previewKindOf("/workspace/a.json")).toBe("text")
    expect(previewKindOf("/workspace/a.ts")).toBe("text")
  })

  it("无扩展名或未知类型不支持", () => {
    expect(previewKindOf("/workspace/Makefile")).toBe("unsupported")
    expect(previewKindOf("/workspace/a.zip")).toBe("unsupported")
  })
})

describe("isPreviewableFileHref", () => {
  it("仅 file 链接且类型可预览时为 true", () => {
    expect(isPreviewableFileHref("file:///workspace/a.html")).toBe(true)
    expect(isPreviewableFileHref("file:///workspace/a.zip")).toBe(false)
    expect(isPreviewableFileHref("https://example.com")).toBe(false)
  })
})

describe("filenameOf / guessMimeType", () => {
  it("取文件名并忽略 query", () => {
    expect(filenameOf("/workspace/a/b.html?v=2")).toBe("b.html")
  })

  it("推断 MIME", () => {
    expect(guessMimeType("/workspace/a.png")).toBe("image/png")
    expect(guessMimeType("/workspace/a.html")).toBe("text/html")
    expect(guessMimeType("/workspace/a.unknown")).toBe("text/plain")
  })
})
describe("parentDirectoryOf", () => {
  it("取父目录", () => {
    expect(parentDirectoryOf("/workspace/a/b.html")).toBe("/workspace/a")
    expect(parentDirectoryOf("/a.html")).toBe("/")
  })
})
