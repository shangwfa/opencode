#!/usr/bin/env bun
// SSE 事件采集器 — 07-provider-sse.md 通用脚手架
//
// 用法：
//   bun docs/test-cases/scripts/sse-dump.mjs <url> <seconds> [directory]
//     url       SSE 端点（如 http://localhost:14096/global/event 或 /event）
//     seconds   采集时长，超时自动退出
//     directory 实例级 /event 需要提供 x-opencode-directory 头
//
// 输出：每行一个 JSON 事件（已拍平 payload 层，全局/实例格式统一）。
//
// 典型模式（订阅 → 动作 → 断言）：
//   bun docs/test-cases/scripts/sse-dump.mjs "$BASE/global/event" 15 > /tmp/sse.log &
//   SSE_PID=$!
//   # 等待 server.connected 出现，确保订阅已建立
//   for i in $(seq 1 20); do grep -q server.connected /tmp/sse.log && break; sleep 0.5; done
//   # ... 执行动作（创建 session / 发消息等）...
//   wait $SSE_PID
//   grep -c "session.created" /tmp/sse.log

const [url, secondsArg, directory] = process.argv.slice(2)
const seconds = Number(secondsArg || 10)

if (!url || !seconds) {
  console.error("usage: sse-dump.mjs <url> <seconds> [directory]")
  process.exit(2)
}

const ctrl = new AbortController()
const timer = setTimeout(() => ctrl.abort(), seconds * 1000)

const headers = directory ? { "x-opencode-directory": directory } : {}

try {
  const r = await fetch(url, { signal: ctrl.signal, headers, proxy: "" })
  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const blocks = buf.split("\n\n")
    buf = blocks.pop() ?? ""
    for (const block of blocks) {
      const line = block.split("\n").find((l) => l.startsWith("data: "))
      if (!line) continue
      try {
        const raw = JSON.parse(line.slice(6))
        console.log(JSON.stringify(raw.payload || raw))
      } catch {}
    }
  }
} catch (e) {
  if (e?.name !== "AbortError") {
    console.error("sse-dump error:", String(e))
    process.exit(1)
  }
} finally {
  clearTimeout(timer)
}
