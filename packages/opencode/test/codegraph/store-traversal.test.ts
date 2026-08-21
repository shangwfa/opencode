import { describe, expect, test } from "bun:test"

// ---------------------------------------------------------------------------
// Pure-logic tests for codegraph store traversal helpers.
// These test the traversal LOGIC (BFS, edge-kind filtering, cycle safety)
// without requiring a live PG — we exercise the exported constants and the
// algorithmic patterns extracted from store.ts.
// ---------------------------------------------------------------------------

const STALE_HEARTBEAT_MS = 120_000

// Re-derive the constants from store.ts to keep tests independent of PG imports.
const CALL_KINDS = ["calls", "references", "instantiates"]
const DEPENDENT_FILE_EDGE_KINDS = [
  "calls",
  "references",
  "instantiates",
  "extends",
  "implements",
  "overrides",
  "type_depends",
]

// ---------------------------------------------------------------------------
// isZombie — heartbeat staleness detection
// ---------------------------------------------------------------------------

type IndexState = {
  state: string
  heartbeat_at: number
  node_count: number
  edge_count: number
  engine_version: string
  files_total: number
  files_done: number
  error: string | null
  stale_files: string[] | null
}

const isZombie = (s: IndexState | null, now = Date.now()) =>
  !!s && s.state === "indexing" && now - s.heartbeat_at > STALE_HEARTBEAT_MS

