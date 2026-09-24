// CCR 插件级 L0 用例（对齐 docs/test-cases/context/session-ccr.md 的
// T-CCR.15~18/23 及 store/retrieve/transform 维度）：使用内存 mock KV，
// 不依赖模型、容器与沙箱。
import { beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Message } from "@opencode/ai"
import { KV } from "@opencode/core/kv"
import { compressOutput, contentHash, loadCcrConfig, Plugin as CcrPlugin, retrieveEntry, transformMessages } from "@opencode/core/plugin/ccr"
import { testEffect } from "./lib/effect"

// ── 内存 KV：可注入写失败 ──────────────────────────────────────────────────
interface Memory {
  readonly entries: Map<string, KV.Value>
  writes: number
  failWrites: boolean
}

const memory: Memory = { entries: new Map(), writes: 0, failWrites: false }

const layer = Layer.succeed(
  KV.Service,
  KV.Service.of({
    get: (key) => Effect.sync(() => memory.entries.get(key)),
    set: (key, value) =>
      Effect.suspend(() => {
        if (memory.failWrites) return Effect.die(new Error("kv write failed"))
        memory.entries.set(key, value)
        memory.writes++
        return Effect.void
      }),
    setIfAbsent: (key, value) =>
      Effect.suspend(() => {
        if (memory.failWrites) return Effect.die(new Error("kv write failed"))
        if (memory.entries.has(key)) return Effect.succeed(false)
        memory.entries.set(key, value)
        memory.writes++
        return Effect.succeed(true)
      }),
    remove: (key) => Effect.sync(() => void memory.entries.delete(key)),
    scan: () => Effect.succeed({ entries: [] }),
  }),
)

const it = testEffect(layer)

// ── 载荷与消息构造 ─────────────────────────────────────────────────────────
// 低阈值配置：让小载荷也能触发压缩（V1 transform 套件同款做法）。
const config = { minTokens: 50, previewTokens: 300, protectRecent: 2, ttl: 0, images: false }

const bigOutput = (lines = 120) =>
  Array.from({ length: lines }, (_, i) => `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z plain output line ${i} with filler text`).join("\n")

const toolMessage = (output: string, tool = "read") =>
  Message.tool({ id: `msg_${Math.random().toString(36).slice(2)}`, name: tool, result: output, resultType: "text" })

const resultValue = (view: ReturnType<typeof Message.tool>, index = 0): string => {
  const part = view.content[index] as unknown as { result: { value: unknown } }
  return part.result.value as string
}

const sessionA = "ses_a"
const sessionB = "ses_b"

