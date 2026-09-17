import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import path from "path"

// The grep tool caps results inside the sandbox with
// `rg --json <pattern> | rg -m <limit+1> '"type":"match"'`. This test runs the
// same pipeline against a fixture tree with the local rg binary to pin the
// global-truncation behavior (stdin rg applies -m globally, closes the pipe,
// and the outer rg stops scanning early).
const hasRg = spawnSync("sh", ["-c", "command -v rg"], { encoding: "utf8" }).status === 0

describe("grep sandbox-side truncation pipeline", () => {
  const fixtureDir = path.resolve(import.meta.dir, "fixtures", "grep-truncate")
  const pattern = "needle"

  function runPipeline(maxCount: number) {
    const cmd = `rg --json '${pattern}' '${fixtureDir}' 2>/dev/null | rg -m ${maxCount} '"type":"match"'`
    const result = spawnSync("sh", ["-c", cmd], { encoding: "utf8" })
    const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean)
    const parsed = lines.map((line) => JSON.parse(line) as { type: string })
    return { status: result.status, parsed }
  }

  test.skipIf(!hasRg)("stops exactly at the global match cap", () => {
    // 101 = tool limit (100) + 1 to detect truncation
    const { parsed } = runPipeline(101)
    expect(parsed.length).toBe(101)
    expect(parsed.every((item) => item.type === "match")).toBe(true)
  })

  test.skipIf(!hasRg)("small caps yield exactly that many matches", () => {
    const { parsed } = runPipeline(5)
    expect(parsed.length).toBe(5)
    expect(parsed.every((item) => item.type === "match")).toBe(true)
  })

  test.skipIf(!hasRg)("non-match JSON lines (begin/end/summary) are filtered out", () => {
    const { parsed } = runPipeline(3)
    expect(parsed.every((item) => item.type === "match")).toBe(true)
  })
})
