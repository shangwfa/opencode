/** V2 shell → 会话文件接口一致性；BASE 指向独立测试容器，不调用模型。 */
import assert from "node:assert/strict"

const base = process.env.SHELL_TEST_BASE ?? "http://localhost:14097"
const password = process.env.OPENCODE_PASSWORD ?? "ab123456"
const headers = {
  authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
  "content-type": "application/json",
}

async function request(path, body) {
  const response = await fetch(`${base}${path}`, {
    headers,
    ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120_000),
  })
  assert(response.ok, `${path}: HTTP ${response.status}`)
  assert(!response.headers.get("content-type")?.includes("text/html"), `${path}: 意外返回 HTML`)
  return response
}

try {
  const created = await (await request("/api/session", {
    title: "shell 沙箱文件一致性验收",
    location: { directory: "/workspace" },
  })).json()
  const id = created.data.id
  const marker = `shell-probe-${crypto.randomUUID()}`
  const file = `.shell-probe-${crypto.randomUUID()}`
  console.log(`创建测试会话：${id}`)
  const controller = new AbortController()
  const stream = await fetch(`${base}/api/session/${id}/event`, { headers, signal: controller.signal })
  assert(stream.ok, `SSE: HTTP ${stream.status}`)
  const watch = (async () => {
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of frame.split("\n")) {
            if (!line.startsWith("data:")) continue
            try {
              const event = JSON.parse(line.slice(5))
              console.log(`实时事件：${event.type ?? "未知"}`)
            } catch { /* 非 JSON 心跳 */ }
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error
    }
  })()
  try {
    await request(`/api/session/${id}/shell`, {
      command: `printf '%s' '${marker}' > /workspace/${file}`,
      timeoutSeconds: 30,
    })
    let actual = ""
    for (let attempt = 0; attempt < 30; attempt++) {
      const response = await fetch(`${base}/api/session/${id}/fs/read/${file}`, { headers })
      if (response.ok && !response.headers.get("content-type")?.includes("text/html")) {
        actual = await response.text()
        if (actual === marker) break
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    assert.equal(actual, marker, "shell 写入的文件必须能通过同会话文件接口读取")
    console.log("通过：shell 与文件接口访问同一会话沙箱")
  } finally {
    controller.abort()
    await watch
  }
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
