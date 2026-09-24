// CCR 性能基准：bun run test/ccr-bench.ts
// 覆盖：各策略 compressOutput、estimateTokens/contentHash、图片历史缩放、
// KV 读写（内存 sqlite）、以及一轮 transform（首跑压缩 + 二跑复用）的模拟。

import { performance } from "node:perf_hooks"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { KV } from "../src/kv.js"
import { compressOutput, contentHash, estimateTokens } from "../src/plugin/ccr.js"
import { resizeHistoryImage } from "../src/plugin/ccr-image.js"
import photonWasm from "#photon-wasm"

;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
  path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))

const MB = 1024 * 1024

function timing<T>(name: string, fn: () => T, bytes?: number, iterations?: number) {
  fn() // warmup
  const runs = iterations ?? 20
  const started = performance.now()
  for (let i = 0; i < runs; i++) fn()
  const elapsed = performance.now() - started
  const perOp = elapsed / runs
  const line = [
    name.padEnd(34),
    `${perOp.toFixed(2).padStart(8)} ms/op`,
    `${(1000 / perOp).toFixed(0).padStart(7)} ops/s`,
  ]
  if (bytes !== undefined) line.push(`${((bytes * runs) / MB / (elapsed / 1000)).toFixed(1).padStart(7)} MB/s`)
  console.log(line.join(" | "))
  return perOp
}

function reportCompression(name: string, payload: string, query = "") {
  const result = compressOutput(payload, query)
  const ratio = result ? (result.preview.length / payload.length * 100).toFixed(1) : "passthrough"
  console.log(
    `${name.padEnd(26)} | ${(payload.length / 1024).toFixed(0).padStart(6)} KB | strategy=${(result?.strategy ?? "-").padEnd(8)} | ratio=${ratio}% | tokens ${estimateTokens(payload)}→${result ? estimateTokens(result.preview) : "-"}`,
  )
  return { payload, result }
}

// ── 载荷构造 ────────────────────────────────────────────────────────────────
const jsonHetero = (n: number) =>
  JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      id: i,
      name: `service-${i}`,
      replicas: i % 7,
      ...(i % 2 ? { kind: "odd" } : {}),
      ...(i % 97 === 0 ? { error: `deployment ${i} failed` } : {}),
    })),
  )
const jsonTable = (n: number) =>
  JSON.stringify(Array.from({ length: n }, (_, i) => ({ id: i, name: `item-${i}`, status: i % 3 ? "ok" : "warn" })))
const logText = (n: number) =>
  [
    ...Array.from({ length: n }, (_, i) => {
      if (i % 150 === 0) return `ERROR request ${i} failed after 3 retries`
      if (i % 300 === 0) return `WARN disk usage high on shard-${i}`
      if (i % 500 === 0)
        return ["Traceback (most recent call last):", '  File "app.py", line 12, in run', "    run_task()", "RuntimeError: operation failed"].join("\n")
      return `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z INFO routine event ${i} completed`
    }),
    `${n} requests processed`,
  ].join("\n").repeat(1)
const diffText = (files: number, hunks: number) =>
  Array.from({ length: files }, (_, f) =>
    [
      `diff --git a/file${f}.ts b/file${f}.ts`,
      "index 123..456 100644",
      `--- a/file${f}.ts`,
      `+++ b/file${f}.ts`,
      ...Array.from({ length: hunks }, (_, h) => [
        `@@ -${h * 40 + 1},40 +${h * 40 + 1},40 @@`,
        ...Array.from({ length: 28 }, (_, i) => ` context ${f}-${h}-${i}`),
        `-removed line ${f}-${h}`,
        `+added line ${f}-${h}`,
      ]).flat(),
    ].join("\n"),
  ).join("\n")
const searchText = (n: number) =>
  Array.from({ length: n }, (_, i) => `src/mod${i % 25}/file${i}.ts:${i + 1}:${i % 40 === 0 ? "ERROR needle found" : "routine result"} ${i}`).join("\n")
const configText = (n: number) =>
  Array.from({ length: n }, (_, i) => `# comment for key ${i}\nkey${i}: value${i}`).join("\n")
