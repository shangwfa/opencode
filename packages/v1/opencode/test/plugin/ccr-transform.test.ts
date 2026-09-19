import { describe, expect, test } from "bun:test"
import { createMessageTransform } from "../../src/plugin/ccr/lib/transform"
import { CcrStore, type CcrStorageBackend } from "../../src/plugin/ccr/lib/store"
import type { CcrConfig } from "../../src/plugin/ccr/lib/config"

const config: CcrConfig = { minTokens: 200, protectRecent: 2, previewTokens: 300, ttlSeconds: 0, imageResize: true }

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

describe("stable request view", () => {
  test("does not expand history by the current query", async () => {
    const entries = new Map<string, any>()
    const backend: CcrStorageBackend = {
      async read(key) {
        return entries.get(key.join("/")) ?? null
      },
      async write(key, content) {
        entries.set(key.join("/"), content)
      },
    }
    const store = new CcrStore(backend, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(8, bigOutput())
    messages[messages.length - 2] = {
      info: { id: "msg_query", sessionID: "ses_test", role: "user" },
      parts: [{ type: "text", text: "please analyze plain output filler" }],
    } as any

    await transform({}, { messages })

    expect(messages[0].parts[0].state!.output).toContain("[ccr:")
  })

  test("default protectRecent is 4 (Headroom parity)", () => {
    const { loadCcrConfig } = require("../../src/plugin/ccr/lib/config")
    delete process.env.OPENCODE_CCR_PROTECT_RECENT
    expect(loadCcrConfig().protectRecent).toBe(4)
  })
})

describe("transform image resize", () => {
  test("resizes history images, preserves recent ones", async () => {
    const { resizeImageDataUrl } = await import("../../src/plugin/ccr/lib/image-resize")
    const photon = await import("@silvia-odwyer/photon-node")
    const rgba = new Uint8Array(1024 * 1024 * 4)
    const canvas = new photon.PhotonImage(rgba, 1024, 1024)
    const bigUrl = `data:image/png;base64,${Buffer.from(canvas.get_bytes()).toString("base64")}`
    canvas.free()

    const entries = new Map<string, any>()
    const backend: CcrStorageBackend = {
      async read(key: string[]) {
        return entries.get(key.join("/")) ?? null
      },
      async write(key: string[], content: any) {
        entries.set(key.join("/"), content)
      },
    }
    const store = new CcrStore(backend, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(8, "tiny output")
    messages[0].parts[0] = { type: "file", url: bigUrl } as any
    messages[7].parts[0] = { type: "file", url: bigUrl } as any
    await transform({}, { messages })

    // idx0 在窗口内（last=5）→ resize；idx7 在保护窗 → 保持原图
    const url0 = (messages[0].parts[0] as any).url as string
    const url7 = (messages[7].parts[0] as any).url as string
    const [w0] = await pngSize(url0)
    expect(w0).toBe(512)
    const [w7] = await pngSize(url7)
    expect(w7).toBe(1024)
    void resizeImageDataUrl
  })

  test("detail-oriented query preserves history images this turn", async () => {
    const photon = await import("@silvia-odwyer/photon-node")
    const rgba = new Uint8Array(1024 * 1024 * 4)
    const canvas = new photon.PhotonImage(rgba, 1024, 1024)
    const bigUrl = `data:image/png;base64,${Buffer.from(canvas.get_bytes()).toString("base64")}`
    canvas.free()

    const entries = new Map<string, any>()
    const backend: CcrStorageBackend = {
      async read(key: string[]) {
        return entries.get(key.join("/")) ?? null
      },
      async write(key: string[], content: any) {
        entries.set(key.join("/"), content)
      },
    }
    const store = new CcrStore(backend, config)
    const transform = createMessageTransform(store, config)
    const messages = buildMessages(8, "tiny output")
    messages[0].parts[0] = { type: "file", url: bigUrl } as any
    // 细节类 query → 本轮图像跳过 resize
    messages[messages.length - 2] = {
      info: { id: "msg_detail", sessionID: "ses_test", role: "user" },
      parts: [{ type: "text", text: "请数一下这张截图里有几个按钮，仔细看清楚" }],
    } as any
    await transform({}, { messages })

    const url0 = (messages[0].parts[0] as any).url as string
    expect(url0).toBe(bigUrl)
  })

  test("ordinary Chinese technical terms do not preserve history images", async () => {
    const photon = await import("@silvia-odwyer/photon-node")
    const canvas = new photon.PhotonImage(new Uint8Array(1024 * 1024 * 4), 1024, 1024)
    const bigUrl = `data:image/png;base64,${Buffer.from(canvas.get_bytes()).toString("base64")}`
    canvas.free()
    const store = new CcrStore(undefined, config)
    const messages = buildMessages(8, "tiny output")
    messages[0].parts[0] = { type: "file", url: bigUrl } as any
    messages[messages.length - 2] = {
      info: { id: "msg_normal", sessionID: "ses_test", role: "user" },
      parts: [{ type: "text", text: "请分析数据并检查函数参数" }],
    } as any

    await createMessageTransform(store, config)({}, { messages })

    const [width] = await pngSize((messages[0].parts[0] as any).url)
    expect(width).toBe(512)
  })

  async function pngSize(dataUrl: string): Promise<[number, number]> {
    const photon = await import("@silvia-odwyer/photon-node")
    const img = photon.PhotonImage.new_from_byteslice(Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64"))
    try {
      return [img.get_width(), img.get_height()]
    } finally {
      img.free()
    }
  }
})
