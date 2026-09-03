import { describe, expect, test } from "bun:test"
import { createMessageTransform } from "../../src/plugin/ccr/lib/transform"
import { CcrStore, type CcrStorageBackend } from "../../src/plugin/ccr/lib/store"
import type { CcrConfig } from "../../src/plugin/ccr/lib/config"

const config: CcrConfig = { minTokens: 200, protectRecent: 2, previewTokens: 300, ttlSeconds: 0 }

function makeBackend() {
  const entries = new Map<string, any>()
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

function bigOutput(lines = 400): string {
  return Array.from({ length: lines }, (_, i) => `plain output line ${i} with filler text here`).join("\n")
}

function buildMessages(count: number, output: string, tool = "read") {
  return Array.from({ length: count }, (_, i) => ({
    info: {
      id: `msg_${String(i).padStart(4, "0")}`,
      sessionID: "ses_test",
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
    },
    parts: [
      {
        type: "tool" as const,
        tool,
        callID: `call_${i}`,
        state: { status: "completed", output },
      },
    ],
  }))
}

describe("createMessageTransform", () => {
  test("compresses eligible completed tool outputs and stores originals", async () => {
    const { entries, backend } = makeBackend()
    const store = new CcrStore(backend, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(6, bigOutput())

    await transform({}, { messages })

    const compressed = messages.filter(
      (m) => typeof m.parts[0].state?.output === "string" && m.parts[0].state!.output!.includes("[ccr:"),
    )
    expect(compressed.length).toBe(6 - config.protectRecent)
    expect(entries.size).toBeGreaterThanOrEqual(1)
  })

  test("leaves the most recent messages untouched", async () => {
    const store = new CcrStore(undefined, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(4, bigOutput())

    await transform({}, { messages })

    for (let i = 4 - config.protectRecent; i < 4; i++) {
      expect(messages[i].parts[0].state!.output).not.toContain("[ccr:")
    }
  })

  test("skips running, errored and excluded tools", async () => {
    const store = new CcrStore(undefined, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(6, bigOutput())

    messages[0].parts[0].state!.status = "running"
    messages[1].parts[0].state!.status = "error"
    const editPart = messages[2].parts[0] as any
    editPart.tool = "edit"

    await transform({}, { messages })

    expect(messages[0].parts[0].state!.output).not.toContain("[ccr:")
    expect(messages[1].parts[0].state!.output).not.toContain("[ccr:")
    expect(messages[2].parts[0].state!.output).not.toContain("[ccr:")
    expect(messages[3].parts[0].state!.output).toContain("[ccr:")
  })

  test("skips outputs below the token threshold", async () => {
    const store = new CcrStore(undefined, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(4, "tiny output")

    await transform({}, { messages })

    for (const m of messages) {
      expect(m.parts[0].state!.output).toBe("tiny output")
    }
  })

  test("is idempotent across repeated requests", async () => {
    const store = new CcrStore(undefined, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(4, bigOutput())

    await transform({}, { messages })
    const afterFirst = messages.map((m) => m.parts[0].state!.output)
    await transform({}, { messages })
    const afterSecond = messages.map((m) => m.parts[0].state!.output)

    expect(afterSecond).toEqual(afterFirst)
    expect(afterFirst[0]).toContain("[ccr:")
  })

  test("handles malformed message shapes without throwing", async () => {
    const store = new CcrStore(undefined, config)
    const transform = createMessageTransform(store, config)
    const messages: any[] = [
      { info: { id: "msg_1", sessionID: "s", role: "assistant" }, parts: [{ type: "text", text: "hello" }] },
      { info: { id: "msg_2", sessionID: "s", role: "assistant" }, parts: [] },
      { info: { id: "msg_3", sessionID: "s", role: "assistant" } },
    ]

    await transform({}, { messages })
    expect(messages[0].parts[0]).toBeDefined()
  })
})

describe("proactive expansion (Headroom context_tracker parity)", () => {
  function makeListBackend(entries: Map<string, any>): CcrStorageBackend {
    return {
      async read(key) {
        return entries.get(key.join("/")) ?? null
      },
      async write(key, content) {
        entries.set(key.join("/"), content)
      },
      async list(prefix) {
        return [...entries.entries()].filter(([k]) => k.startsWith(prefix.join("/"))).map(([, v]) => v)
      },
    }
  }

  test("expandableHashes returns hashes of query-matching stored outputs", async () => {
    const entries = new Map<string, any>()
    const backend: CcrStorageBackend = {
      async read(key) {
        return entries.get(key.join("/")) ?? null
      },
      async write(key, content) {
        entries.set(key.join("/"), content)
      },
      async list(prefix) {
        return [...entries.entries()].filter(([k]) => k.startsWith(prefix.join("/"))).map(([, v]) => v)
      },
    }
    const store = new CcrStore(backend, config)
    await store.replace({ sessionID: "s", messageID: "m", tool: "bash", output: bigOutput() })
    const { contentHash } = await import("../../src/plugin/ccr/lib/store")
    const hash = contentHash(bigOutput())

    const hit = await store.expandableHashes("s", "please analyze: " + bigOutput().slice(0, 60))
    expect(hit.has(hash)).toBe(true)

    const miss = await store.expandableHashes("s", "completely unrelated query about cooking recipes")
    expect(miss.has(hash)).toBe(false)
  })

  test("transform keeps query-matching outputs uncompressed this turn", async () => {
    const entries = new Map<string, any>()
    const backend: CcrStorageBackend = {
      async read(key) {
        return entries.get(key.join("/")) ?? null
      },
      async write(key, content) {
        entries.set(key.join("/"), content)
      },
      async list(prefix) {
        return [...entries.entries()].filter(([k]) => k.startsWith(prefix.join("/"))).map(([, v]) => v)
      },
    }
    const store = new CcrStore(backend, config)
    // 预先存储（模拟上一轮已压缩）
    await store.replace({ sessionID: "ses_test", messageID: "old", tool: "bash", output: bigOutput() })

    const transform = createMessageTransform(store, config)
    const messages = buildMessages(8, bigOutput())
    // 最后一条 user 消息的 query 与 bigOutput 内容相关
    messages[messages.length - 2] = {
      info: { id: "msg_uq", sessionID: "ses_test", role: "user" },
      parts: [{ type: "text", text: "please analyze: " + bigOutput().slice(0, 60) }],
    } as any
    await transform({}, { messages })

    // 该输出因 proactive expansion 保持原文
    expect(messages[0].parts[0].state!.output).not.toContain("[ccr:")
    expect(messages[0].parts[0].state!.output).toBe(bigOutput())
  })

  test("default protectRecent is 4 (Headroom parity)", () => {
    const { loadCcrConfig } = require("../../src/plugin/ccr/lib/config")
    delete process.env.OPENCODE_CCR_PROTECT_RECENT
    expect(loadCcrConfig().protectRecent).toBe(4)
  })
})