const codeText = (n: number) =>
  [
    ...Array.from({ length: 5 }, (_, i) => `import module_${i}`),
    ...Array.from({ length: n }, (_, i) => [`def handler_${i}(event):`, '    """Process one event."""', ...Array.from({ length: 12 }, (_, j) => `    result_${j} = transform(event, ${j})`), "    return result_0"].join("\n")),
  ].join("\n")
const plainText = (n: number) => Array.from({ length: n }, (_, i) => `the quick brown fox jumps over the lazy dog number ${i}`).join("\n")
const htmlText = (blocks: number) =>
  ["<html>", "<head><title>report</title></head>", "<body>", ...Array.from({ length: blocks }, (_, i) => `<div class="row"><span>cell ${i}</span><span>value ${i}</span></div>`), "</body></html>"].join("\n")
// 真实抓取场景：单行 minified HTML（V1 的 html 策略按此设计；pretty 版本会因
// 剥离标签后行数膨胀触发同款回退 gate，落到 lines 策略 —— 与 V1 一致）。
const htmlSingleLine = (blocks: number) =>
  `<html><head><title>quarterly report</title></head><body>${Array.from({ length: blocks }, (_, i) => `<div class="row"><span>cell ${i}</span><span>value ${i}</span></div>`).join("")}</body></html>`

// ── 1. 压缩质量（策略命中与压缩比） ────────────────────────────────────────
console.log("\n== 压缩质量（payload | strategy | 预览/原文 比例 | tokens） ==")
const quality = [
  reportCompression("json-hetero(5000)", jsonHetero(5000), "service 4711"),
  reportCompression("json-table(5000)", jsonTable(5000)),
  reportCompression("log(3000)", logText(3000), "failed"),
  reportCompression("diff(20files×10hunks)", diffText(20, 10)),
  reportCompression("search(500)", searchText(500), "needle"),
  reportCompression("config(500)", configText(500)),
  reportCompression("code(40 py funcs)", codeText(40)),
  reportCompression("plain(3000)", plainText(3000)),
  reportCompression("html(500 rows pretty)", htmlText(500)),
  reportCompression("html(500 rows 1-line)", htmlSingleLine(500)),
]

// ── 2. 压缩吞吐 ─────────────────────────────────────────────────────────────
console.log("\n== 压缩吞吐（ms/op | ops/s | 输入 MB/s） ==")
for (const [name, payload, query, iters] of [
  ["json-hetero ~600KB", jsonHetero(5000), "service 4711", 10] as const,
  ["json-table ~350KB", jsonTable(5000), "", 10] as const,
  ["log ~250KB", logText(3000), "failed", 10] as const,
  ["diff ~500KB", diffText(20, 10), "", 10] as const,
  ["search ~40KB", searchText(500), "needle", 50] as const,
  ["config ~20KB", configText(500), "", 50] as const,
  ["code ~60KB", codeText(40), "", 50] as const,
  ["plain ~150KB", plainText(3000), "", 20] as const,
  ["html ~50KB single-line", htmlSingleLine(500), "", 50] as const,
]) {
  timing(name, () => compressOutput(payload, query), payload.length, iters)
}

// ── 3. 原语 ─────────────────────────────────────────────────────────────────
console.log("\n== 原语（1MB 文本） ==")
const bigText = plainText(20000)
timing("estimateTokens(1MB)", () => estimateTokens(bigText), bigText.length, 10)
timing("contentHash(1MB)", () => contentHash(bigText), bigText.length, 10)

