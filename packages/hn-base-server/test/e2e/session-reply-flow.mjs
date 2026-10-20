import assert from "node:assert/strict"

const base = process.env.BASE ?? "http://localhost:3201"
const id = process.env.E2E_SESSION_ID
assert(id && process.env.E2E_TOKEN, "需要 E2E_SESSION_ID 和 E2E_TOKEN")
const headers = { authorization: `Bearer ${process.env.E2E_TOKEN}`, origin: "http://localhost:3002", "content-type": "application/json" }
const abort = new AbortController()
const timeout = setTimeout(() => abort.abort(), 120_000)
try {
  const response = await fetch(`${base}/api/sessions/${id}/event`, { headers, signal: abort.signal })
  assert.equal(response.status, 200)
  assert(response.headers.get("content-type")?.includes("text/event-stream"))
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = "", sent = false, finished = false, success = false
  while (!finished) {
    const chunk = await reader.read()
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })
    let boundary
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue
        let event
        try { event = JSON.parse(line.slice(5)) } catch { continue }
        if (!event.type.endsWith(".delta")) console.log("实时事件：", event.type)
        if (event.type === "server.connected" && !sent) {
          sent = true
          const prompt = await fetch(`${base}/api/sessions/${id}/message`, { method: "POST", headers, body: JSON.stringify({
            model: { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-pro" },
            parts: [{ type: "text", text: "验证回复显示：请只回复「收到」，不要调用任何工具。" }],
          }) })
          assert.equal(prompt.status, 200)
        }
        if (event.type === "session.text.ended") console.log("回复：", event.data?.text)
        if (event.type === "session.execution.failed") console.log("失败原因：", event.data?.error?.message)
        if (/^session\.execution\.(succeeded|failed|interrupted)$/.test(event.type)) {
          finished = true
          success = event.type === "session.execution.succeeded"
        }
      }
    }
  }
  assert(sent && finished && success, "必须订阅到本轮执行成功事件")
  const messages = await (await fetch(`${base}/api/sessions/${id}/messages`, { headers })).json()
  const latest = [...messages.data].reverse().find((message) => message.type === "assistant")
  assert(latest?.content?.some((item) => item.type === "text" && item.text.includes("收到")))
  console.log("✓ 网关实时回复和历史读取均成功")
} catch (error) {
  console.error(error)
  process.exitCode = 1
} finally {
  clearTimeout(timeout)
  abort.abort()
}
