import { describe, expect, test } from "bun:test"
import { mock } from "bun:test"
import { contentHash, CcrStore, type CcrEntry, type CcrStorageBackend } from "../../src/plugin/ccr/lib/store"
import type { CcrConfig } from "../../src/plugin/ccr/lib/config"
import { CcrPlugin } from "../../src/plugin/ccr/index"

// The lazy default resolver imports "@/session/session" and "@/effect/app-runtime"
// at first use. Intercept both so the walk is exercised without booting the real
// runtime; `lazyRunPromiseBehavior` decides what the fake AppRuntime.runPromise does.
let lazyRunPromiseBehavior: (() => Promise<string | undefined>) | undefined
mock.module("@/session/session", () => ({ Session: { Service: Symbol.for("test.ccr.Session.Service") } }))
mock.module("@/effect/app-runtime", () => ({
  AppRuntime: {
    // test/preload.ts's afterAll also imports this module and calls dispose;
    // keep the mock a safe stand-in for both consumers.
    dispose: async () => {},
    runPromise: async () => lazyRunPromiseBehavior?.() ?? undefined,
  },
}))

const baseConfig: CcrConfig = {
  minTokens: 1000,
  protectRecent: 2,
  previewTokens: 300,
  ttlSeconds: 0,
}

function makeBackend() {
  const entries = new Map<string, CcrEntry>()
  const backend: CcrStorageBackend = {
    async read(key) {
      return entries.get(key.join("/")) ?? null
    },
    async write(key, content) {
      entries.set(key.join("/"), content)
    },
  }
  return { entries, backend }
}

const bigJson = JSON.stringify(Array.from({ length: 500 }, (_, i) => ({ id: i, data: "d".repeat(100) })))
type Hooks = Awaited<ReturnType<typeof CcrPlugin>>

type RetrieveExecute = NonNullable<NonNullable<Hooks["tool"]>["ccr_retrieve"]["execute"]>

const fakeCtx = { sessionID: "ses_child" } as unknown as Parameters<RetrieveExecute>[1]

async function executeRetrieve(hooks: Hooks, args: { hash: string }, sessionID: string) {
  const execute = hooks.tool!.ccr_retrieve!.execute as (args: { hash: string }, ctx: unknown) => Promise<string>
  return execute(args, { sessionID })
}

describe("CcrPlugin ccr_retrieve", () => {
  test("returns no hooks when disabled", async () => {
    const hooks = await CcrPlugin({} as Parameters<typeof CcrPlugin>[0], { enabled: false })
    expect(hooks.tool).toBeUndefined()
  })

  test("falls back to the parent entry when resolveParent is injected", async () => {
    const { backend } = makeBackend()
    const hooks = await CcrPlugin({} as Parameters<typeof CcrPlugin>[0], {
      enabled: true,
      storage: backend,
      resolveParent: async (sid: string) => (sid === "ses_child" ? "ses_parent" : undefined),
    })
    // plant the entry under the parent session, from the parent's own compression pass
    const store = new CcrStore(backend, baseConfig)
    await store.replace({ sessionID: "ses_parent", messageID: "m", tool: "bash", output: bigJson })

    const output = await executeRetrieve(hooks, { hash: contentHash(bigJson) }, "ses_child")
    expect(output).toBe(bigJson)
  })

  test("expired entry in parent yields the expired guidance, not not_found", async () => {
    const { entries, backend } = makeBackend()
    const hooks = await CcrPlugin({} as Parameters<typeof CcrPlugin>[0], {
      enabled: true,
      storage: backend,
      resolveParent: async (sid: string) => (sid === "ses_child" ? "ses_parent" : undefined),
    })
    const store = new CcrStore(backend, { ...baseConfig, ttlSeconds: 1800 })
    await store.replace({ sessionID: "ses_parent", messageID: "m", tool: "bash", output: bigJson })
    const key = ["plugin", "ccr", "ses_parent", contentHash(bigJson)].join("/")
    entries.set(key, { ...entries.get(key)!, expiresAt: new Date(Date.now() - 1000).toISOString() })

    const output = await executeRetrieve(hooks, { hash: contentHash(bigJson) }, "ses_child")
    expect(output).toContain("Entry expired")
    expect(output).toContain("CCR TTL: 1800 seconds")
  })

  test("lazy default resolver resolves the parent through AppRuntime", async () => {
    const { backend } = makeBackend()
    const hooks = await CcrPlugin({} as Parameters<typeof CcrPlugin>[0], { enabled: true, storage: backend })
    const store = new CcrStore(backend, baseConfig)
    await store.replace({ sessionID: "ses_parent", messageID: "m", tool: "bash", output: bigJson })

    lazyRunPromiseBehavior = async () => "ses_parent"
    const output = await executeRetrieve(hooks, { hash: contentHash(bigJson) }, "ses_child")
    expect(output).toBe(bigJson)
  })

  test("lazy default resolver degrades to not_found when AppRuntime fails", async () => {
    const { backend } = makeBackend()
    const hooks = await CcrPlugin({} as Parameters<typeof CcrPlugin>[0], { enabled: true, storage: backend })
    lazyRunPromiseBehavior = async () => {
      throw new Error("runtime not ready")
    }
    const output = await executeRetrieve(hooks, { hash: "deadbeefdeadbeefdeadbeef" }, "ses_child")
    expect(output).toContain("Content not found")
  })
})
