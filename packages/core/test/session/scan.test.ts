import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  MAX_SCAN_FILES,
  parseScanOutput,
  SandboxDefinitionCache,
  scanIncremental,
  truncateForError,
  validName,
  type ScannedFile,
} from "@opencode/core/session/scan"

const PREFIXES = ["/workspace/.opencode/agent/", "/workspace/.opencode/agents/"]

const scannedFile = (id: string, fingerprint: string): ScannedFile => ({
  path: `/workspace/.opencode/agents/${id}.md`,
  relative: `${id}.md`,
  id,
  fingerprint,
})
const found = <D>(definition: D) => () => Effect.succeed({ definition, cacheable: true })

test("parses scan fingerprints and rejects unusable names before the read cap", () => {
  const { files, discovered, skipped } = parseScanOutput(
    [
      "/workspace/.opencode/agents/reviewer.md\t1000.5\t12",
      "/workspace/.opencode/agents/reviewer.md\t1000.5\t12",
      "/workspace/.opencode/agent/nested/reviewer.md\t2000.5\t3",
      "/workspace/.opencode/agent/odd\tname.md\t3000.5\t3",
      "/workspace/.opencode/agent/../outside.md\t4000.5\t1",
      "/host/escape.md\t5000.5\t1",
    ].join("\n"),
    PREFIXES,
  )
  // Lines split from the right, so `odd\tname.md` derives the id `odd\tname` and is rejected
  // instead of being silently truncated into a usable-looking `odd`.
  expect(files.map((file) => [file.path, file.id, file.fingerprint])).toEqual([
    ["/workspace/.opencode/agent/nested/reviewer.md", "nested/reviewer", "2000.5\t3"],
    ["/workspace/.opencode/agents/reviewer.md", "reviewer", "1000.5\t12"],
  ])
  expect(discovered).toBe(2)
  expect(skipped).toBe(2)
})

test("bounds the read cap and reports the discovered total", () => {
  const output = Array.from({ length: 210 }, (_, index) => `/workspace/.opencode/agents/a-${index}.md\t1\t1`).join("\n")
  const { files, discovered } = parseScanOutput(output, PREFIXES, 5)
  expect(files).toHaveLength(5)
  expect(discovered).toBe(210)
})

test("validates sandbox definition names without traversal or empty segments", () => {
  for (const name of ["review", "docs/review-2.v1", "会话/审查", "nested/reviewer"])
    expect(validName(name)).toBe(true)
  for (const name of ["", "../outside", "docs/../outside", "docs//review", "/absolute", "has space", ".."])
    expect(validName(name)).toBe(false)
})

test("bounds sandbox output before it reaches logs or error messages", () => {
  expect(truncateForError("  sandbox unavailable  ")).toBe("sandbox unavailable")
  const bounded = truncateForError("x".repeat(900))
  expect(bounded).toHaveLength(501)
  expect(bounded.endsWith("…")).toBe(true)
})

test("bounds cached sessions and never mixes definitions across them", () => {
  const cache = new SandboxDefinitionCache<{ id: string }>(2)
  const entry = (id: string) => new Map([["/x.md", { fingerprint: "1", definition: { id } }]])
  cache.write("ses_a", entry("a"))
  cache.write("ses_b", entry("b"))
  expect(cache.read("ses_a").get("/x.md")?.definition).toEqual({ id: "a" })

  // A third session evicts the oldest entry instead of growing without limit.
  cache.write("ses_c", entry("c"))
  expect(cache.read("ses_a").size).toBe(0)
  expect(cache.read("ses_b").get("/x.md")?.definition).toEqual({ id: "b" })
  expect(cache.read("ses_c").get("/x.md")?.definition).toEqual({ id: "c" })

  // Rewriting a session refreshes its recency, and an empty write clears it.
  cache.write("ses_b", entry("b2"))
  cache.write("ses_d", entry("d"))
  expect(cache.read("ses_c").size).toBe(0)
  expect(cache.read("ses_b").get("/x.md")?.definition).toEqual({ id: "b2" })
  cache.write("ses_b", new Map())
  expect(cache.read("ses_b").size).toBe(0)

  cache.invalidate("ses_d")
  expect(cache.read("ses_d").size).toBe(0)
})

test("a scan that finishes later cannot roll the cache back to an older listing", async () => {
  const cache = new SandboxDefinitionCache<{ v: string }>()
  const sessionID = "ses_rollback"
  const path = "/workspace/.opencode/agents/race.md"
  const program = Effect.gen(function* () {
    // The newer listing stores its result first.
    yield* scanIncremental(cache, sessionID, [scannedFile("race", "2000:1")], found({ v: "new" }), { at: 200 })
    // An older listing (earlier `at`) completes later and must not overwrite it.
    const stale = yield* scanIncremental(cache, sessionID, [scannedFile("race", "1000:1")], found({ v: "old" }), { at: 100 })
    return { stored: cache.read(sessionID).get(path)?.definition, staleDefinitions: stale.definitions }
  })
  const result = await Effect.runPromise(program)
  expect(result.stored).toEqual({ v: "new" })
  // The stale scan still returns what it read; only the cache write is refused.
  expect(result.staleDefinitions).toEqual([{ v: "old" }])
})

test("concurrent scans return complete definitions with a bounded read count", async () => {
  const cache = new SandboxDefinitionCache<{ v: string }>()
  const sessionID = "ses_concurrent"
  let reads = 0
  const scan = (at: number) =>
    scanIncremental(
      cache,
      sessionID,
      [scannedFile("a", "1:1"), scannedFile("b", "1:1")],
      (target) => {
        reads++
        return Effect.succeed({ definition: { v: target.id }, cacheable: true })
      },
      { at },
    )
  const results = await Effect.runPromise(Effect.all([scan(10), scan(11)], { concurrency: 2 }))
  expect(results.map((result) => result.definitions.map((item) => item.v).sort())).toEqual([
    ["a", "b"],
    ["a", "b"],
  ])
  // No single-flight contract: at most one read pass per concurrent scan, never partial results.
  expect(reads).toBeGreaterThan(0)
  expect(reads).toBeLessThanOrEqual(4)
})

test("two independent caches both resolve the current sandbox content", async () => {
  const a = new SandboxDefinitionCache<{ v: string }>()
  const b = new SandboxDefinitionCache<{ v: string }>()
  const sessionID = "ses_instances"
  const path = "/workspace/.opencode/agents/shared.md"
  let fingerprint = "1:1"
  let value = "first"
  const scan = (cache: SandboxDefinitionCache<{ v: string }>, at: number) =>
    scanIncremental(cache, sessionID, [scannedFile("shared", fingerprint)], found({ v: value }), { at })

  await Effect.runPromise(scan(a, 10))
  await Effect.runPromise(scan(b, 11))
  expect(a.read(sessionID).get(path)?.definition).toEqual({ v: "first" })
  expect(b.read(sessionID).get(path)?.definition).toEqual({ v: "first" })

  // Each process re-lists on its own and must see the new content without any shared cache.
  fingerprint = "2:1"
  value = "second"
  await Effect.runPromise(scan(a, 20))
  await Effect.runPromise(scan(b, 21))
  expect(a.read(sessionID).get(path)?.definition).toEqual({ v: "second" })
  expect(b.read(sessionID).get(path)?.definition).toEqual({ v: "second" })

  // The caches are independent: invalidating one leaves the other intact.
  a.invalidate(sessionID)
  expect(b.read(sessionID).size).toBe(1)
})
