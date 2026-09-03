import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate the fs-fallback storage directory before the module (whose
// STORAGE_DIR constant is evaluated at import time) is loaded.
const fsFallbackRoot = mkdtempSync(join(tmpdir(), "dcp-persistence-"))
process.env.XDG_DATA_HOME = fsFallbackRoot

type Persisted = import("../../src/plugin/dcp/lib/state/persistence").PersistedSessionState

const {
  setStorageBackend,
  saveSessionState,
  loadSessionState,
  loadSessionStats,
  loadAllSessionStats,
  saveManualModeSetting,
  loadManualModeSetting,
} = await import("../../src/plugin/dcp/lib/state/persistence")

function makeRuntimeState(overrides: Record<string, any> = {}): any {
  // SessionState's runtime shape: Maps/Sets for the mutable collections.
  return {
    sessionId: SID,
    manualMode: false,
    prune: {
      tools: new Map([["call-1", 120]]),
      messages: {
        byMessageId: new Map(),
        blocksById: new Map(),
        activeBlockIds: new Set(),
        activeByAnchorMessageId: new Map(),
        nextBlockId: 1,
        nextRunId: 1,
      },
    },
    nudges: {
      contextLimitAnchors: new Set(),
      turnNudgeAnchors: new Set(),
      iterationNudgeAnchors: new Set(),
    },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 120 },
    ...overrides,
  }
}

function makeState(overrides: Partial<Persisted> = {}): Persisted {
  return {
    manualMode: false,
    prune: {
      tools: { "call-1": 120 },
      messages: {
        byMessageId: {},
        blocksById: {},
        activeBlockIds: [],
        activeByAnchorMessageId: {},
        nextBlockId: 1,
        nextRunId: 1,
      },
    },
    nudges: {
      contextLimitAnchors: [],
      turnNudgeAnchors: [],
      iterationNudgeAnchors: [],
    },
    stats: { pruneTokenCounter: 0, totalPruneTokens: 120 },
    lastUpdated: new Date().toISOString(),
    ...overrides,
  }
}

type Recorded = { key: string[]; content: Persisted }

function makeBackend() {
  const store = new Map<string, Persisted>()
  const writes: Recorded[] = []
  const backend = {
    async read(key: string[]) {
      const found = store.get(key.join("/"))
      return found ? structuredClone(found) : null
    },
    async write(key: string[], content: Persisted) {
      writes.push({ key, content: structuredClone(content) })
      store.set(key.join("/"), structuredClone(content))
    },
    async list(prefix: string[]) {
      const p = prefix.join("/")
      return [...store.keys()]
        .filter((k) => k.startsWith(`${p}/`))
        .sort()
        .map((k) => k.split("/"))
    },
  }
  return { backend, store, writes }
}

