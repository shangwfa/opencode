import { describe, expect, test } from "bun:test"
import {
  compressJson,
  compressLines,
  compressLog,
  compressOutput,
  compressSearch,
  compressConfig,
  compressDiff,
  compressTabular,
  compressHtml,
  compressCode,
  looksLikeSearch,
  looksLikeConfig,
  looksLikeLog,
} from "../../src/plugin/ccr/lib/compressors"
import { estimateTokens } from "../../src/plugin/ccr/lib/config"

const config = {
  minTokens: 1000,
  protectRecent: 2,
  previewTokens: 300,
  ttlSeconds: 0,
}

describe("compressJson", () => {
  test("losslessly folds uniform arrays, keep/drops heterogeneous ones", () => {
    // 同构数组：lossless csv-schema parity — EVERY item kept, re-encoded
    const uniform = Array.from({ length: 500 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      description: "x".repeat(80),
    }))
    const text = JSON.stringify(uniform)
    const result = compressJson(text, config)
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("json")
    const table = JSON.parse(result!.preview)
    expect(table.ccr_table).toBe(true)
    expect(table.columns).toEqual(["id", "name", "description"])
    expect(table.rows).toHaveLength(500)
    expect(table.rows[42][0]).toBe(42)
    expect(result!.itemCount).toEqual({ original: 500, compressed: 500 })
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))

    // 异构数组（键集不一致）：fallback 到 scored keep/drop
    const mixed = Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0 ? { id: i, name: `item-${i}` } : { id: i, kind: "odd" },
    )
    const result2 = compressJson(JSON.stringify(mixed), config)
    expect(result2).toBeDefined()
    const parsed = JSON.parse(result2!.preview)
    expect(parsed.ccr_truncated).toBe(true)
    expect(parsed.total_items).toBe(500)
    expect(parsed.showing).toBeLessThan(500)
    expect(parsed.items.length).toBe(parsed.showing)
    expect(result2!.itemCount).toEqual({ original: 500, compressed: parsed.showing })
    expect(estimateTokens(result2!.preview)).toBeLessThan(estimateTokens(JSON.stringify(mixed)))
  })

  test("truncates long string values inside objects", () => {
    const text = JSON.stringify({
      content: "y".repeat(20000),
      status: "ok",
    })
    const result = compressJson(text, config)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.preview)
    expect(parsed.status).toBe("ok")
    expect(parsed.content).toContain("[+")
    expect(parsed.content.length).toBeLessThan(300)
  })

  test("returns undefined for small payloads", () => {
    expect(compressJson(JSON.stringify({ a: 1 }), config)).toBeUndefined()
  })

  test("returns undefined for non-JSON text", () => {
    expect(compressJson("this is not json at all", config)).toBeUndefined()
  })

  test("returns undefined when all array items fit the budget", () => {
    const text = JSON.stringify([1, 2, 3])
    expect(compressJson(text, config)).toBeUndefined()
  })
})

describe("compressLog", () => {
  test("keeps errors and drops routine lines", () => {
    const lines = ["service booting", "loaded config"]
    for (let i = 0; i < 200; i++) {
      lines.push(`2026-09-03T10:00:${String(i % 60).padStart(2, "0")} INFO request ${i} handled`)
    }
    lines[50] = "2026-09-03T10:01:00 ERROR db connection failed"
    lines[100] = "2026-09-03T10:02:00 FATAL worker crashed: exit 1"
    lines.push("service stopped")
    const text = lines.join("\n")
    expect(looksLikeLog(text)).toBe(true)

    const result = compressLog(text)
    expect(result).toBeDefined()
    expect(result!.preview).toContain("ERROR db connection failed")
    expect(result!.preview).toContain("FATAL worker crashed")
    expect(result!.preview).toContain("routine lines elided")
    expect(result!.preview).toContain("service stopped")
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))
  })

  test("caps error lines at max_errors=10 (Headroom parity)", () => {
    const lines = ["service booting"]
    for (let i = 0; i < 300; i++) {
      lines.push(`2026-09-03T10:00:${String(i % 60).padStart(2, "0")} INFO request ${i} handled`)
    }
    for (let i = 0; i < 15; i++) {
      lines.push(`2026-09-03T10:05:${String(i).padStart(2, "0")} ERROR unique failure number ${i}`)
    }
    lines.push("service stopped")
    const text = lines.join("\n")

    const result = compressLog(text)
    expect(result).toBeDefined()
    const errorCount = (result!.preview.match(/ERROR unique failure/g) ?? []).length
    expect(errorCount).toBeLessThanOrEqual(10)
    expect(errorCount).toBeGreaterThan(0)
  })

  test("returns undefined for short logs", () => {
    expect(compressLog("a\nb\nc")).toBeUndefined()
  })
})

