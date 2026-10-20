import { describe, expect, test } from "vitest"
import { fileContentToMarkdown, parseArtifactContent } from "./parse-artifact-content"

describe("parseArtifactContent", () => {
  test("returns plain markdown as-is", () => {
    expect(parseArtifactContent("# Title\n\nbody")).toBe("# Title\n\nbody")
  })

  test("extracts text from FileContent JSON body", () => {
    const raw = JSON.stringify({ type: "text", content: "# Hello\n\nworld" })
    expect(parseArtifactContent(raw)).toBe("# Hello\n\nworld")
  })

  test("extracts text parts array", () => {
    const raw = JSON.stringify({
      parts: [
        { type: "text", text: "line one" },
        { type: "text", content: "line two" },
      ],
    })
    expect(parseArtifactContent(raw)).toBe("line one\n\nline two")
  })
})

describe("fileContentToMarkdown", () => {
  test("maps sdk FileContent", () => {
    expect(fileContentToMarkdown({ type: "text", content: "## Spec" })).toBe("## Spec")
  })

  test("parses nested json in content field", () => {
    expect(
      fileContentToMarkdown({
        type: "text",
        content: JSON.stringify({ type: "text", content: "nested" }),
      }),
    ).toBe("nested")
  })
})