describe("CCR transformMessages", () => {
  beforeEach(() => {
    memory.entries.clear()
    memory.writes = 0
    memory.failWrites = false
  })

  it.effect("compresses eligible tool outputs and stores entries with metadata", () =>
    Effect.gen(function* () {
      const output = bigOutput()
      const messages = [toolMessage(output), toolMessage(output), Message.user("continue"), Message.user("latest")]
      const view = yield* transformMessages(yield* KV.Service, messages, sessionA, config)
      expect(resultValue(view[0]!)).toContain("[ccr:")
      // 保护窗外的两条都替换，窗内两条保持原文。
      expect(resultValue(view[1]!)).toContain("[ccr:")
      const key = `plugin/ccr/${sessionA}/${contentHash(output)}`
      const entry = memory.entries.get(key) as Record<string, unknown> | undefined
      expect(entry).toBeDefined()
      expect(entry!.tool).toBe("read")
      expect(entry!.original).toBe(output)
      expect(entry!.originalTokens).toBeGreaterThan(0)
      expect(entry!.retrievalCount).toBe(0)
    }),
  )

  it.effect("leaves the protection window untouched", () =>
    Effect.gen(function* () {
      const output = bigOutput()
      // [tool(旧), user, tool(窗内), user] —— protectRecent=2 保护最后两条。
      const messages = [toolMessage(output), Message.user("a"), toolMessage(output), Message.user("b")]
      const view = yield* transformMessages(yield* KV.Service, messages, sessionA, config)
      expect(resultValue(view[0]!)).toContain("[ccr:")
      expect(resultValue(view[2]!)).toBe(output)
    }),
  )

  it.effect("skips excluded tools and below-threshold outputs", () =>
    Effect.gen(function* () {
      const messages = [
        toolMessage(bigOutput(), "edit"),
        toolMessage("tiny"),
        toolMessage(bigOutput(), "read"),
        Message.user("go"),
        Message.user("again"),
      ]
      const view = yield* transformMessages(yield* KV.Service, messages, sessionA, config)
      expect(resultValue(view[0]!)).not.toContain("[ccr:")
      expect(resultValue(view[1]!)).toBe("tiny")
      expect(resultValue(view[2]!)).toContain("[ccr:")
    }),
  )

  it.effect("never recompresses output already carrying a marker", () =>
    Effect.gen(function* () {
      const marked = compressOutput(bigOutput(), "", config)!.replacement
      const messages = [toolMessage(marked), Message.user("a"), Message.user("b")]
      const view = yield* transformMessages(yield* KV.Service, messages, sessionA, config)
      expect(resultValue(view[0]!)).toBe(marked)
      expect(memory.entries.size).toBe(0)
    }),
  )

  it.effect("reuses the persisted replacement across turns with a different query (T-CCR.17/18)", () =>
    Effect.gen(function* () {
      const output = bigOutput()
      const first = yield* transformMessages(
        yield* KV.Service,
        [toolMessage(output), Message.user("alpha topic"), Message.user("latest")],
        sessionA,
        config,
      )
      const firstBytes = resultValue(first[0]!)
      const second = yield* transformMessages(
        yield* KV.Service,
        [toolMessage(output), Message.user("beta topic"), Message.user("latest")],
        sessionA,
        config,
      )
      expect(resultValue(second[0]!)).toBe(firstBytes)
      // 同一 hash 只有一条 entry，不按 query 改写历史。
      expect([...memory.entries.keys()].filter((key) => key.startsWith(`plugin/ccr/${sessionA}/`))).toHaveLength(1)
    }),
  )

  it.effect("passes through when KV writes die, then retries successfully (T-CCR.16)", () =>
    Effect.gen(function* () {
      memory.failWrites = true
      const failing = [toolMessage(bigOutput()), Message.user("a"), Message.user("b")]
      const untouched = yield* transformMessages(yield* KV.Service, failing, sessionA, config)
      expect(resultValue(untouched[0]!)).toBe(bigOutput())

      memory.failWrites = false
      const retry = [toolMessage(bigOutput()), Message.user("a"), Message.user("b")]
      const view = yield* transformMessages(yield* KV.Service, retry, sessionA, config)
      expect(resultValue(view[0]!)).toContain("[ccr:")
      expect(memory.writes).toBeGreaterThan(0)
    }),
  )

  it.effect("persists identical content separately per session (T-CCR.15)", () =>
    Effect.gen(function* () {
      const output = bigOutput()
      for (const sessionID of [sessionA, sessionB]) {
        const view = yield* transformMessages(
          yield* KV.Service,
          [toolMessage(output), Message.user("a"), Message.user("b")],
          sessionID,
          config,
        )
        expect(resultValue(view[0]!)).toContain("[ccr:")
      }
      const hash = contentHash(output)
      expect(memory.entries.has(`plugin/ccr/${sessionA}/${hash}`)).toBe(true)
      expect(memory.entries.has(`plugin/ccr/${sessionB}/${hash}`)).toBe(true)
      for (const sessionID of [sessionA, sessionB]) {
        const outcome = yield* retrieveEntry(yield* KV.Service, hash, sessionID, () => Effect.succeed(undefined))
        expect(outcome.status).toBe("available")
      }
    }),
  )
})

describe("CCR retrieveEntry", () => {
  beforeEach(() => {
    memory.entries.clear()
    memory.failWrites = false
  })

  it.effect("returns not_found for unknown hashes", () =>
    Effect.gen(function* () {
      const outcome = yield* retrieveEntry(yield* KV.Service, "deadbeef", sessionA, () => Effect.succeed(undefined))
      expect(outcome.status).toBe("not_found")
    }),
  )

  it.effect("returns expired for entries past their TTL and does not count them", () =>
    Effect.gen(function* () {
      memory.entries.set(`plugin/ccr/${sessionA}/abc`, {
        original: "payload",
        expiresAt: new Date(Date.now() - 1000).toISOString(),
        retrievalCount: 0,
      })
      const outcome = yield* retrieveEntry(yield* KV.Service, "abc", sessionA, () => Effect.succeed(undefined))
      expect(outcome.status).toBe("expired")
      const stored = memory.entries.get(`plugin/ccr/${sessionA}/abc`) as { retrievalCount: number }
      expect(stored.retrievalCount).toBe(0)
    }),
  )

  it.effect("retrieves from the parent session and counts the retrieval there", () =>
    Effect.gen(function* () {
      memory.entries.set("plugin/ccr/ses_parent/h1", { original: "parent payload", retrievalCount: 3 })
      const parents = new Map([[sessionA, "ses_parent"]])
      const outcome = yield* retrieveEntry(yield* KV.Service, "h1", sessionA, (sid) => Effect.succeed(parents.get(sid)))
      expect(outcome).toMatchObject({ status: "available", original: "parent payload", countedOn: "ses_parent" })
      const stored = memory.entries.get("plugin/ccr/ses_parent/h1") as { retrievalCount: number }
      expect(stored.retrievalCount).toBe(4)
    }),
  )

  it.effect("stops after maxDepth ancestors", () =>
    Effect.gen(function* () {
      let depth = 0
      const outcome = yield* retrieveEntry(
        yield* KV.Service,
        "none",
        sessionA,
        (sid) => Effect.suspend(() => Effect.succeed(`${sid}_child${depth++}`)),
        2,
      )
      expect(outcome.status).toBe("not_found")
      expect(depth).toBeLessThanOrEqual(3)
    }),
  )
})