describe("compressLines", () => {
  test("keeps head and tail of long plain text", () => {
    const text = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n")
    const result = compressLines(text, config)
    expect(result).toBeDefined()
    expect(result!.preview).toContain("line 0")
    expect(result!.preview).toContain("line 399")
    expect(result!.preview).toContain("lines removed")
    expect(result!.preview).not.toContain("line 200\n")
  })

  test("returns undefined for short text", () => {
    expect(compressLines(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), config)).toBeUndefined()
  })
})

describe("adaptive preview (Plan B)", () => {
  // ~1300 chars (≈325 tokens): under the old fixed budget (previewTokens*4 =
  // 1200 chars) the preview kept ~45/50 items → 0.7-ratio gate rejected it.
  // The adaptive budget (chars/3 ≈ 433) shrinks the preview enough to clear.
  test("compresses mid-size json arrays the fixed budget used to reject", () => {
    // 异构（键集交替）确保走 keep/drop 而非 lossless
    const items = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0 ? { id: i, name: `item-${i}` } : { id: i, kind: "odd" },
    )
    const text = JSON.stringify(items)
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(300)
    const result = compressJson(text, config)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.preview)
    expect(parsed.ccr_truncated).toBe(true)
    expect(parsed.showing).toBeLessThan(50)
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text) * 0.5)
  })

  test("keeps error items unconditionally even when the query is unrelated", () => {
    // 15 个 budget 全给「普通」项也不该丢 error——must_keep 硬约束
    const items = Array.from({ length: 200 }, (_, i) =>
      i === 150
        ? { id: i, level: "FATAL", msg: "worker crashed" }
        : i % 2 === 0
          ? { id: i, level: "ok", msg: `fine entry ${i}` }
          : { id: i, status: "ok", note: `entry ${i}` },
    )
    const text = JSON.stringify(items)
    const result = compressJson(text, config, "summarize the payment records")
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.preview)
    const kept = parsed.items as Array<{ id: number }>
    expect(kept.some((x) => x.id === 150)).toBe(true)
  })

  test("anchors first and last items (first_fraction/last_fraction parity)", () => {
    const items = Array.from({ length: 300 }, (_, i) =>
      i % 2 === 0 ? { id: i, note: `row ${i} ${"z".repeat(20)}` } : { id: i, kind: `group-${i % 5}` },
    )
    const text = JSON.stringify(items)
    const result = compressJson(text, config)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.preview)
    const kept = parsed.items as Array<{ id: number }>
    const ids = kept.map((x) => x.id)
    // k_total=15 → first=max(1, round(4.5))=5, last=max(1, round(2.25))=2
    for (let i = 0; i < 5; i++) expect(ids).toContain(i)
    expect(ids).toContain(299)
    expect(ids).toContain(298)
  })

  test("deduplicates identical items with a count", () => {
    const items: Array<Record<string, unknown>> = Array.from({ length: 500 }, () => ({
      status: "ok",
      message: "success",
    }))
    items[0] = { status: "ok", message: "success", seq: 0 }
    const text = JSON.stringify(items)
    const result = compressJson(text, config)
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.preview)
    expect(parsed.deduplicated).toBe(true)
    expect(parsed.unique_items).toBe(2)
    expect(parsed.total_items).toBe(500)
    expect(parsed.showing).toBeLessThanOrEqual(2)
  })

  test("lossless table survives the mid-size path (full-budget fold)", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: i, name: `item-${i}` }))
    const text = JSON.stringify(items)
    const result = compressJson(text, config)
    expect(result).toBeDefined()
    const table = JSON.parse(result!.preview)
    expect(table.ccr_table).toBe(true)
    expect(table.rows).toHaveLength(50)
  })

  // ~30 lines × 40 chars = 1200 chars (≈300 tokens): old maxLines=20 kept
  // ~800 chars (0.71 ratio, rejected); adaptive maxLines=6 compresses hard.
  test("compresses mid-size plain text the fixed budget used to reject", () => {
    const text = Array.from({ length: 30 }, (_, i) => `row ${i} ${"x".repeat(34)}`).join("\n")
    const result = compressLines(text, config)
    expect(result).toBeDefined()
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text) * 0.5)
  })

  // Large outputs keep the full previewTokens budget — the adaptive formula
  // only shrinks budgets below previewTokens*3 tokens.
  test("keeps the full budget for large outputs", () => {
    const items = Array.from({ length: 500 }, (_, i) =>
      i % 2 === 0
        ? { id: i, name: `item-${i}`, description: "x".repeat(80) }
        : { id: i, kind: `variant-${i % 7}` },
    )
    const text = JSON.stringify(items)
    const result = compressJson(text, config)
    expect(result).toBeDefined()
    // preview stays well below the full 1200-char budget but far above the
    // proportional (chars/3) floor — this input is ~45KB so chars/3 would be
    // ~15KB, while the emitted preview is capped at the full budget.
    expect(result!.preview.length).toBeLessThan(1400)
    expect(result!.preview.length).toBeGreaterThan(600)
  })
})