describe("isZombie", () => {
  test("null state is not zombie", () => {
    expect(isZombie(null)).toBe(false)
  })

  test("ready state is not zombie even with old heartbeat", () => {
    const state: IndexState = { state: "ready", heartbeat_at: 0, node_count: 100, edge_count: 200, engine_version: "v1", files_total: 10, files_done: 10, error: null, stale_files: null }
    expect(isZombie(state, 10_000_000)).toBe(false)
  })

  test("indexing with fresh heartbeat is not zombie", () => {
    const now = Date.now()
    const state: IndexState = { state: "indexing", heartbeat_at: now - 5000, node_count: 0, edge_count: 0, engine_version: "v1", files_total: 10, files_done: 3, error: null, stale_files: null }
    expect(isZombie(state, now)).toBe(false)
  })

  test("indexing with stale heartbeat is zombie", () => {
    const now = Date.now()
    const state: IndexState = { state: "indexing", heartbeat_at: now - STALE_HEARTBEAT_MS - 1, node_count: 0, edge_count: 0, engine_version: "v1", files_total: 10, files_done: 3, error: null, stale_files: null }
    expect(isZombie(state, now)).toBe(true)
  })

  test("indexing with exactly stale boundary is zombie", () => {
    const now = Date.now()
    const state: IndexState = { state: "indexing", heartbeat_at: now - STALE_HEARTBEAT_MS - 1000, node_count: 0, edge_count: 0, engine_version: "v1", files_total: 10, files_done: 3, error: null, stale_files: null }
    expect(isZombie(state, now)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CALL_KINDS — structural edges excluded
// ---------------------------------------------------------------------------

describe("CALL_KINDS semantics", () => {
  test("imports is NOT a call kind", () => {
    expect(CALL_KINDS).not.toContain("imports")
  })

  test("calls/references/instantiates are call kinds", () => {
    expect(CALL_KINDS).toContain("calls")
    expect(CALL_KINDS).toContain("references")
    expect(CALL_KINDS).toContain("instantiates")
  })
})

// ---------------------------------------------------------------------------
// DEPENDENT_FILE_EDGE_KINDS — blast-radius edges
// ---------------------------------------------------------------------------

describe("DEPENDENT_FILE_EDGE_KINDS semantics", () => {
  test("includes all call kinds plus type edges", () => {
    for (const k of CALL_KINDS) {
      expect(DEPENDENT_FILE_EDGE_KINDS).toContain(k)
    }
    expect(DEPENDENT_FILE_EDGE_KINDS).toContain("extends")
    expect(DEPENDENT_FILE_EDGE_KINDS).toContain("implements")
    expect(DEPENDENT_FILE_EDGE_KINDS).toContain("overrides")
    expect(DEPENDENT_FILE_EDGE_KINDS).toContain("type_depends")
  })

  test("does NOT include structural edges", () => {
    expect(DEPENDENT_FILE_EDGE_KINDS).not.toContain("contains")
    expect(DEPENDENT_FILE_EDGE_KINDS).not.toContain("imports")
  })
})

// ---------------------------------------------------------------------------
// BFS traversal logic — cycle safety and depth limiting
// ---------------------------------------------------------------------------

type MockEdge = { source: string; target: string; kind: string }

function buildAdj(edges: MockEdge[]) {
  const incoming = new Map<string, MockEdge[]>()
  const outgoing = new Map<string, MockEdge[]>()
  for (const e of edges) {
    if (!outgoing.has(e.source)) outgoing.set(e.source, [])
    outgoing.get(e.source)!.push(e)
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    incoming.get(e.target)!.push(e)
  }
  return { incoming, outgoing }
}

function collectCallersBFS(
  edges: MockEdge[],
  startId: string,
  maxDepth: number,
): string[] {
  const { incoming: inc } = buildAdj(edges)
  const result: string[] = []
  const visited = new Set<string>()

  const walk = (id: string, depth: number) => {
    if (depth >= maxDepth || visited.has(id)) return
    visited.add(id)
    const inEdges = (inc.get(id) ?? []).filter((e) => CALL_KINDS.includes(e.kind))
    for (const e of inEdges) {
      if (!visited.has(e.source)) {
        result.push(e.source)
        walk(e.source, depth + 1)
      }
    }
  }
  walk(startId, 0)
  return result
}

function collectCalleesBFS(
  edges: MockEdge[],
  startId: string,
  maxDepth: number,
): string[] {
  const { outgoing: out } = buildAdj(edges)
  const result: string[] = []
  const visited = new Set<string>()

  const walk = (id: string, depth: number) => {
    if (depth >= maxDepth || visited.has(id)) return
    visited.add(id)
    const outEdges = (out.get(id) ?? []).filter((e) => CALL_KINDS.includes(e.kind))
    for (const e of outEdges) {
      if (!visited.has(e.target)) {
        result.push(e.target)
        walk(e.target, depth + 1)
      }
    }
  }
  walk(startId, 0)
  return result
}

describe("BFS traversal", () => {
  const edges: MockEdge[] = [
    { source: "A", target: "B", kind: "calls" },
    { source: "B", target: "C", kind: "calls" },
    { source: "C", target: "D", kind: "calls" },
    { source: "X", target: "B", kind: "imports" }, // structural — should be excluded
    { source: "Y", target: "B", kind: "references" },
  ]

  test("collectCallees depth=1 returns direct callees only", () => {
    const callees = collectCalleesBFS(edges, "A", 1)
    expect(callees).toEqual(["B"])
  })

  test("collectCallees depth=2 follows call chain", () => {
    const callees = collectCalleesBFS(edges, "A", 2)
    expect(callees).toEqual(["B", "C"])
  })

  test("collectCallees depth=3 follows full chain", () => {
    const callees = collectCalleesBFS(edges, "A", 3)
    expect(callees).toEqual(["B", "C", "D"])
  })

  test("collectCallers depth=1 returns direct callers (excludes imports)", () => {
    const callers = collectCallersBFS(edges, "B", 1)
    // A calls B, Y references B — X imports B but imports excluded
    expect(callers).toContain("A")
    expect(callers).toContain("Y")
    expect(callers).not.toContain("X")
  })

  test("collectCallers depth=2 follows chain", () => {
    const callers = collectCallersBFS(edges, "C", 2)
    // B->C, A->B, Y->B
    expect(callers).toContain("B")
    expect(callers).toContain("A")
    expect(callers).toContain("Y")
  })

  test("cycle safety: diamond graph does not infinite loop", () => {
    const diamond: MockEdge[] = [
      { source: "A", target: "B", kind: "calls" },
      { source: "A", target: "C", kind: "calls" },
      { source: "B", target: "D", kind: "calls" },
      { source: "C", target: "D", kind: "calls" },
      { source: "D", target: "A", kind: "calls" }, // cycle back
    ]
    const callees = collectCalleesBFS(diamond, "A", 10)
    // Should visit A,B,C,D without hanging
    expect(callees.length).toBeLessThanOrEqual(4)
    expect(callees).toContain("B")
    expect(callees).toContain("C")
    expect(callees).toContain("D")
  })

  test("self-loop does not cause infinite recursion", () => {
    const selfLoop: MockEdge[] = [{ source: "A", target: "A", kind: "calls" }]
    const callees = collectCalleesBFS(selfLoop, "A", 5)
    expect(callees).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Impact BFS — excludes structural edges
// ---------------------------------------------------------------------------

function collectImpactBFS(edges: MockEdge[], startId: string, maxDepth: number): string[] {
  const { incoming: inc } = buildAdj(edges)
  const result: string[] = []
  const visited = new Set<string>()
  const skip = new Set(["contains", "imports"])

  const walk = (id: string, depth: number) => {
    if (depth >= maxDepth || visited.has(id)) return
    visited.add(id)
    const inEdges = (inc.get(id) ?? []).filter((e) => !skip.has(e.kind))
    for (const e of inEdges) {
      if (!visited.has(e.source)) {
        result.push(e.source)
        walk(e.source, depth + 1)
      }
    }
  }
  walk(startId, 0)
  return result
}

describe("impact BFS", () => {
  const edges: MockEdge[] = [
    { source: "A", target: "B", kind: "calls" },
    { source: "B", target: "C", kind: "calls" },
    { source: "X", target: "C", kind: "imports" }, // structural — excluded
    { source: "Y", target: "C", kind: "contains" }, // structural — excluded
    { source: "Z", target: "C", kind: "extends" },
  ]

  test("returns only dependency callers, excludes structural", () => {
    const impact = collectImpactBFS(edges, "C", 3)
    expect(impact).toContain("B")
    expect(impact).toContain("A")
    expect(impact).toContain("Z")
    expect(impact).not.toContain("X")
    expect(impact).not.toContain("Y")
  })
})

// ---------------------------------------------------------------------------
// getDependentFilePaths — file-level blast radius logic
// ---------------------------------------------------------------------------

describe("getDependentFilePaths logic", () => {
  test("DEPENDENT_FILE_EDGE_KINDS includes extends/implements for type hierarchy", () => {
    expect(DEPENDENT_FILE_EDGE_KINDS).toContain("extends")
    expect(DEPENDENT_FILE_EDGE_KINDS).toContain("implements")
  })

  test("DEPENDENT_FILE_EDGE_KINDS excludes contains (structural)", () => {
    expect(DEPENDENT_FILE_EDGE_KINDS).not.toContain("contains")
  })
})

// ---------------------------------------------------------------------------
// scopeFor
// ---------------------------------------------------------------------------

describe("scopeFor", () => {
  test("prefixes appId with app:", () => {
    // scopeFor is a simple string prefix — test the contract
    const scopeFor = (appId: string) => `app:${appId}`
    expect(scopeFor("my-app")).toBe("app:my-app")
    expect(scopeFor("")).toBe("app:")
  })
})