describe("CCR loadCcrConfig", () => {
  test("maps env values onto the config with V1 defaults (T-CCR.23)", () => {
    const previous = process.env.OPENCODE_CCR_TTL_SEC
    process.env.OPENCODE_CCR_TTL_SEC = "0"
    expect(loadCcrConfig().ttl).toBe(0)
    process.env.OPENCODE_CCR_TTL_SEC = "90"
    expect(loadCcrConfig().ttl).toBe(90)
    process.env.OPENCODE_CCR_TTL_SEC = "garbage"
    expect(loadCcrConfig().ttl).toBe(1800)
    if (previous === undefined) delete process.env.OPENCODE_CCR_TTL_SEC
    else process.env.OPENCODE_CCR_TTL_SEC = previous
  })
})

// ── 插件绑定层冒烟：Plugin.effect 必须注册 context/compaction hook 与
// ccr_retrieve 工具，且 hook 能端到端完成一轮转换。需要
// OPENCODE_CCR_ENABLED=true（模块加载时读取），无 env 时跳过。
describe("CCR Plugin binding", () => {
  const enabled = process.env.OPENCODE_CCR_ENABLED === "true"
  const it = testEffect(layer)
  const maybe = enabled ? it.effect : it.effect.skip

  maybe("registers both hooks, the retrieve tool, and runs an end-to-end turn", () =>
    Effect.gen(function* () {
      const hooks = new Map<string, Array<(event: never) => Effect.Effect<void>>>()
      const tools = new Map<string, { execute: (input: { hash: string }, context: { sessionID: string }) => Effect.Effect<unknown> }>()
      const ctx = {
        session: {
          hook: (name: string, handler: (event: never) => Effect.Effect<void>) =>
            Effect.sync(() => {
              const list = hooks.get(name) ?? []
              list.push(handler)
              hooks.set(name, list)
            }),
        },
        tool: {
          transform: (callback: (editor: { add: (tool: unknown) => void }) => void) =>
            Effect.sync(() => {
              callback({
                add: (tool) => {
                  const definition = tool as { name: string; execute: (input: { hash: string }, context: { sessionID: string }) => Effect.Effect<unknown> }
                  tools.set(definition.name, definition)
                },
              })
            }),
        },
      } as never
      yield* CcrPlugin.effect(ctx as Parameters<typeof CcrPlugin.effect>[0])

      expect([...hooks.keys()].sort()).toEqual(["compaction", "context"])
      expect(tools.has("ccr_retrieve")).toBe(true)

      // 端到端：hook 收到消息视图 → 写 entry → 工具取回原文。
      // 默认配置 protectRecent=4，需 >4 条消息让首条 tool 进入压缩窗口。
      const output = bigOutput()
      const event = {
        sessionID: sessionA,
        messages: [
          Message.tool({ id: "m1", name: "read", result: output, resultType: "text" }),
          Message.user("first"),
          Message.user("second"),
          Message.user("third"),
          Message.user("fourth"),
        ],
      } as never
      yield* hooks.get("context")![0]!(event)
      const view = (event as { messages: Array<{ content: Array<{ result: { value: unknown } }> }> }).messages
      expect(view[0]!.content[0]!.result.value).toContain("[ccr:")
      const hash = contentHash(output)
      const outcome = yield* retrieveEntry(yield* KV.Service, hash, sessionA, () => Effect.succeed(undefined))
      expect(outcome).toMatchObject({ status: "available", original: output })
    }),
  )
})
