import { describe, expect, it } from "bun:test"
import { ToolAttachment } from "@opencode/core/tool/attachment"
import { Session } from "@opencode/schema/session"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import fs from "fs/promises"
import path from "path"

describe("ToolAttachment.classify", () => {
  it("classifies supported media from its signature", () => {
    expect(ToolAttachment.classify("image.bin", Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      .toEqual({ type: "image", mime: "image/png" })
    expect(ToolAttachment.classify("file", Uint8Array.from([0x25, 0x50, 0x44, 0x46, 0x2d])))
      .toEqual({ type: "pdf", mime: "application/pdf" })
  })

  it("recognizes office extensions and rejects common executable signatures", () => {
    expect(ToolAttachment.classify("report.docx", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])))
      .toEqual({
        type: "office",
        mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      })
    expect(ToolAttachment.classify("a.out", Uint8Array.from([0x7f, 0x45, 0x4c, 0x46])))
      .toEqual({ type: "binary", mime: "application/octet-stream" })
    expect(ToolAttachment.classify("data.bin", Uint8Array.from([0x61, 0x00, 0x62])))
      .toEqual({ type: "binary", mime: "application/octet-stream" })
  })

  it("leaves SVG as text and maps ordinary files to text", () => {
    expect(ToolAttachment.classify("drawing.svg", new TextEncoder().encode("<svg></svg>")))
      .toEqual({ type: "svg", mime: "image/svg+xml" })
    expect(ToolAttachment.classify("config.json", new TextEncoder().encode("{}")))
      .toEqual({ type: "text", mime: "application/json" })
  })
})

describe("ToolAttachment.parseByteRange", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(ToolAttachment.parseByteRange("bytes=2-5", 10)).toEqual({ start: 2, end: 5 })
    expect(ToolAttachment.parseByteRange("bytes=7-", 10)).toEqual({ start: 7, end: 9 })
    expect(ToolAttachment.parseByteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 })
  })

  it("rejects malformed and unsatisfiable ranges", () => {
    expect(ToolAttachment.parseByteRange("bytes=12-", 10)).toBeNull()
    expect(ToolAttachment.parseByteRange("bytes=4-2", 10)).toBeNull()
    expect(ToolAttachment.parseByteRange("items=1-2", 10)).toBeNull()
    expect(ToolAttachment.parseByteRange("bytes=0-", 0)).toBeNull()
  })
})

describe("ToolAttachment local persistence", () => {
  it("stores bytes outside tool state and verifies metadata when opening", async () => {
    const sessionID = Session.ID.create()
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const stored = await Effect.runPromise(
      ToolAttachment.storeLocal({ sessionID, filename: "pixel.png", bytes }),
    )
    try {
      expect(stored.url).toBe(`/api/session/${sessionID}/attachment/${stored.metadata.id}`)
      expect(stored.metadata).toMatchObject({ filename: "pixel.png", mime: "image/png", size: bytes.byteLength })
      const opened = await Effect.runPromise(ToolAttachment.openLocal({ sessionID, id: stored.metadata.id }))
      expect(opened.bytes).toEqual(Buffer.from(bytes))
      expect(opened.metadata.sha256).toBe(stored.metadata.sha256)
      expect(await Effect.runPromise(ToolAttachment.forModelLocal({ sessionID, id: stored.metadata.id }))).toMatchObject({
        data: Buffer.from(bytes).toString("base64"),
      })
      await fs.writeFile(
        path.join(Global.Path.data, "tool-attachments", sessionID, `${stored.metadata.id}.data`),
        Buffer.from("tampered").toString("base64"),
      )
      const tampered = await Effect.runPromise(
        ToolAttachment.openLocal({ sessionID, id: stored.metadata.id }).pipe(Effect.flip),
      )
      expect(tampered).toBeInstanceOf(ToolAttachment.NotFoundError)
    } finally {
      await fs.rm(path.join(Global.Path.data, "tool-attachments", sessionID), { recursive: true, force: true })
    }
  })
})
