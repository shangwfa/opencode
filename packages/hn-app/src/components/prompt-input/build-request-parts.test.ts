import { describe, expect, test } from "vitest"
import type { Prompt } from "@/context/prompt"
import { buildRequestParts } from "./build-request-parts"

describe("buildRequestParts", () => {
  test("builds typed request and optimistic parts without cast path", () => {
    const prompt: Prompt = [
      { type: "text", content: "hello", start: 0, end: 5 },
      {
        type: "file",
        path: "src/foo.ts",
        content: "@src/foo.ts",
        start: 5,
        end: 16,
        selection: { startLine: 4, startChar: 1, endLine: 6, endChar: 1 },
      },
      { type: "agent", name: "planner", content: "@planner", start: 16, end: 24 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [{ key: "ctx:1", type: "file", path: "src/bar.ts", comment: "check this" }],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
      ],
      text: "hello @src/foo.ts @planner",
      messageID: "msg_1",
      sessionID: "ses_1",
      sessionDirectory: "/repo",
    })

    expect(result.requestParts[0]?.type).toBe("text")
    expect(result.requestParts.some((part) => part.type === "agent")).toBe(true)
    expect(
      result.requestParts.some((part) => part.type === "file" && part.url.startsWith("file:///repo/src/foo.ts")),
    ).toBe(true)
    expect(result.requestParts.some((part) => part.type === "text" && part.synthetic)).toBe(true)
    expect(
      result.requestParts.some(
        (part) =>
          part.type === "text" &&
          part.synthetic &&
          part.metadata?.opencodeComment &&
          (part.metadata.opencodeComment as { comment?: string }).comment === "check this",
      ),
    ).toBe(true)

    expect(result.optimisticParts).toHaveLength(result.requestParts.length)
    expect(result.optimisticParts.every((part) => part.sessionID === "ses_1" && part.messageID === "msg_1")).toBe(true)
  })

  test("keeps multiple uploaded attachments in order", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "check these", start: 0, end: 11 }],
      context: [],
      images: [
        { type: "image", id: "img_1", filename: "a.png", mime: "image/png", dataUrl: "data:image/png;base64,AAA" },
        {
          type: "image",
          id: "img_2",
          filename: "b.pdf",
          mime: "application/pdf",
          dataUrl: "data:application/pdf;base64,BBB",
        },
      ],
      text: "check these",
      messageID: "msg_multi",
      sessionID: "ses_multi",
      sessionDirectory: "/repo",
    })

    const files = result.requestParts.filter((part) => part.type === "file" && part.url.startsWith("data:"))

    expect(files).toHaveLength(2)
    expect(files.map((part) => (part.type === "file" ? part.filename : ""))).toEqual(["a.png", "b.pdf"])
  })

  test("does not emit base64 file part for unsupported media types but keeps OSS link in text", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "implement this", start: 0, end: 14 }],
      context: [],
      images: [
        {
          type: "image",
          id: "img_zip",
          filename: "优化.zip",
          mime: "application/zip",
          dataUrl: "data:application/zip;base64,UEsDBAoAAAAIAMA",
          ossUrl: "https://cdn.example.com/优化.zip",
        },
        {
          type: "image",
          id: "img_png",
          filename: "screenshot.png",
          mime: "image/png",
          dataUrl: "data:image/png;base64,AAA",
          ossUrl: "https://cdn.example.com/screenshot.png",
        },
      ],
      text: "implement this",
      messageID: "msg_zip",
      sessionID: "ses_zip",
      sessionDirectory: "/repo",
    })

    const dataFileParts = result.requestParts.filter(
      (part) => part.type === "file" && part.url.startsWith("data:"),
    )

    expect(dataFileParts).toHaveLength(1)
    expect(dataFileParts[0]?.type === "file" && dataFileParts[0].filename).toBe("screenshot.png")

    const textPart = result.requestParts.find((part) => part.type === "text")
    expect(textPart?.type === "text" && textPart.text).toContain("https://cdn.example.com/优化.zip")
    expect(textPart?.type === "text" && textPart.text).toContain("优化.zip")
    expect(textPart?.type === "text" && textPart.text).toContain("application/zip")
  })

  test("does not emit base64 file part for svg but keeps OSS link in text", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "use this icon", start: 0, end: 13 }],
      context: [],
      images: [
        {
          type: "image",
          id: "img_svg",
          filename: "logo.svg",
          mime: "image/svg+xml",
          dataUrl: "data:image/svg+xml;base64,PHN2Zz4=",
          ossUrl: "https://cdn.example.com/logo.svg",
        },
      ],
      text: "use this icon",
      messageID: "msg_svg",
      sessionID: "ses_svg",
      sessionDirectory: "/repo",
    })

    const dataFileParts = result.requestParts.filter(
      (part) => part.type === "file" && part.url.startsWith("data:"),
    )

    expect(dataFileParts).toHaveLength(0)

    const textPart = result.requestParts.find((part) => part.type === "text")
    expect(textPart?.type === "text" && textPart.text).toContain("https://cdn.example.com/logo.svg")
    expect(textPart?.type === "text" && textPart.text).toContain("logo.svg")
    expect(textPart?.type === "text" && textPart.text).toContain("image/svg+xml")
  })

  test("deduplicates context files when prompt already includes same path", () => {
    const prompt: Prompt = [{ type: "file", path: "src/foo.ts", content: "@src/foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:dup", type: "file", path: "src/foo.ts" },
        { key: "ctx:comment", type: "file", path: "src/foo.ts", comment: "focus here" },
      ],
      images: [],
      text: "@src/foo.ts",
      messageID: "msg_2",
      sessionID: "ses_2",
      sessionDirectory: "/repo",
    })

    const fooFiles = result.requestParts.filter(
      (part) => part.type === "file" && part.url.startsWith("file:///repo/src/foo.ts"),
    )
    const synthetic = result.requestParts.filter((part) => part.type === "text" && part.synthetic)

    expect(fooFiles).toHaveLength(2)
    expect(synthetic).toHaveLength(1)
  })

  test("adds file parts for @mentions inside comment text", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "look", start: 0, end: 4 }],
      context: [
        {
          key: "ctx:comment-mention",
          type: "file",
          path: "src/review.ts",
          comment: "Compare with @src/shared.ts and @src/review.ts.",
        },
      ],
      images: [],
      text: "look",
      messageID: "msg_comment_mentions",
      sessionID: "ses_comment_mentions",
      sessionDirectory: "/repo",
    })

    const files = result.requestParts.filter((part) => part.type === "file")
    expect(files).toHaveLength(2)
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo/src/review.ts")).toBe(true)
    expect(files.some((part) => part.type === "file" && part.url === "file:///repo/src/shared.ts")).toBe(true)
  })

  test("handles Windows paths correctly (simulated on macOS)", () => {
    const prompt: Prompt = [{ type: "file", path: "src\\foo.ts", content: "@src\\foo.ts", start: 0, end: 11 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\foo.ts",
      messageID: "msg_win_1",
      sessionID: "ses_win_1",
      sessionDirectory: "D:\\projects\\myapp", // Windows path
    })

    // Should create valid file URLs
    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should not have encoded backslashes in wrong place
      expect(filePart.url).not.toContain("%5C")
      // Should have normalized to forward slashes
      expect(filePart.url).toContain("/src/foo.ts")
    }
  })

  test("handles Windows absolute path with special characters", () => {
    const prompt: Prompt = [{ type: "file", path: "file#name.txt", content: "@file#name.txt", start: 0, end: 14 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@file#name.txt",
      messageID: "msg_win_2",
      sessionID: "ses_win_2",
      sessionDirectory: "C:\\Users\\test\\Documents", // Windows path
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Special chars should be encoded
      expect(filePart.url).toContain("file%23name.txt")
      // Should have Windows drive letter properly encoded
      expect(filePart.url).toMatch(/file:\/\/\/[A-Z]:/)
    }
  })

  test("handles Linux absolute paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "src/app.ts", content: "@src/app.ts", start: 0, end: 10 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src/app.ts",
      messageID: "msg_linux_1",
      sessionID: "ses_linux_1",
      sessionDirectory: "/home/user/project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should be a normal Unix path
      expect(filePart.url).toBe("file:///home/user/project/src/app.ts")
    }
  })

  test("handles macOS paths correctly", () => {
    const prompt: Prompt = [{ type: "file", path: "README.md", content: "@README.md", start: 0, end: 9 }]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@README.md",
      messageID: "msg_mac_1",
      sessionID: "ses_mac_1",
      sessionDirectory: "/Users/kelvin/Projects/opencode",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // URL should be parseable
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should be a normal Unix path
      expect(filePart.url).toBe("file:///Users/kelvin/Projects/opencode/README.md")
    }
  })

  test("handles context files with Windows paths", () => {
    const prompt: Prompt = []

    const result = buildRequestParts({
      prompt,
      context: [
        { key: "ctx:1", type: "file", path: "src\\utils\\helper.ts" },
        { key: "ctx:2", type: "file", path: "test\\unit.test.ts", comment: "check tests" },
      ],
      images: [],
      text: "test",
      messageID: "msg_win_ctx",
      sessionID: "ses_win_ctx",
      sessionDirectory: "D:\\workspace\\app",
    })

    const fileParts = result.requestParts.filter((part) => part.type === "file")
    expect(fileParts).toHaveLength(2)

    // All file URLs should be valid
    fileParts.forEach((part) => {
      if (part.type === "file") {
        expect(() => new URL(part.url)).not.toThrow()
        expect(part.url).not.toContain("%5C") // No encoded backslashes
      }
    })
  })

  test("handles absolute Windows paths (user manually specifies full path)", () => {
    const prompt: Prompt = [
      { type: "file", path: "D:\\other\\project\\file.ts", content: "@D:\\other\\project\\file.ts", start: 0, end: 25 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@D:\\other\\project\\file.ts",
      messageID: "msg_abs",
      sessionID: "ses_abs",
      sessionDirectory: "C:\\current\\project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should handle absolute path that differs from sessionDirectory
      expect(() => new URL(filePart.url)).not.toThrow()
      expect(filePart.url).toContain("/D:/other/project/file.ts")
    }
  })

  test("handles selection with query parameters on Windows", () => {
    const prompt: Prompt = [
      {
        type: "file",
        path: "src\\App.tsx",
        content: "@src\\App.tsx",
        start: 0,
        end: 11,
        selection: { startLine: 10, startChar: 0, endLine: 20, endChar: 5 },
      },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@src\\App.tsx",
      messageID: "msg_sel",
      sessionID: "ses_sel",
      sessionDirectory: "C:\\project",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should have query parameters
      expect(filePart.url).toContain("?start=10&end=20")
      // Should be valid URL
      expect(() => new URL(filePart.url)).not.toThrow()
      // Query params should parse correctly
      const url = new URL(filePart.url)
      expect(url.searchParams.get("start")).toBe("10")
      expect(url.searchParams.get("end")).toBe("20")
    }
  })

  test("merges syntheticText into the visible user text part", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "hello", start: 0, end: 5 }],
      context: [],
      images: [],
      text: "hello",
      syntheticText: "[Selected UI context]\n\nNode 1\n- tag: button",
      messageID: "msg_sel_ctx",
      sessionID: "ses_sel_ctx",
      sessionDirectory: "/repo",
    })

    const textParts = result.requestParts.filter((part) => part.type === "text")
    // No standalone synthetic part for the selection context anymore.
    expect(textParts.filter((part) => (part as { synthetic?: boolean }).synthetic)).toHaveLength(0)

    const userTextPart = textParts[0]
    expect(userTextPart).toBeDefined()
    if (userTextPart?.type === "text") {
      expect(userTextPart.text).toBe("hello\n\n[Selected UI context]\n\nNode 1\n- tag: button")
      expect((userTextPart as { synthetic?: boolean }).synthetic).toBeFalsy()
    }
  })

  test("uses syntheticText alone when user text is empty", () => {
    const result = buildRequestParts({
      prompt: [],
      context: [],
      images: [],
      text: "",
      syntheticText: "[Selected UI context]",
      messageID: "msg_sel_empty",
      sessionID: "ses_sel_empty",
      sessionDirectory: "/repo",
    })

    const textPart = result.requestParts.find((part) => part.type === "text")
    expect(textPart).toBeDefined()
    if (textPart?.type === "text") {
      expect(textPart.text).toBe("[Selected UI context]")
    }
  })

  test("keeps runtime context in a hidden synthetic part", () => {
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "hello", start: 0, end: 5 }],
      context: [],
      images: [],
      text: "hello",
      runtimeContextText:
        "[Artifact Generation Context]\nartifactGenerationMode: detailed",
      messageID: "msg_runtime_ctx",
      sessionID: "ses_runtime_ctx",
      sessionDirectory: "/repo",
    })

    const textParts = result.requestParts.filter((part) => part.type === "text")
    expect(textParts).toHaveLength(2)
    expect(textParts[0]).toMatchObject({ text: "hello" })
    expect(textParts[1]).toMatchObject({
      synthetic: true,
      text: "[Artifact Generation Context]\nartifactGenerationMode: detailed",
    })
    expect(result.optimisticParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ synthetic: true }),
      ]),
    )
  })

  test("keeps automation credentials out of the visible user text", () => {
    const runtimeContextText =
      '[Artifact Generation Context]\nartifactGenerationMode: concise\n\n[Automation Context]\n{"preview_url":"https://preview.example.com/app","access_token":"secret-token"}'
    const result = buildRequestParts({
      prompt: [{ type: "text", content: "verify login", start: 0, end: 12 }],
      context: [],
      images: [],
      text: "verify login",
      runtimeContextText,
      messageID: "msg_automation_ctx",
      sessionID: "ses_automation_ctx",
      sessionDirectory: "/repo",
    })

    const textParts = result.requestParts.filter((part) => part.type === "text")
    expect(textParts[0]).toMatchObject({ text: "verify login" })
    expect(textParts[0]?.type === "text" && textParts[0].text).not.toContain(
      "secret-token",
    )
    expect(textParts[1]).toMatchObject({
      synthetic: true,
      text: runtimeContextText,
    })
  })

  test("handles file paths with dots and special segments on Windows", () => {
    const prompt: Prompt = [
      { type: "file", path: "..\\..\\shared\\util.ts", content: "@..\\..\\shared\\util.ts", start: 0, end: 21 },
    ]

    const result = buildRequestParts({
      prompt,
      context: [],
      images: [],
      text: "@..\\..\\shared\\util.ts",
      messageID: "msg_dots",
      sessionID: "ses_dots",
      sessionDirectory: "C:\\projects\\myapp\\src",
    })

    const filePart = result.requestParts.find((part) => part.type === "file")
    expect(filePart).toBeDefined()
    if (filePart?.type === "file") {
      // Should be valid URL
      expect(() => new URL(filePart.url)).not.toThrow()
      // Should preserve .. segments (backend normalizes)
      expect(filePart.url).toContain("/..")
    }
  })
})
