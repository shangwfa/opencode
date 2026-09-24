import { describe, expect, test } from "bun:test"
import { compressOutput, contentHash, estimateTokens } from "../src/plugin/ccr.js"
import { historyImageCacheSize, resizeHistoryImage } from "../src/plugin/ccr-image.js"
import photonWasm from "#photon-wasm"
import path from "node:path"
import { fileURLToPath } from "node:url"

describe("CCR deterministic compression primitives", () => {
  test("uses stable 96-bit content hashes", () => {
    expect(contentHash("same bytes")).toBe(contentHash("same bytes"))
    expect(contentHash("same bytes")).not.toBe(contentHash("different bytes"))
    expect(contentHash("same bytes")).toMatch(/^[a-f0-9]{24}$/)
  })

  test("estimates CJK conservatively while retaining ASCII approximation", () => {
    expect(estimateTokens("中文测试")).toBe(4)
    expect(estimateTokens("かな한글")).toBe(4)
    expect(estimateTokens("abcdefgh")).toBe(2)
  })

  test("compresses large JSON arrays into a stable retrieve marker", () => {
    const source = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index, value: `item-${index}`, ...(index % 2 ? { kind: "odd" } : {}) })))
    const first = compressOutput(source, "item 73")
    const second = compressOutput(source, "irrelevant query")
    expect(first).toBeDefined()
    expect(first?.id).toBe(contentHash(source))
    expect(first?.replacement).toContain(`[ccr:${first?.id}]`)
    expect(first?.replacement).toContain("Retrieve original: hash=")
    expect(first?.id).toBe(second?.id)
    expect(first?.preview).toContain('"id":73')
    expect(first?.preview).toContain('"total_items":100')
  })

  test("passes through output when compression cannot meet the savings threshold", () => {
    expect(compressOutput("short", "short")).toBeUndefined()
  })

  test("uses a lossless compact table for uniform scalar object arrays", () => {
    const source = JSON.stringify(Array.from({ length: 100 }, (_, index) => ({ id: index, name: `item-${index}` })))
    const result = compressOutput(source, "")
    expect(result?.strategy).toBe("json")
    expect(result?.preview).toContain('"ccr_table"')
    const parsed = JSON.parse(result!.preview) as { ccr_table: boolean; rows: unknown[][]; total_items: number }
    expect(parsed.ccr_table).toBe(true)
    expect(parsed.rows).toHaveLength(100)
    expect(parsed.total_items).toBe(100)
  })

  test("deduplicates repeated JSON array entries and keeps error records", () => {
    const source = JSON.stringify([...Array.from({ length: 40 }, () => ({ status: "ok", value: "same repeated payload" })), { status: "error", message: "critical failure" }])
    const result = compressOutput(source, "")
    expect(result?.preview).toContain('"unique_items":2')
    expect(result?.preview).toContain("critical failure")
  })

  test("compresses nested JSON objects and long strings", () => {
    const source = JSON.stringify({ metadata: { description: "x".repeat(4000) }, records: Array.from({ length: 40 }, (_, index) => ({ id: index })) })
    const result = compressOutput(source, "")
    expect(result?.strategy).toBe("json")
    expect(result?.preview).toContain("ccr_truncated")
    expect(result?.preview).toContain("chars]")
  })

  test("keeps diff headers and additions while folding context", () => {
    const source = ["diff --git a/file.ts b/file.ts", "index 123..456", "--- a/file.ts", "+++ b/file.ts", "@@ -1,40 +1,40 @@", ...Array.from({ length: 30 }, (_, i) => ` context ${i}`), "-removed line", "+added line", ...Array.from({ length: 30 }, (_, i) => ` trailing ${i}`)].join("\n")
    const result = compressOutput(source, "review diff")
    expect(result?.strategy).toBe("diff")
    expect(result?.preview).toContain("+added line")
    expect(result?.preview).toContain("@@ -1,40 +1,40 @@")
    expect(result?.preview.length).toBeLessThan(source.length)
  })

  test("uses V1 compressor precedence when tabular output also resembles logs", () => {
    const source = ["type,message", ...Array.from({ length: 40 }, (_, index) => `error,request ${index} failed`)].join("\n")
    const result = compressOutput(source, "")
    expect(result?.strategy).toBe("tabular")
    expect(result?.replacement).toContain("items compressed to")
  })

  test("keeps log stack frames and summary lines", () => {
    const source = [
      "2026-01-01T00:00:00Z startup",
      "service initialized",
      "Traceback (most recent call last):",
      "  File \"app.py\", line 12, in run",
      "    run_task()",
      "  File \"task.py\", line 8, in run_task",
      "ERROR operation failed",
      ...Array.from({ length: 35 }, (_, index) => index % 4 === 0 ? `2026-01-01T00:00:${String(index).padStart(2, "0")}Z INFO routine event ${index}` : `INFO routine event ${index}`),
      "42 tests passed",
    ].join("\n")
    const result = compressOutput(source, "failure")
    expect(result?.strategy).toBe("log")
    expect(result?.preview).toContain("Traceback (most recent call last):")
    expect(result?.preview).toContain("task.py")
    expect(result?.preview).toContain("42 tests passed")
  })

  test("does not misroute prose with a lone ERROR word, keeps tail ERROR/WARN (T-CCR.19)", () => {
    const prose = Array.from({ length: 200 }, (_, i) => `paragraph ${i} discusses an error margin in the report`).join("\n")
    expect(compressOutput(prose, "")?.strategy).not.toBe("log")
    const log = [
      ...Array.from({ length: 60 }, (_, i) => `INFO routine event ${i}`),
      "ERROR newest failure marker",
      "WARN disk usage high",
    ].join("\n")
    const preview = compressOutput(log, "")?.preview ?? ""
    expect(preview).toContain("ERROR newest failure marker")
    expect(preview).toContain("WARN disk usage high")
  })

  test("treats hunk deletion lines starting with -- as content, not file headers (T-CCR.20)", () => {
    const source = [
      "diff --git a/file.ts b/file.ts",
      "index 123..456 100644",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,40 +1,40 @@",
      ...Array.from({ length: 30 }, (_, i) => ` context ${i}`),
      "--- text removed from the file body",
      ...Array.from({ length: 20 }, (_, i) => ` more context ${i}`),
      "+added replacement line",
      ...Array.from({ length: 30 }, (_, i) => ` trailing ${i}`),
    ].join("\n")
    const result = compressOutput(source, "review")
    expect(result?.strategy).toBe("diff")
    expect(result?.preview).toContain("--- text removed from the file body")
    expect(result?.preview).toContain("+added replacement line")
  })

  test("preserves recent log errors and classifies structured text families", () => {
    const log = [...Array.from({ length: 8 }, (_, i) => `ERROR request ${i} failed`), ...Array.from({ length: 25 }, (_, i) => `INFO routine event ${i}`), "ERROR newest failure marker"].join("\n")
    expect(compressOutput(log, "failure")?.strategy).toBe("log")
    expect(compressOutput(log, "failure")?.preview).toContain("ERROR newest failure marker")
    const html = ["<html>", "<head>", `<title>${"hidden ".repeat(50)}</title>`, "</head>", "<body>", ...Array.from({ length: 10 }, (_, i) => `<p>visible text ${i}</p>`), `<script>${"secret()".repeat(500)}</script>`, "</body>", "</html>"].join("\n")
    expect(compressOutput(html, "")?.strategy).toBe("html")
    expect(compressOutput(html, "")?.preview).not.toContain("secret")
  })

  test("summarizes tabular, search, config, and code output", () => {
    const table = ["name,value", ...Array.from({ length: 50 }, (_, i) => `row-${i},${i}`)].join("\n")
    expect(compressOutput(table, "")?.strategy).toBe("tabular")
    const search = Array.from({ length: 80 }, (_, i) => `src/file${i}.ts:${i + 1}: ${i === 61 ? "needle" : "routine result"}`).join("\n")
    expect(compressOutput(search, "needle")?.strategy).toBe("search")
    const config = Array.from({ length: 20 }, (_, i) => `# comment ${i}\nkey${i}: value${i}`).join("\n")
    expect(compressOutput(config, "")?.strategy).toBe("config")
    const code = [...Array.from({ length: 5 }, (_, i) => `import module_${i}`), "def calculate(value):", '    """Compute an answer."""', ...Array.from({ length: 40 }, (_, i) => `    result = value + ${i}`), "    return result"].join("\n")
    const result = compressOutput(code, "")
    expect(result?.strategy).toBe("code")
    expect(result?.preview).toContain('"""Compute an answer."""')
    expect(result?.preview).not.toContain("value + 39")
  })

  test("rejects unsupported and oversized image inputs before decoding", async () => {
    expect(await resizeHistoryImage("image/svg+xml", "AAAA")).toBeUndefined()
    expect(await resizeHistoryImage("image/png", "A".repeat(16 * 1024 * 1024 + 1))).toBeUndefined()
    const header = Buffer.alloc(24)
    header.write("IHDR", 12, "ascii")
    header.writeUInt32BE(100_000, 16)
    header.writeUInt32BE(100_000, 20)
    expect(await resizeHistoryImage("image/png", header)).toBeUndefined()
  })

  test("resizes historical image data to an area budget and caches the result", async () => {
    ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
      path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
    const photon = await import("@silvia-odwyer/photon-node")
    const rgba = new Uint8Array(1024 * 1024 * 4)
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255
    const image = new photon.PhotonImage(rgba, 1024, 1024)
    const original = Buffer.from(image.get_bytes())
    image.free()
    const resized = await resizeHistoryImage("image/png", original.toString("base64"))
    expect(typeof resized).toBe("string")
    const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(resized as string, "base64"))
    try {
      expect(decoded.get_width() * decoded.get_height()).toBeLessThanOrEqual(512 * 512)
      expect(decoded.get_width()).toBe(512)
    } finally {
      decoded.free()
    }
    expect(historyImageCacheSize()).toBeGreaterThan(0)
  })
})
