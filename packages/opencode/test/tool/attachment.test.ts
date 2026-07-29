import { describe, expect, test } from "bun:test"
import { ToolAttachment } from "@/tool/attachment"
import { SessionID } from "@/session/schema"
import { Effect, Exit } from "effect"

const bytes = (...values: number[]) => new Uint8Array(values)
const text = (value: string) => new TextEncoder().encode(value)

describe("ToolAttachment.classify", () => {
  test("uses image magic bytes before the extension", () => {
    expect(ToolAttachment.classify("report.txt", bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toEqual({
      type: "image",
      mime: "image/png",
    })
  })

  test("detects PDF magic bytes", () => {
    expect(ToolAttachment.classify("report.bin", text("%PDF-1.7"))).toEqual({
      type: "pdf",
      mime: "application/pdf",
    })
  })

  test("classifies Office files as displayable documents", () => {
    expect(ToolAttachment.classify("report.docx", bytes(0x50, 0x4b, 0x03, 0x04))).toEqual({
      type: "office",
      mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    })
  })

  test("keeps SVG in the text path", () => {
    expect(ToolAttachment.classify("diagram", text('<?xml version="1.0"?><svg viewBox="0 0 1 1"></svg>'))).toEqual({
      type: "svg",
      mime: "image/svg+xml",
    })
  })

  test("rejects known binary extensions", () => {
    expect(ToolAttachment.classify("archive.zip", bytes(0x50, 0x4b, 0x03, 0x04))).toEqual({
      type: "binary",
      mime: "application/zip",
    })
  })

  test("rejects binary magic bytes without an extension", () => {
    expect(ToolAttachment.classify("program", bytes(0x7f, 0x45, 0x4c, 0x46))).toEqual({
      type: "binary",
      mime: "application/x-elf",
    })
  })

  test("assigns text MIME types by extension", () => {
    expect(ToolAttachment.classify("config.json", text('{"enabled":true}'))).toEqual({
      type: "text",
      mime: "application/json",
    })
  })
})

describe("ToolAttachment.store", () => {
  test("copies exact bytes and persists only metadata", async () => {
    const source = bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0xff)
    const files = new Map<string, Uint8Array>()
    const sandbox: ToolAttachment.AttachmentSandbox = {
      files: {
        createDirectories: async () => {},
        deleteFiles: async (paths) => {
          paths.forEach((path) => files.delete(path))
        },
        readBytesStream: async function* () {
          yield source.subarray(0, 3)
          yield source.subarray(3)
        },
        writeFiles: async (entries) => {
          for (const entry of entries) {
            if (typeof entry.data === "string") {
              files.set(entry.path, text(entry.data))
              continue
            }
            if (entry.data instanceof Uint8Array) {
              files.set(entry.path, entry.data)
              continue
            }
            if (entry.data instanceof ArrayBuffer) {
              files.set(entry.path, new Uint8Array(entry.data))
              continue
            }
            if (entry.data instanceof Blob) {
              files.set(entry.path, new Uint8Array(await entry.data.arrayBuffer()))
              continue
            }
            if (!isAsyncIterable(entry.data)) throw new Error("Unsupported test file payload")
            const chunks: Uint8Array[] = []
            for await (const chunk of entry.data) chunks.push(chunk)
            files.set(entry.path, Buffer.concat(chunks))
          }
        },
      },
    }

    const result = await Effect.runPromise(
      ToolAttachment.store({
        sandbox,
        sessionID: SessionID.make("ses_test"),
        sourcePath: "/workspace/image.png",
        filename: "../image\u0000.png",
        mime: "image/png",
        audience: "model-and-display",
      }),
    )
    const stored = files.get([...files.keys()].find((key) => key.endsWith(".data")) ?? "")
    const metadata = new TextDecoder().decode(files.get([...files.keys()].find((key) => key.endsWith(".json")) ?? ""))

    expect(stored).toEqual(source)
    expect(metadata).not.toContain(source.toBase64())
    expect(JSON.parse(metadata)).toEqual(result.metadata)
    expect(result.metadata.filename).toBe("image_.png")
    expect(result.url).toBe(`/session/ses_test/attachment/${result.metadata.id}`)
  })

  test("removes copied bytes when metadata persistence fails", async () => {
    const deleted: string[] = []
    let writes = 0
    const sandbox: ToolAttachment.AttachmentSandbox = {
      files: {
        createDirectories: async () => {},
        deleteFiles: async (paths) => {
          deleted.push(...paths)
        },
        readBytesStream: async function* () {
          yield bytes(1, 2, 3)
        },
        writeFiles: async (entries) => {
          writes++
          if (writes === 2) throw new Error("metadata unavailable")
          for (const entry of entries) {
            if (!isAsyncIterable(entry.data)) continue
            for await (const _chunk of entry.data) {
              // Drain the source stream like the real SDK.
            }
          }
        },
      },
    }

    const exit = await Effect.runPromiseExit(
      ToolAttachment.store({
        sandbox,
        sessionID: SessionID.make("ses_test"),
        sourcePath: "/workspace/image.png",
        filename: "../unsafe\u0000.png",
        mime: "image/png",
        audience: "model-and-display",
      }),
    )

    expect(Exit.isFailure(exit)).toBeTrue()
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toEndWith(".data")
  })

  test("stops and removes partial data when streamed bytes exceed the limit", async () => {
    const deleted: string[] = []
    const sandbox: ToolAttachment.AttachmentSandbox = {
      files: {
        createDirectories: async () => {},
        deleteFiles: async (paths) => {
          deleted.push(...paths)
        },
        readBytesStream: async function* () {
          yield new Uint8Array(ToolAttachment.MAX_BYTES)
          yield bytes(1)
        },
        writeFiles: async (entries) => {
          for (const entry of entries) {
            if (!isAsyncIterable(entry.data)) continue
            for await (const _chunk of entry.data) {
              // Drain the source stream like the real SDK.
            }
          }
        },
      },
    }

    const exit = await Effect.runPromiseExit(
      ToolAttachment.store({
        sandbox,
        sessionID: SessionID.make("ses_test"),
        sourcePath: "/workspace/large.pdf",
        filename: "large.pdf",
        mime: "application/pdf",
        audience: "model-and-display",
      }),
    )

    expect(Exit.isFailure(exit)).toBeTrue()
    expect(deleted).toHaveLength(1)
    expect(deleted[0]).toEndWith(".data")
  })

  test("rejects a declared oversized file before reading", async () => {
    let read = false
    const sandbox: ToolAttachment.AttachmentSandbox = {
      files: {
        createDirectories: async () => {},
        deleteFiles: async () => {},
        readBytesStream: async function* () {
          read = true
          yield bytes(1)
        },
        writeFiles: async () => {},
      },
    }
    const exit = await Effect.runPromiseExit(
      ToolAttachment.store({
        sandbox,
        sessionID: SessionID.make("ses_test"),
        sourcePath: "/workspace/large.pdf",
        filename: "large.pdf",
        mime: "application/pdf",
        size: ToolAttachment.MAX_BYTES + 1,
        audience: "model-and-display",
      }),
    )

    expect(Exit.isFailure(exit)).toBeTrue()
    expect(read).toBeFalse()
  })
})

describe("ToolAttachment.parseByteRange", () => {
  test("parses bounded, open-ended, and suffix ranges", () => {
    expect(ToolAttachment.parseByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19, header: "bytes=10-19" })
    expect(ToolAttachment.parseByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99, header: "bytes=90-99" })
    expect(ToolAttachment.parseByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99, header: "bytes=90-99" })
  })

  test("clamps ranges and rejects invalid requests", () => {
    expect(ToolAttachment.parseByteRange(undefined, 100)).toBeUndefined()
    expect(ToolAttachment.parseByteRange("bytes=90-200", 100)).toEqual({ start: 90, end: 99, header: "bytes=90-99" })
    expect(ToolAttachment.parseByteRange("bytes=100-", 100)).toBeNull()
    expect(ToolAttachment.parseByteRange("bytes=20-10", 100)).toBeNull()
    expect(ToolAttachment.parseByteRange("bytes=0-1,4-5", 100)).toBeNull()
    expect(ToolAttachment.parseByteRange("bytes=-0", 100)).toBeNull()
    expect(ToolAttachment.parseByteRange("bytes=0-0", 0)).toBeNull()
  })
})

describe("ToolAttachment.isManagedUrl", () => {
  test("identifies managed attachment URLs", () => {
    expect(ToolAttachment.isManagedUrl("/session/ses_test/attachment/att_abc")).toBeTrue()
    expect(ToolAttachment.isManagedUrl("data:image/png;base64,abc")).toBeFalse()
    expect(ToolAttachment.isManagedUrl("https://example.com/img.png")).toBeFalse()
  })
})

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}
