import { describe, expect, test } from "bun:test"
import { Mime } from "@opencode/core/mime"

const bytes = (...values: number[]) => Uint8Array.from(values)

describe("Mime.detect", () => {
  test("detects known binary signatures by magic bytes", () => {
    expect(Mime.detect(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png")
    expect(Mime.detect(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg")
    expect(Mime.detect(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe("image/gif")
    expect(Mime.detect(bytes(0x42, 0x4d, 0x00, 0x00))).toBe("image/bmp")
    expect(Mime.detect(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe("application/pdf")
    expect(Mime.detect(bytes(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe("image/webp")
    expect(Mime.detect(bytes(0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66))).toBe("image/avif")
  })

  test("falls back to text/plain for utf-8 content", () => {
    expect(Mime.detect(bytes())).toBe("text/plain")
    expect(Mime.detect(new TextEncoder().encode('{"a":1}'))).toBe("text/plain")
    expect(Mime.detect(new TextEncoder().encode("hello\nworld\n"))).toBe("text/plain")
  })

  test("falls back to application/octet-stream for binary content", () => {
    expect(Mime.detect(bytes(0, 1, 2, 3))).toBe("application/octet-stream")
    expect(Mime.detect(bytes(0xff, 0xfe, 0xfd))).toBe("application/octet-stream")
  })
})
