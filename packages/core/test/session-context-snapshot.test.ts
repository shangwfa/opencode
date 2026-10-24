import { describe, expect, test } from "bun:test"
import { LLM, Message, SystemPart, ToolCallPart, ToolResultPart } from "@opencode/ai"
import * as OpenAI from "@opencode/ai/providers/openai"
import { MaxItemBytes, MaxItems, MaxSnapshotBytes, snapshot } from "../src/session/context-snapshot"

const model = OpenAI.configure({ apiKey: "DO_NOT_STORE_CREDENTIAL" }).chat("test")

describe("prepared context snapshot", () => {
  test("classifies every semantic role and excludes credentials and provider metadata", () => {
    const result = snapshot(
      LLM.request({
        model,
        system: [SystemPart.make("system prompt")],
        tools: [{ name: "read", description: "read file", inputSchema: { type: "object" } }],
        messages: [
          Message.user("question"),
          Message.system("operator update"),
          Message.make({
            role: "assistant",
            content: [ToolCallPart.make({ id: "call", name: "read", input: { path: "/workspace/a" } })],
            providerMetadata: { secret: { key: "DO_NOT_STORE_METADATA" } },
          }),
          Message.tool(ToolResultPart.make({ id: "call", name: "read", result: "file contents", resultType: "text" })),
        ],
        providerOptions: { key: "DO_NOT_STORE_OPTIONS" },
      }),
    )
    expect(result.items.map((item) => item.category)).toEqual([
      "system",
      "tools",
      "user",
      "inject",
      "assistant",
      "tool",
    ])
    expect(result.estimatedTokens).toBe(result.items.reduce((total, item) => total + item.estimatedTokens, 0))
    expect(result.composition.system).toBe(Math.ceil("system prompt".length / 4) + 4)
    expect(result.incomplete).toBe(false)
    expect(Array.from(result.contents.values()).join("\n")).not.toContain("DO_NOT_STORE")
  })

  test("retains media descriptors but never bytes, URLs, encrypted reasoning, or native state", () => {
    const result = snapshot(
      LLM.request({
        model,
        messages: [
          Message.make({
            role: "user",
            native: { credential: "SECRET_NATIVE" },
            content: [
              { type: "media", mediaType: "image/png", filename: "image.png", data: "SECRET_IMAGE" },
              { type: "reasoning", text: "visible reasoning", encrypted: "SECRET_ENCRYPTED" },
              { type: "compaction", provider: model.provider, encrypted: "SECRET_CHECKPOINT" },
            ],
          }),
          Message.tool({
            id: "call",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "visible tool text" },
                { type: "file", uri: "data:image/png;base64,SECRET_TOOL_IMAGE", mime: "image/png", name: "tool.png" },
              ],
            },
          }),
        ],
      }),
    )
    const bodies = Array.from(result.contents.values()).join("\n")
    expect(bodies).not.toContain("SECRET")
    expect(bodies).toContain("image.png")
    expect(bodies).toContain("visible tool text")
    expect(result.incomplete).toBe(true)
    expect(result.items.every((item) => item.omitted === "opaque-content")).toBe(true)
  })

  test("deduplicates content without deduplicating its prompt contribution", () => {
    const result = snapshot(LLM.request({ model, system: [SystemPart.make("same"), SystemPart.make("same")] }))
    expect(result.items).toHaveLength(2)
    expect(result.contents.size).toBe(1)
    expect(result.composition.system).toBe(10)
    expect(result.items[0]?.hash).toBe(result.items[1]?.hash)
  })

  test("caps stored UTF-8 bytes while retaining a non-zero estimate for omitted text", () => {
    const result = snapshot(LLM.request({ model, system: [SystemPart.make("你".repeat(MaxItemBytes / 3 + 1))] }))
    expect(result.items[0]?.omitted).toBe("size-limit")
    expect(result.items[0]?.hash).toBeUndefined()
    expect(result.estimatedTokens).toBeGreaterThan(0)
    expect(result.contents.size).toBe(0)
    expect(result.incomplete).toBe(true)
  })

  test("caps aggregate retained bytes and item count", () => {
    const large = snapshot(
      LLM.request({
        model,
        system: Array.from({ length: 20 }, (_, i) => SystemPart.make(String(i).padEnd(MaxItemBytes, "x"))),
      }),
    )
    expect(
      Array.from(large.contents.values()).reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    ).toBeLessThanOrEqual(MaxSnapshotBytes)
    expect(large.items.some((item) => item.omitted === "size-limit")).toBe(true)
    const many = snapshot(
      LLM.request({ model, system: Array.from({ length: MaxItems + 1 }, () => SystemPart.make("x")) }),
    )
    expect(many.items).toHaveLength(MaxItems)
    expect(many.incomplete).toBe(true)
  })

  test("keeps namespace definitions and qualifies nested tool names", () => {
    const result = snapshot(
      LLM.request({
        model,
        tools: [
          {
            type: "namespace",
            name: "runner",
            description: "Code Mode tools",
            tools: [{ name: "execute", description: "execute code", inputSchema: {} }],
          },
        ],
      }),
    )
    expect(result.items.map((item) => item.name)).toEqual(["runner", "runner.execute"])
  })

  test("labels only the tool origins it is given", () => {
    const result = snapshot(
      LLM.request({
        model,
        tools: [
          { name: "docs_search", description: "search docs", inputSchema: {} },
          { name: "read", description: "read file", inputSchema: {} },
        ],
      }),
      (name) => (name === "docs_search" ? "mcp:docs" : undefined),
    )
    expect(result.items.map((item) => item.source)).toEqual(["mcp:docs", undefined])
  })

  test("marks the skill catalog only when both renderer markers are present", () => {
    const catalog =
      "Skills provide specialized instructions and workflows for specific tasks.\n<available_skills>\n<skill/>\n</available_skills>"
    const result = snapshot(
      LLM.request({
        model,
        system: [SystemPart.make(catalog), SystemPart.make("<available_skills> quoted by a user file")],
        messages: [Message.system(catalog)],
      }),
    )
    expect(result.items.map((item) => [item.category, item.origin])).toEqual([
      ["system", "skills"],
      ["system", undefined],
      ["inject", "skills"],
    ])
  })

  test("keeps attachment and tool identity as metadata without copying bytes", () => {
    const result = snapshot(
      LLM.request({
        model,
        messages: [
          Message.make({
            role: "user",
            content: [{ type: "media", mediaType: "image/png", filename: "shot.png", data: "SECRET_IMAGE_BYTES" }],
          }),
          Message.assistant(ToolCallPart.make({ id: "call-1", name: "read", input: { path: "/workspace/a" } })),
          Message.tool(ToolResultPart.make({ id: "call-1", name: "read", result: "body", resultType: "text" })),
        ],
      }),
    )
    expect(result.items[0]?.media).toEqual({ mediaType: "image/png", filename: "shot.png" })
    expect(result.items[1]?.tool).toEqual({ name: "read", callID: "call-1" })
    // A text result is a success; failure is only claimed for a non-content result.
    expect(result.items[2]?.tool).toEqual({ name: "read", callID: "call-1" })
    expect(JSON.stringify(result.items)).not.toContain("SECRET_IMAGE_BYTES")
  })

  test("marks non-serializable tool input unavailable instead of throwing", () => {
    const value: Record<string, unknown> = {}
    value.self = value
    const result = snapshot(
      LLM.request({
        model,
        messages: [Message.assistant(ToolCallPart.make({ id: "call", name: "bad", input: value }))],
      }),
    )
    expect(result.incomplete).toBe(true)
    expect(result.items[0]?.omitted).toBe("unsupported-content")
    expect(result.contents.size).toBe(0)
  })
})
