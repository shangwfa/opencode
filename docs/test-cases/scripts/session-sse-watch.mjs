// 订阅 V2 会话 SSE 事件流（GET /api/session/:sessionID/event），按 TUI 风格实时打印执行过程。
// 用法：bun session-sse-watch.mjs <base> <password> <sessionID> [durationSec]
// 行格式：[+mm:ss] 类型 前缀 内容 —— 思考(think)/工具(tool)/表单(form)/文本(text)/执行(exec)。
const [base, password, sid, durationSec = "90"] = process.argv.slice(2)
if (!base || !password || !sid) {
  console.error("usage: bun session-sse-watch.mjs <base> <password> <sessionID> [durationSec]")
  process.exit(1)
}
const auth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), Number(durationSec) * 1000)
const t0 = Date.now()
const stamp = () => {
  const s = Math.floor((Date.now() - t0) / 1000)
  return `[+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`
}
const brief = (text, n = 120) => String(text ?? "").replace(/\s+/g, " ").slice(0, n)
try {
  const response = await fetch(`${base}/api/session/${sid}/event`, {
    headers: { authorization: auth, accept: "text/event-stream" },
    signal: controller.signal,
  })
  if (response.status !== 200) {
    console.log(`${stamp()} exec ✗ SSE ${response.status}: ${(await response.text()).slice(0, 200)}`)
    process.exit(0)
  }
  console.log(`${stamp()} exec · 已连接会话 ${sid}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let index
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line.startsWith("data:")) continue
      let event
      try {
        event = JSON.parse(line.slice(5).trim())
      } catch {
        continue
      }
      const d = event.data ?? {}
      switch (event.type) {
        case "session.execution.started":
          console.log(`${stamp()} exec ▶ 执行开始`)
          break
        case "session.reasoning.ended":
          console.log(`${stamp()} think · ${brief(d.text, 150)}`)
          break
        case "session.tool.input.started":
          console.log(`${stamp()} tool ◇ ${d.name}`)
          break
        case "session.tool.success":
          console.log(`${stamp()} tool ✓ ${d.content?.filter?.((c) => c.type === "text").map((c) => c.text).join(" ").replace(/\s+/g, " ").slice(0, 150) ?? ""}`)
          break
        case "session.tool.failed":
          console.log(`${stamp()} tool ✗ ${brief(d.error?.message ?? d.error ?? "", 150)}`)
          break
        case "session.text.ended":
          console.log(`${stamp()} text · ${brief(d.text, 170)}`)
          break
        case "form.created":
          console.log(`${stamp()} form ◇ 表单创建 ${d.id ?? ""}`)
          break
        case "form.replied":
          console.log(`${stamp()} form ✓ 已代答 ${d.id ?? ""}`)
          break
        case "form.cancelled":
          console.log(`${stamp()} form ✗ 被取消 ${d.id ?? ""}`)
          break
        case "session.usage.updated":
          break
        case "session.execution.succeeded":
          console.log(`${stamp()} exec ✔ 执行成功`)
          break
        case "session.execution.failed":
          console.log(`${stamp()} exec ✗ 执行失败 ${brief(d.error?.message ?? "", 140)}`)
          break
        case "session.execution.interrupted":
          console.log(`${stamp()} exec ⏸ 执行被中断 (${d.reason ?? "?"})`)
          break
        default:
          break
      }
    }
  }
} catch (error) {
  if (String(error).includes("abort")) console.log(`${stamp()} exec · 观察窗口结束`)
  else console.log(`${stamp()} exec ✗ ${String(error).slice(0, 200)}`)
} finally {
  clearTimeout(timer)
}
