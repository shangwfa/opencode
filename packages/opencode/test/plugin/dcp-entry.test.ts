import { afterEach, describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"

const { DcpPlugin } = await import("../../src/plugin/dcp/index")
const persistence = await import("../../src/plugin/dcp/lib/state/persistence")

function ctx(): PluginInput {
  return {
    directory: "/tmp/dcp-entry-test",
    worktree: "/tmp/dcp-entry-test",
    client: {},
  } as unknown as PluginInput
}

const silentLogger = {
  enabled: false,
  info() {},
  warn() {},
  error() {},
  debug() {},
} as any

// saveSessionState requires the full PersistedSessionState shape.
const stateFixture = {
  manualMode: false,
  prune: {
    tools: new Map(),
    messages: {
      byMessageId: new Map(),
      blocksById: new Map(),
      activeBlockIds: new Set(),
      activeByAnchorMessageId: new Map(),
      nextBlockId: 1,
      nextRunId: 1,
    },
  },
  nudges: { contextLimitAnchors: new Set(), turnNudgeAnchors: new Set(), iterationNudgeAnchors: new Set() },
  stats: { pruneTokenCounter: 0, totalPruneTokens: 0 },
  lastUpdated: new Date().toISOString(),
}

function makeBackend() {
  const writes: { key: string[]; content: unknown }[] = []
  return {
    async read() {
      return null
    },
    async write(key: string[], content: unknown) {
      writes.push({ key, content })
    },
    async list() {
      return []
    },
    writes,
  }
}

describe("DcpPlugin entry", () => {
  afterEach(() => {
    persistence.setStorageBackend(undefined)
  })

  test("is inert without options.enabled", async () => {
    expect(await DcpPlugin(ctx())).toEqual({})
    expect(await DcpPlugin(ctx(), { enabled: false })).toEqual({})
  })

  test("registers the expected hooks and the compress tool when enabled", async () => {
    const hooks = (await DcpPlugin(ctx(), { enabled: true })) as Record<string, any>

    expect(typeof hooks["experimental.chat.system.transform"]).toBe("function")
    expect(typeof hooks["experimental.chat.messages.transform"]).toBe("function")
    expect(typeof hooks["experimental.text.complete"]).toBe("function")
    expect(typeof hooks["command.execute.before"]).toBe("function")
    expect(typeof hooks["event"]).toBe("function")
    // compress is a tool definition object created by createCompressRangeTool.
    expect(hooks.tool.compress).toBeDefined()
  })

  test("injected storage backend receives persisted state", async () => {
    const backend = makeBackend()

    // The plugin must hand the backend to the persistence module, so a later
    // saveSessionState call (from any hook) lands in the backend, not on disk.
    await DcpPlugin(ctx(), { enabled: true, storage: backend })

    await persistence.saveSessionState({ sessionId: "ses_entry_test", ...stateFixture } as any, silentLogger)

    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0]!.key).toEqual(["plugin", "dcp", "ses_entry_test"])
  })
})