describe("compressCode docstring (FIRST_LINE parity)", () => {
  test("keeps the docstring opening line, folds the rest", () => {
    const code = [
      "import os",
      "from queue import deque",
      "",
      "class Worker:",
      '    """Worker processes queued jobs.',
      "",
      "    Long multiline description with a lot of detail",
      "    about retry semantics and backoff behavior.",
      '    """',
      "",
      "    def process(self, items):",
      '        results = []',
      "        for item in items:",
      "            results.append(item.strip())",
      "            results = normalize(results)",
      "            self.check(results)",
      "            self.metrics.tick()",
      "        return results",
      "",
      "    def drain(self):",
      "        while self.queue:",
      "            job = self.queue.popleft()",
      "            self.process([job])",
      "            self.metrics.tick()",
      "        return self.metrics.snapshot()",
    ].join("\n")
    const result = compressCode(code, config)
    expect(result).toBeDefined()
    expect(result!.preview).toContain("Worker processes queued jobs.")
    expect(result!.preview).not.toContain("retry semantics")
    expect(result!.preview).toContain("def process(self, items):")
    expect(result!.preview).toContain("lines elided")
  })

  test("keeps a single-line docstring fully", () => {
    const body = [
      "import os",
      "import sys",
      "",
      "def run(x):",
      '    """Run the pipeline."""',
      "    state = initialize(x)",
      "    for step in state.steps:",
      "        state = advance(state, step)",
      "        log(state)",
      "    return state",
    ].join("\n")
    const fillers = Array.from({ length: 12 }, (_, i) =>
      [`def helper_${i}(v):`, `    prepared = prepare_${i}(v)`, `    checked = check_${i}(prepared)`, `    return transform_${i}(checked)`].join("\n"),
    ).join("\n")
    const code = body + "\n" + fillers
    const result = compressCode(code, config)
    expect(result).toBeDefined()
    expect(result!.preview).toContain('"""Run the pipeline."""')
  })
})

describe("compressOutput", () => {
  test("routes json payloads to the json strategy", () => {
    const text = JSON.stringify(
      Array.from({ length: 300 }, (_, i) => ({ id: i, data: "d".repeat(100) })),
    )
    const result = compressOutput(text, config)
    expect(result?.strategy).toBe("json")
  })

  test("routes log-shaped payloads to the log strategy", () => {
    const lines: string[] = []
    for (let i = 0; i < 300; i++) {
      lines.push(`2026-09-03T10:00:00Z INFO event ${i}`)
    }
    for (let i = 0; i < 30; i++) {
      lines[i * 10] = "2026-09-03T10:00:00Z ERROR thing " + i
    }
    const result = compressOutput(lines.join("\n"), config)
    expect(result?.strategy).toBe("log")
  })

  test("falls back to line truncation", () => {
    const text = Array.from({ length: 500 }, (_, i) => `plain line ${i} with some filler text`).join("\n")
    const result = compressOutput(text, config)
    expect(result?.strategy).toBe("lines")
  })
})

