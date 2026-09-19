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

  test("detects binary by non-printable ratio without known magic bytes", () => {
    // 70% non-printable control chars (0x01), no known magic, no null byte
    const sample = new Uint8Array(100)
    sample.fill(0x01, 0, 70)
    sample.fill(0x41, 70) // 'A' for the rest
    expect(ToolAttachment.classify("mystery.dat", sample)).toEqual({
      type: "binary",
      mime: "application/octet-stream",
    })
  })

  test("does not misclassify text with some control chars as binary", () => {
    // Only 10% control chars — should be treated as text
    const sample = new Uint8Array(100)
    sample.fill(0x41, 0, 90) // 'A'
    sample.fill(0x01, 90, 100) // 10% control chars
    expect(ToolAttachment.classify("logfile", sample).type).toBe("text")
  })

  test("assigns text MIME types by extension", () => {
    expect(ToolAttachment.classify("config.json", text('{"enabled":true}'))).toEqual({
      type: "text",
      mime: "application/json",
    })
  })

  test("assigns extended text MIME types by extension", () => {
    expect(ToolAttachment.classify("component.jsx", text("export default <div/>"))).toEqual({
      type: "text",
      mime: "text/jsx",
    })
    expect(ToolAttachment.classify("config.yaml", text("a: 1"))).toEqual({
      type: "text",
      mime: "application/yaml",
    })
    expect(ToolAttachment.classify("config.xml", text("<root/>"))).toEqual({
      type: "text",
      mime: "application/xml",
    })
    expect(ToolAttachment.classify("script.py", text("print(1)"))).toEqual({
      type: "text",
      mime: "text/x-python",
    })
    expect(ToolAttachment.classify("run.sh", text("#!/bin/sh"))).toEqual({
      type: "text",
      mime: "application/x-sh",
    })
    expect(ToolAttachment.classify("main.go", text("package main"))).toEqual({
      type: "text",
      mime: "text/x-go",
    })
  })

  test("sniffs SVG inside a large XML preamble beyond 4096 bytes", () => {
    const doctype = "<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd\">"
    const padding = " ".repeat(8192)
    const content = `<?xml version="1.0"?>${doctype}${padding}<svg viewBox="0 0 1 1"></svg>`
    expect(ToolAttachment.classify("diagram", text(content))).toEqual({
      type: "svg",
      mime: "image/svg+xml",
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

  test("sanitizes quotes and backslashes out of filenames", async () => {
    const files = new Map<string, Uint8Array>()
    const sandbox: ToolAttachment.AttachmentSandbox = {
      files: {
        createDirectories: async () => {},
        deleteFiles: async (paths) => {
          paths.forEach((path) => files.delete(path))
        },
        readBytesStream: async function* () {
          yield bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0xff)
        },
        writeFiles: async (entries) => {
          for (const entry of entries) {
            if (typeof entry.data === "string") {
              files.set(entry.path, text(entry.data))
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
        sourcePath: "/workspace/screenshot.png",
        filename: 'report"final"\\v2.png',
        mime: "image/png",
        audience: "model-and-display",
      }),
    )

    expect(result.metadata.filename).toBe("report_final__v2.png")
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

describe("ToolAttachment.classify — BMP and heuristic binary", () => {
  test("classifies BMP by magic bytes", () => {
    expect(ToolAttachment.classify("image.bmp", bytes(0x42, 0x4d, 0x00, 0x00))).toEqual({
      type: "image",
      mime: "image/bmp",
    })
  })

  test("detects binary by null byte in sample without known magic", () => {
    const sample = new Uint8Array([0x41, 0x42, 0x00, 0x43, 0x44])
    expect(ToolAttachment.classify("mystery.dat", sample)).toEqual({
      type: "binary",
      mime: "application/octet-stream",
    })
  })

  test("detects binary by non-printable ratio > 30%", () => {
    const sample = new Uint8Array(100)
    sample.fill(0x01, 0, 70) // 70% control chars
    sample.fill(0x41, 70) // 30% printable
    expect(ToolAttachment.classify("compiled.dat", sample)).toEqual({
      type: "binary",
      mime: "application/octet-stream",
    })
  })

  test("does not misclassify text with < 30% control chars", () => {
    const sample = new Uint8Array(100)
    sample.fill(0x41, 0, 90) // 90% printable
    sample.fill(0x01, 90, 100) // 10% control chars
    expect(ToolAttachment.classify("logfile", sample).type).toBe("text")
  })

  test("empty file is not binary (falls to text)", () => {
    expect(ToolAttachment.classify("empty.txt", new Uint8Array()).type).toBe("text")
  })
})

describe("ToolAttachment.store — filename sanitization", () => {
  test("strips quotes and backslashes from filename", async () => {
    const source = bytes(0x89, 0x50, 0x4e, 0x47, 0x00, 0xff)
    const files = new Map<string, Uint8Array>()
    const sandbox: ToolAttachment.AttachmentSandbox = {
      files: {
        createDirectories: async () => {},
        deleteFiles: async (paths) => paths.forEach((p) => files.delete(p)),
        readBytesStream: async function* () { yield source },
        writeFiles: async (entries) => {
          for (const entry of entries) {
            if (typeof entry.data === "string") { files.set(entry.path, text(entry.data)); continue }
            if (!isAsyncIterable(entry.data)) throw new Error("unsupported")
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
        sourcePath: "/workspace/report.png",
        filename: 'test"final"\\v2.png',
        mime: "image/png",
        audience: "model-and-display",
      }),
    )
    expect(result.metadata.filename).toBe("test_final__v2.png")
  })

  test("null bytes in filename are sanitized", async () => {
    const source = bytes(1, 2, 3)
    const files = new Map<string, Uint8Array>()
    const sandbox: ToolAttachment.AttachmentSandbox = {
      files: {
        createDirectories: async () => {},
        deleteFiles: async () => {},
        readBytesStream: async function* () { yield source },
        writeFiles: async (entries) => {
          for (const entry of entries) {
            if (typeof entry.data === "string") { files.set(entry.path, text(entry.data)); continue }
            if (!isAsyncIterable(entry.data)) throw new Error("unsupported")
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
        sourcePath: "/workspace/x.png",
        filename: "file\x00name.png",
        mime: "image/png",
        audience: "model-and-display",
      }),
    )
    expect(result.metadata.filename).toBe("file_name.png")
  })
})

function isAsyncIterable(value: unknown): value is AsyncIterable<Uint8Array> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value
}
