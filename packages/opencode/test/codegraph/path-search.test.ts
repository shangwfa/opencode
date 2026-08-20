import { describe, expect, test } from "bun:test"
import { pathMatches, filterByFilePath } from "../../src/codegraph/path"
import {
  isTestFile,
  nameMatchBonus,
  kindBonus,
  scorePathRelevance,
  isDistinctiveIdentifier,
  isLowConfidenceQuery,
} from "../../src/codegraph/search"

describe("codegraph.pathMatches", () => {
  test("exact and suffix on path boundary", () => {
    expect(pathMatches("repo/src/extraction/tree-sitter.ts", "repo/src/extraction/tree-sitter.ts")).toBe(true)
    expect(pathMatches("repo/src/extraction/tree-sitter.ts", "src/extraction/tree-sitter.ts")).toBe(true)
    expect(pathMatches("repo/src/extraction/tree-sitter.ts", "./src/extraction/tree-sitter.ts")).toBe(true)
    expect(pathMatches("repo/src/extraction/tree-sitter.ts", "/workspace/repo/src/extraction/tree-sitter.ts")).toBe(true)
    expect(pathMatches("repo/src/extraction/tree-sitter.ts", "tree-sitter.ts")).toBe(true)
  })

  test("rejects non-boundary suffix (ar.ts vs bar.ts)", () => {
    expect(pathMatches("repo/src/foo/bar.ts", "ar.ts")).toBe(false)
    expect(pathMatches("repo/src/foo/bar.ts", "oo/bar.ts")).toBe(false)
  })

  test("filterByFilePath narrows when match exists, else keeps all", () => {
    const nodes = [
      { file_path: "repo/src/a.ts", id: "1" },
      { file_path: "repo/src/b.ts", id: "2" },
      { file_path: "other/src/a.ts", id: "3" },
    ]
    expect(filterByFilePath(nodes, "src/a.ts").map((n) => n.id)).toEqual(["1", "3"])
    expect(filterByFilePath(nodes, "missing.ts").map((n) => n.id)).toEqual(["1", "2", "3"])
    expect(filterByFilePath(nodes, undefined).length).toBe(3)
  })
})

describe("codegraph.search ranking", () => {
  test("isTestFile detects common layouts", () => {
    expect(isTestFile("repo/__tests__/foo.test.ts")).toBe(true)
    expect(isTestFile("src/foo.spec.ts")).toBe(true)
    expect(isTestFile("tests/unit/bar.ts")).toBe(true)
    expect(isTestFile("src/service.ts")).toBe(false)
  })

  test("nameMatchBonus prefers exact over substring", () => {
    expect(nameMatchBonus("extractFromSource", "extractFromSource")).toBeGreaterThan(
      nameMatchBonus("extractFromSourceHelper", "extractFromSource"),
    )
    expect(nameMatchBonus("extractFromSource", "extractFromSource")).toBe(80)
    expect(nameMatchBonus("foo", "zzzz")).toBe(0)
  })

  test("kindBonus ranks functions above variables", () => {
    expect(kindBonus("function")).toBeGreaterThan(kindBonus("variable"))
    expect(kindBonus("route")).toBeGreaterThan(kindBonus("import"))
  })

  test("scorePathRelevance dampens test files unless query is test-like", () => {
    const prod = scorePathRelevance("src/auth/session.ts", "session")
    const test = scorePathRelevance("src/auth/session.test.ts", "session")
    expect(prod).toBeGreaterThan(test)
    const testQuery = scorePathRelevance("src/auth/session.test.ts", "session test")
    expect(testQuery).toBeGreaterThan(test)
  })

  test("LOW_CONFIDENCE for plain words, not for camelCase identifiers", () => {
    expect(isLowConfidenceQuery("data handler flow")).toBe(true)
    expect(isLowConfidenceQuery("extractFromSource")).toBe(false)
    expect(isDistinctiveIdentifier("extractFromSource")).toBe(true)
    expect(isDistinctiveIdentifier("handler")).toBe(false)
  })
})