describe("compressSearch", () => {
  function grepOutput(files: number, perFile: number): string {
    const lines: string[] = []
    for (let f = 0; f < files; f++) {
      for (let i = 0; i < perFile; i++) {
        const lvl = i % 10 === 3 ? "ERROR: something bad" : "matched token here"
        lines.push(`src/module-${f}/file-${f}.ts:${i * 7 + 1}: ${lvl} at position ${i}`)
      }
    }
    return lines.join("\n")
  }

  test("detects file:line:content format", () => {
    expect(looksLikeSearch(grepOutput(3, 20))).toBe(true)
    expect(looksLikeSearch("plain text\ntwo\nthree")).toBe(false)
  })

  test("keeps first/last/error rows per file and caps totals", () => {
    const text = grepOutput(4, 20)
    const result = compressSearch(text, config)
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("search")
    expect(result!.itemCount).toEqual({ original: 80, compressed: 20 })
    expect(result!.preview).toContain("src/module-0/file-0.ts")
    expect(result!.preview).toContain("ERROR: something bad")
    expect(result!.preview).toContain("matches across 4 files omitted")
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))
  })

  test("anchors line numbers after drive-letter colons (windows paths)", () => {
    const text = Array.from({ length: 20 }, (_, i) => `C:\\repo\\src\\a.ts:${i + 1}: hit ${i}`).join("\n")
    const result = compressSearch(text, config)
    expect(result).toBeDefined()
    expect(result!.preview).toContain("C:\\repo\\src\\a.ts")
  })

  test("returns undefined for short or non-search output", () => {
    expect(compressSearch("src/a.ts:1: hit\nsrc/b.ts:2: hit", config)).toBeUndefined()
    expect(compressSearch(grepOutput(1, 8), config)).toBeUndefined()
  })
})

describe("compressConfig", () => {
  function yamlOutput(comments: number, entries: number): string {
    const lines: string[] = ["# header comment"]
    for (let i = 0; i < comments; i++) lines.push(`# explanation note ${i} with some detail`)
    for (let i = 0; i < entries; i++) {
      lines.push(`key_${i}: value-${i}`)
      lines.push("")
    }
    return lines.join("\n")
  }

  test("detects yaml/toml/ini with heavy comments", () => {
    expect(looksLikeConfig(yamlOutput(60, 20))).toBe(true)
    expect(looksLikeConfig("just some plain prose without any structure here\n".repeat(12))).toBe(false)
  })

  test("elides comment/blank lines and keeps structure", () => {
    const text = yamlOutput(80, 30)
    const result = compressConfig(text)
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("config")
    expect(result!.preview).toContain("key_0: value-0")
    expect(result!.preview).toContain("key_29: value-29")
    expect(result!.preview).not.toContain("explanation note")
    expect(result!.preview).toContain("comment/blank lines elided")
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))
  })

  test("skips yaml block scalars (comment-like lines may be data)", () => {
    const body = yamlOutput(60, 20)
    const withBlock = body + "\nscript: |\n  # not a comment\n  run --force"
    expect(compressConfig(withBlock)).toBeUndefined()
  })

  test("skips toml multiline strings", () => {
    const body = yamlOutput(60, 20) + '\n-doc: """\n# data\n"""'
    expect(compressConfig(body)).toBeUndefined()
  })

  test("returns undefined when too few comments to be worth it", () => {
    expect(compressConfig(yamlOutput(2, 30))).toBeUndefined()
  })
})

describe("compressOutput routing", () => {
  test("routes search results to the search strategy", () => {
    const lines: string[] = []
    for (let f = 0; f < 3; f++)
      for (let i = 0; i < 20; i++) lines.push(`src/m${f}.ts:${i + 1}: match ${i}`)
    expect(compressOutput(lines.join("\n"), config)?.strategy).toBe("search")
  })

  test("routes commented config to the config strategy", () => {
    const lines: string[] = []
    for (let i = 0; i < 50; i++) lines.push(`# note ${i}`)
    for (let i = 0; i < 25; i++) lines.push(`key_${i}: v${i}`)
    expect(compressOutput(lines.join("\n"), config)?.strategy).toBe("config")
  })
})

describe("compressDiff", () => {
  function diffOutput(hunks: number): string {
    const lines = ["diff --git a/app.ts b/app.ts", "--- a/app.ts", "+++ b/app.ts"]
    for (let h = 0; h < hunks; h++) {
      lines.push(`@@ -${h * 20 + 1},10 +${h * 20 + 1},12 @@ section ${h}`)
      for (let c = 0; c < 8; c++) lines.push(` context line ${h}-${c}`)
      lines.push(`+added line in hunk ${h}`)
      lines.push(`-removed line in hunk ${h}`)
    }
    return lines.join("\n")
  }

  test("keeps hunk headers and change lines, elides context", () => {
    const text = diffOutput(6)
    const result = compressDiff(text)
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("diff")
    expect(result!.preview).toContain("diff --git a/app.ts b/app.ts")
    expect(result!.preview).toContain("+added line in hunk 5")
    expect(result!.preview).toContain("ctx elided")
    expect(result!.preview).not.toContain("context line 5-7")
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))
  })

  test("returns undefined for short or non-diff text", () => {
    expect(compressDiff("diff --git a/x b/x\n@@ -1,2 +1,2 @@\n+a\n-b")).toBeUndefined()
    expect(compressDiff(Array.from({ length: 40 }, (_, i) => `random line ${i}`).join("\n"))).toBeUndefined()
  })
})