const logger = {
  enabled: false,
  logDir: join(fsFallbackRoot, "logs"),
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any

const SID = "ses_test_1234"

function persist(input: any, log = logger, sessionName?: string) {
  return saveSessionState(makeRuntimeState(input), log, sessionName)
}

describe("DCP persistence storage backend", () => {
  beforeEach(() => {
    setStorageBackend(undefined)
  })
  afterEach(() => {
    setStorageBackend(undefined)
  })

  test("saveSessionState routes through the backend with the canonical key", async () => {
    const { backend, writes } = makeBackend()
    setStorageBackend(backend)

    await persist({}, logger, "My Session")

    expect(writes).toHaveLength(1)
    expect(writes[0]!.key).toEqual(["plugin", "dcp", SID])
    expect(writes[0]!.content.sessionName).toBe("My Session")
    expect((writes[0]!.content.prune.tools as any)?.["call-1"]).toBe(120)
  })

  test("loadSessionState roundtrips state saved via the backend", async () => {
    const { backend } = makeBackend()
    setStorageBackend(backend)
    await saveSessionState(makeRuntimeState(), logger)

    const loaded = await loadSessionState(SID, logger)

    expect(loaded).not.toBeNull()
    expect(loaded!.prune.tools?.["call-1"]).toBe(120)
    expect(loaded!.manualMode).toBe(false)
  })

  test("loadSessionState returns null when the backend has no entry", async () => {
    const { backend } = makeBackend()
    setStorageBackend(backend)

    expect(await loadSessionState("ses_unknown", logger)).toBeNull()
  })

  test("loadSessionState rejects malformed backend payloads", async () => {
    setStorageBackend({
      async read() {
        return { prune: {} } as unknown as Persisted
      },
      async write() {},
      async list() {
        return []
      },
    })

    expect(await loadSessionState(SID, logger)).toBeNull()
  })

  test("loadSessionState dedupes and filters malformed contextLimitAnchors", async () => {
    const { backend } = makeBackend()
    setStorageBackend(backend)
    const state = makeRuntimeState()
    state.nudges.contextLimitAnchors = new Set(["msg_a", "msg_a", "msg_b"])
    await saveSessionState(state, logger)

    const loaded = await loadSessionState(SID, logger)

    expect(loaded!.nudges.contextLimitAnchors).toEqual(["msg_a", "msg_b"])
  })

  test("saveSessionState swallows backend write failures", async () => {
    setStorageBackend({
      async read() {
        return null
      },
      async write() {
        throw new Error("pg down")
      },
      async list() {
        return []
      },
    })

    await expect(persist({ sessionId: SID } as any, logger)).resolves.toBeUndefined()
  })

  test("manual mode setting roundtrips through the backend", async () => {
    const { backend, store } = makeBackend()
    setStorageBackend(backend)

    await saveManualModeSetting(SID, true, logger)

    expect(await loadManualModeSetting(SID, logger)).toBe(true)
    expect([...store.keys()][0]).toBe(`plugin/dcp/${SID}`)
  })

  test("loadAllSessionStats aggregates across sessions via the backend", async () => {
    const { backend } = makeBackend()
    setStorageBackend(backend)
    await saveSessionState(makeRuntimeState({ sessionId: "ses_a" }), logger)
    await saveSessionState(makeRuntimeState({ sessionId: "ses_b" }), logger)

    const stats = await loadAllSessionStats(logger)

    expect(stats.sessionCount).toBe(2)
    expect(stats.totalTokens).toBe(240)
    expect(stats.totalTools).toBe(2)
  })

  test("loadSessionStats returns session-scoped compression metrics", async () => {
    const { backend } = makeBackend()
    setStorageBackend(backend)
    const state = makeRuntimeState()
    state.prune.messages.byMessageId.set("message-1", {
      tokenCount: 80,
      allBlockIds: [1],
      activeBlockIds: [1],
    })
    state.prune.messages.blocksById.set(1, {
      active: true,
      compressedTokens: 80,
      summaryTokens: 20,
      durationMs: 1500,
    } as any)
    await saveSessionState(state, logger)

    await expect(loadSessionStats(SID, logger)).resolves.toMatchObject({
      hasState: true,
      totalTokensSaved: 120,
      prunedTools: 1,
      prunedMessages: 1,
      compressionBlocks: 1,
      activeCompressionBlocks: 1,
      compressedTokens: 80,
      summaryTokens: 20,
      compressionDurationMs: 1500,
    })
  })

  test("backend is a process-wide singleton: the last backend set wins", async () => {
    const first = makeBackend()
    const second = makeBackend()
    setStorageBackend(first.backend)
    setStorageBackend(second.backend)

    await persist({}, logger)

    expect(first.writes).toHaveLength(0)
    expect(second.writes).toHaveLength(1)
  })

  test("fs fallback (no backend) writes under XDG_DATA_HOME and reloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "dcp-fs-fallback-"))
    const modPath = new URL("../../src/plugin/dcp/lib/state/persistence.ts", import.meta.url).pathname
    const script = `
      const MOD_PATH = ${JSON.stringify(modPath)}
      process.env.XDG_DATA_HOME = ${JSON.stringify(root)}
      const p = await import(MOD_PATH)
      const state = {
        sessionId: "ses_fs_fb",
        manualMode: false,
        prune: { tools: new Map(), messages: { byMessageId: new Map(), blocksById: new Map(), activeBlockIds: new Set(), activeByAnchorMessageId: new Map(), nextBlockId: 1, nextRunId: 1 } },
        nudges: { contextLimitAnchors: new Set(), turnNudgeAnchors: new Set(), iterationNudgeAnchors: new Set() },
        stats: { pruneTokenCounter: 0, totalPruneTokens: 7 },
        lastUpdated: new Date().toISOString(),
      }
      await p.saveSessionState(state, { enabled: false, info(){}, warn(){}, error(){}, debug(){} })
      const loaded = await p.loadSessionState("ses_fs_fb", { enabled: false, info(){}, warn(){}, error(){}, debug(){} })
      console.log("LOADED:" + (loaded ? loaded.stats.totalPruneTokens : "null"))
      console.log("FILE:" + require("fs").existsSync(require("path").join(process.env.XDG_DATA_HOME, "opencode/storage/plugin/dcp/ses_fs_fb.json")))
    `
    const proc = Bun.spawnSync(["bun", "-e", script], { cwd: process.cwd() })
    const out = proc.stdout.toString()
    if (proc.exitCode !== 0) throw new Error(`child failed: ${proc.stderr.toString().slice(0, 500)}`)
    expect(out).toContain("LOADED:7")
    expect(out).toContain("FILE:true")
    rmSync(root, { recursive: true, force: true })
  })
})
