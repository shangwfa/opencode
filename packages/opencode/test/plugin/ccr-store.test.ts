import { describe, expect, test } from "bun:test"
import { contentHash, CcrStore, type CcrEntry, type CcrStorageBackend } from "../../src/plugin/ccr/lib/store"
import type { CcrConfig } from "../../src/plugin/ccr/lib/config"

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

describe("CcrStore.replace", () => {
  test("compresses and persists a full-metadata entry (Headroom parity)", async () => {
    const { entries, backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)

    const replacement = await store.replace({
      sessionID: "ses_1",
      messageID: "msg_1",
      tool: "read",
      output: bigJson,
    })

    expect(replacement).toBeDefined()
    expect(replacement).toContain("[ccr:")
    expect(replacement).toContain("Retrieve original: hash=")
    expect(replacement).toContain("500 items compressed to")
    expect(replacement).not.toContain("Expires in")

    const hash = contentHash(bigJson)
    const entry = entries.get(["plugin", "ccr", "ses_1", hash].join("/"))
    expect(entry).toBeDefined()
    expect(entry!.original).toBe(bigJson)
    expect(entry!.originalItems).toBe(500)
    expect(entry!.compressedItems).toBeLessThan(500)
    expect(entry!.compressedTokens).toBeGreaterThan(0)
    expect(entry!.retrievalCount).toBe(0)
    expect(entry!.expiresAt).toBeUndefined()
  })

  test("renders an expiry notice when ttlSeconds is set", async () => {
    const { backend } = makeBackend()
    const store = new CcrStore(backend, { ...baseConfig, ttlSeconds: 1800 })
    const replacement = await store.replace({
      sessionID: "s",
      messageID: "m",
      tool: "read",
      output: bigJson,
    })
    expect(replacement).toContain("Expires in 30m.")
  })

  test("is idempotent across all marker shapes (Headroom #2694 guard)", async () => {
    const store = new CcrStore(undefined, baseConfig)
    for (const marked of [
      "[ccr:abc] preview\n[Retrieve original: hash=abc.]",
      "[... elided. Retrieve original: hash=abc]",
      "[3 items compressed to 1. Retrieve more: hash=abc. Expires in 30m.]",
      "<<ccr:abc,base64,4.5KB>>",
    ]) {
      expect(
        await store.replace({ sessionID: "s", messageID: "m", tool: "read", output: marked }),
      ).toBeUndefined()
    }
  })

  test("returns the same replacement for identical content (cache)", async () => {
    const { entries, backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)
    const first = await store.replace({ sessionID: "s", messageID: "m1", tool: "read", output: bigJson })
    const writesAfterFirst = entries.size
    const second = await store.replace({ sessionID: "s", messageID: "m2", tool: "read", output: bigJson })
    expect(second).toBe(first)
    expect(entries.size).toBe(writesAfterFirst)
  })

  test("evicts the oldest cached replacement beyond 1000 entries (LRU)", async () => {
    const store = new CcrStore(undefined, baseConfig)
    for (let i = 0; i < 1002; i++) {
      await store.replace({ sessionID: "s", messageID: "m", tool: "read", output: `x${i}`.repeat(2000) })
    }
    const keys = (store as any).replacements as Map<string, string>
    expect(keys.size).toBeLessThanOrEqual(1000)
  })

  test("skips outputs that do not shrink enough", async () => {
    const store = new CcrStore(undefined, baseConfig)
    const dense = "z".repeat(8000)
    expect(await store.replace({ sessionID: "s", messageID: "m", tool: "read", output: dense })).toBeUndefined()
  })

  test("survives backend write failures", async () => {
    const failingBackend: CcrStorageBackend = {
      async read() {
        return null
      },
      async write() {
        throw new Error("pg down")
      },
    }
    const store = new CcrStore(failingBackend, baseConfig)
    const replacement = await store.replace({ sessionID: "s", messageID: "m", tool: "read", output: bigJson })
    expect(replacement).toBeDefined()
  })
})