// ── 4. 图片历史缩放 ─────────────────────────────────────────────────────────
console.log("\n== 图片缩放（冷路径 = 解码+缩放+编码） ==")
const makePng = async (width: number, height: number, seed: number) => {
  const photon = await import("@silvia-odwyer/photon-node")
  const rgba = new Uint8Array(width * height * 4)
  for (let i = 0; i < rgba.length; i += 4) {
    rgba[i] = (i + seed) & 0xff
    rgba[i + 1] = (i >> 3) & 0xff
    rgba[i + 2] = (i >> 5) & 0xff
    rgba[i + 3] = 0xff
  }
  const image = new photon.PhotonImage(rgba, width, height)
  const bytes = Buffer.from(image.get_bytes())
  image.free()
  return bytes
}
const benchImage = async (name: string, width: number, height: number, iterations = 3) => {
  // 计时必须逐次 await：resizeHistoryImage 是 async，同步循环只测到 Promise 创建。
  // 每张图只用一次（不同 seed → 不同 hash），确保冷路径不命中内容缓存。
  const originals = await Promise.all(Array.from({ length: iterations }, (_, i) => makePng(width, height, i * 7 + i * 13)))
  const started = performance.now()
  for (const original of originals) await resizeHistoryImage("image/png", original)
  const perOp = (performance.now() - started) / iterations
  console.log(`${name.padEnd(34)} | ${perOp.toFixed(1).padStart(8)} ms/op | ${(1000 / perOp).toFixed(1).padStart(7)} ops/s`)
  return perOp
}
await benchImage("1024×1024 png", 1024, 1024, 5)
await benchImage("2048×1536 png", 2048, 1536, 3)
await benchImage("4096×3072 png", 4096, 3072, 2)
{
  const original = await makePng(1024, 1024, 99)
  await resizeHistoryImage("image/png", original)
  const started = performance.now()
  for (let i = 0; i < 200; i++) await resizeHistoryImage("image/png", original)
  console.log(`${"1024×1024 缓存命中".padEnd(34)} | ${((performance.now() - started) / 200).toFixed(4).padStart(8)} ms/op | ${(200000 / (performance.now() - started)).toFixed(0).padStart(7)} ops/s`)
}

// ── 5. KV（内存 sqlite；生产为 PG 桥接，含网络开销） ────────────────────────
console.log("\n== KV（sqlite :memory:）与整轮 transform 模拟 ==")
const kvProgram = Effect.gen(function* () {
  const kv = yield* KV.Service
  const key = "plugin/ccr/bench/hash"
  const value = { original: "x".repeat(4096), replacement: "[ccr:abc]", retrievalCount: 0 }

  const time = <A>(name: string, fn: () => Effect.Effect<A>, runs: number) =>
    Effect.gen(function* () {
      yield* fn()
      const started = performance.now()
      for (let i = 0; i < runs; i++) yield* fn()
      const perOp = (performance.now() - started) / runs
      console.log(`${name.padEnd(34)} | ${perOp.toFixed(3).padStart(8)} ms/op | ${(1000 / perOp).toFixed(0).padStart(7)} ops/s`)
    })

  yield* time("kv.get(miss)", () => kv.get(`plugin/ccr/bench/none-${Math.random()}`), 200)
  yield* kv.set(key, value)
  yield* time("kv.get(hit)", () => kv.get(key), 500)
  yield* time("kv.set(upsert)", () => kv.set(key, value), 200)
  yield* time("kv.setIfAbsent(existing)", () => kv.setIfAbsent(key, value), 200)
  yield* kv.remove(key)
  yield* time("kv.setIfAbsent(fresh)", () => kv.setIfAbsent(`plugin/ccr/bench/fresh-${Math.random()}`, value), 200)

  // 一轮 transform 模拟：25 条历史 tool 输出（各 ~60KB json）
  const outputs = Array.from({ length: 25 }, (_, i) => jsonHetero(500 + i * 10))
  const keys = outputs.map((_, i) => `plugin/ccr/bench/turn/${i}`)
  yield* Effect.gen(function* () {
    const started = performance.now()
    for (let i = 0; i < outputs.length; i++) {
      const compressed = compressOutput(outputs[i]!, "service 4000")
      yield* kv.setIfAbsent(keys[i]!, { ...value, ...(compressed ? { replacement: compressed.replacement } : {}) })
      yield* kv.get(keys[i]!)
    }
    const first = performance.now() - started
    const reuseStart = performance.now()
    for (let i = 0; i < outputs.length; i++) yield* kv.get(keys[i]!)
    const second = performance.now() - reuseStart
    const totalKb = outputs.reduce((n, o) => n + o.length, 0) / 1024
    console.log(
      `transform 首轮(压缩+写+读回)        | ${first.toFixed(1).padStart(8)} ms   | ${outputs.length} 条 / ${totalKb.toFixed(0)}KB 历史 tool 输出`,
    )
    console.log(`transform 复用轮(仅读)             | ${second.toFixed(1).padStart(8)} ms`)
  })
})

await Effect.runPromise(
  kvProgram.pipe(
    Effect.provide(LayerNode.compile(KV.node) as never) as never,
  ) as never,
)
