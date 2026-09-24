import { describe, expect, it, test } from "bun:test"
import { Message, ToolResultPart } from "@opencode/ai"
import { boundImages, materializeManagedAttachments, unsupportedParts } from "@opencode/core/session/model-request"
import { Effect } from "effect"

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", mediaType: "image/png", data: "aGVsbG8=", filename: "logo.png" },
          { type: "media", mediaType: "application/pdf", data: "JVBERg==", filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })
})

describe("SessionModelRequest.materializeManagedAttachments", () => {
  it("omits managed media when no sandbox provider is available", async () => {
    const messages = [
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              {
                type: "file",
                uri: "/api/session/ses_test/attachment/att_123",
                mime: "image/png",
                name: "logo.png",
              },
              {
                type: "file",
                uri: "/api/session/ses_test/attachment/att_456",
                mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                name: "report.docx",
              },
            ],
          },
        }),
      ),
    ]

    const result = await Effect.runPromise(materializeManagedAttachments(messages))
    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          { type: "text", text: "[Attachment omitted: logo.png]" },
        ],
      },
    })
    expect(JSON.stringify(result)).not.toContain("/api/session/")
    expect(JSON.stringify(result)).not.toContain("att_123")
  })
})

describe("SessionModelRequest.boundImages", () => {
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", mediaType: "image/png", data: "aGVsbG8=" })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const messages = [
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "first.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "second.png" }),
      Message.user({ type: "media", mediaType: "image/png", data: image, filename: "third.png" }),
    ]
    const result = boundImages(messages)

    expect(result[0]?.content[0]).toMatchObject({ type: "text" })
    expect(result[1]?.content[0]).toMatchObject({ type: "text" })
    expect(result[2]?.content[0]).toMatchObject({ type: "media", filename: "third.png" })
  })

  test("replaces images nested in tool results", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
  })
})