describe("CcrStore.retrieve", () => {
  test("round-trips an entry and records the retrieval count", async () => {
    const { entries, backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)
    await store.replace({ sessionID: "ses_9", messageID: "msg_9", tool: "bash", output: bigJson })
    const hash = contentHash(bigJson)
    const key = ["plugin", "ccr", "ses_9", hash].join("/")

    const first = await store.retrieve("ses_9", hash)
    expect(first.status).toBe("available")
    if (first.status === "available") {
      expect(first.content).toBe(bigJson)
      expect(first.strategy).toBe("json")
    }
    expect(entries.get(key)!.retrievalCount).toBe(1)

    await store.retrieve("ses_9", hash)
    expect(entries.get(key)!.retrievalCount).toBe(2)
  })

  test("returns expired status when ttl has passed", async () => {
    const { entries, backend } = makeBackend()
    const store = new CcrStore(backend, { ...baseConfig, ttlSeconds: 1800 })
    await store.replace({ sessionID: "s", messageID: "m", tool: "read", output: bigJson })
    const hash = contentHash(bigJson)
    const key = ["plugin", "ccr", "s", hash].join("/")
    entries.set(key, { ...entries.get(key)!, expiresAt: new Date(Date.now() - 1000).toISOString() })

    const result = await store.retrieve("s", hash)
    expect(result.status).toBe("expired")
    if (result.status === "expired") expect(result.ttlSeconds).toBe(1800)
  })

  test("returns not_found for unknown hash or other sessions", async () => {
    const { backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)
    await store.replace({ sessionID: "ses_9", messageID: "msg_9", tool: "bash", output: bigJson })
    expect((await store.retrieve("ses_9", "deadbeefdeadbeefdeadbeef")).status).toBe("not_found")
    expect((await store.retrieve("ses_other", contentHash(bigJson))).status).toBe("not_found")
  })

  test("returns not_found without a backend (in-memory mode)", async () => {
    const store = new CcrStore(undefined, baseConfig)
    expect((await store.retrieve("s", contentHash(bigJson))).status).toBe("not_found")
  })
})

describe("CcrStore.retrieveAlongAncestry", () => {
  test("hits in the own session without touching resolveParent", async () => {
    const { backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)
    await store.replace({ sessionID: "ses_a", messageID: "m", tool: "bash", output: bigJson })
    let parentCalls = 0
    const result = await store.retrieveAlongAncestry("ses_a", contentHash(bigJson), async () => {
      parentCalls++
      return undefined
    })
    expect(result.status).toBe("available")
    expect(parentCalls).toBe(0)
  })

  test("falls back to the parent session entry", async () => {
    const { backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)
    await store.replace({ sessionID: "ses_parent", messageID: "m", tool: "bash", output: bigJson })
    const hash = contentHash(bigJson)
    const result = await store.retrieveAlongAncestry("ses_child", hash, async (sid) =>
      sid === "ses_child" ? "ses_parent" : undefined,
    )
    expect(result.status).toBe("available")
    if (result.status === "available") expect(result.content).toBe(bigJson)
    expect((await store.retrieve("ses_parent", hash)).status).toBe("available")
  })

  test("walks multiple ancestor levels and honors maxDepth", async () => {
    const { backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)
    await store.replace({ sessionID: "ses_root", messageID: "m", tool: "bash", output: bigJson })
    const chain: Record<string, string | undefined> = {
      ses_c: "ses_b",
      ses_b: "ses_a",
      ses_a: "ses_root",
      ses_root: undefined,
    }
    const result = await store.retrieveAlongAncestry("ses_c", contentHash(bigJson), async (sid) => chain[sid])
    expect(result.status).toBe("available")

    const short = await store.retrieveAlongAncestry("ses_c", contentHash(bigJson), async (sid) => chain[sid], 1)
    expect(short.status).toBe("not_found")
  })

  test("survives a throwing resolveParent and returns not_found", async () => {
    const { backend } = makeBackend()
    const store = new CcrStore(backend, baseConfig)
    const result = await store.retrieveAlongAncestry("ses_x", "deadbeefdeadbeefdeadbeef", async () => {
      throw new Error("resolver down")
    })
    expect(result.status).toBe("not_found")
  })
})