describe("compressTabular", () => {
  test("collapses csv rows keeping header and samples", () => {
    const rows = ["id,name,status,email"]
    for (let i = 0; i < 60; i++) rows.push(`${i},user-${i},active,u${i}@x.com`)
    const text = rows.join("\n")
    const result = compressTabular(text)
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("tabular")
    expect(result!.preview).toContain("id,name,status,email")
    expect(result!.preview).toContain("data rows elided (columns: id, name, status, email)")
    expect(result!.preview).not.toContain("user-40")
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))
  })

  test("handles pipe tables", () => {
    const rows = ["| a | b |", "|---|---|"]
    for (let i = 0; i < 30; i++) rows.push(`| v${i} | w${i} |`)
    const result = compressTabular(rows.join("\n"))
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("tabular")
  })

  test("returns undefined for ragged rows", () => {
    const rows = ["a,b,c"]
    for (let i = 0; i < 20; i++) rows.push(`x${i},y${i},z${i},extra${i}`)
    expect(compressTabular(rows.join("\n"))).toBeUndefined()
  })
})

describe("compressHtml", () => {
  test("strips script/style/tags to text", () => {
    const parts = ["<html><head><title>T</title><script>var x=1;</script></head><body>"]
    for (let i = 0; i < 40; i++) parts.push(`<div class="row-${i}">Paragraph ${i} with content</div><span> </span>`)
    parts.push("</body></html>")
    const text = parts.join("\n")
    const result = compressHtml(text, config)
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("html")
    expect(result!.preview).toContain("Paragraph 0 with content")
    expect(result!.preview).not.toContain("var x=1")
    expect(result!.preview).not.toContain("<div")
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))
  })

  test("returns undefined for non-html", () => {
    expect(compressHtml(Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n"), config)).toBeUndefined()
  })
})

describe("compressCode", () => {
  function codeFile(functions: number): string {
    const lines = ['import { foo } from "./foo"', 'import path from "path"']
    for (let i = 0; i < functions; i++) {
      lines.push(`export function handler${i}(input: string): boolean {`)
      for (let b = 0; b < 15; b++) lines.push(`  const step${b} = compute(${b}, input)`)
      lines.push("  return true")
      lines.push("}")
    }
    return lines.join("\n")
  }

  test("keeps imports and signatures, collapses bodies", () => {
    const text = codeFile(8)
    const result = compressCode(text, config)
    expect(result).toBeDefined()
    expect(result!.strategy).toBe("code")
    expect(result!.preview).toContain('import { foo } from "./foo"')
    expect(result!.preview).toContain("export function handler0(input: string): boolean {")
    expect(result!.preview).toContain("export function handler7(input: string): boolean {")
    expect(result!.preview).toContain("lines elided")
    expect(result!.preview).not.toContain("compute(3, input)")
    expect(estimateTokens(result!.preview)).toBeLessThan(estimateTokens(text))
  })

  test("returns undefined for short or non-code text", () => {
    expect(compressCode("const a = 1\nconst b = 2", config)).toBeUndefined()
    expect(compressCode(Array.from({ length: 40 }, (_, i) => `plain word ${i}`).join("\n"), config)).toBeUndefined()
  })
})

describe("relevance scoring (first-compression query)", () => {
  test("json array keeps query-relevant items", () => {
    const items = Array.from({ length: 100 }, (_, i) =>
      i === 42
        ? { id: i, kind: "database-error", detail: "connection refused" }
        : { id: i, status: "ok", note: `entry ${i} fine` },
    )
    const text = JSON.stringify(items)
    const result = compressJson(text, config, "find the database-error entry")
    expect(result).toBeDefined()
    const parsed = JSON.parse(result!.preview)
    const kept = parsed.items as Array<{ kind: string }>
    expect(kept.some((x) => x.kind === "database-error")).toBe(true)
  })

  test("search keeps query-matching rows within cap", () => {
    const lines: string[] = []
    for (let i = 0; i < 40; i++) lines.push(`src/a.ts:${i + 1}: unrelated noise ${i}`)
    lines[20] = "src/a.ts:21: retry with backoff for timeout"
    const result = compressSearch(lines.join("\n"), config, "retry backoff timeout")
    expect(result).toBeDefined()
    expect(result!.preview).toContain("retry with backoff")
  })
})
