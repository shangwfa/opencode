// Run T10.1–T10.4 against the V2 API. SSE events are rendered as they arrive.
import assert from "node:assert/strict"

const BASE = (process.env.BASE ?? "http://127.0.0.1:14105").replace(/\/$/, "")
const STREAM_TIMEOUT_MS = Number(process.env.STREAM_TIMEOUT_MS ?? 180_000)
const MODEL = { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" }
const AUTH = process.env.OPENCODE_PASSWORD
  ? `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`
  : undefined
const headers = { "content-type": "application/json", ...(AUTH ? { authorization: AUTH } : {}) }

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let result
  try {
    result = text ? JSON.parse(text) : undefined
  } catch {
    result = text
  }
  assert(response.ok, `${method} ${path}: HTTP ${response.status}: ${String(text).slice(0, 500)}`)
  return result
}

async function newSession(title) {
  const result = await api("/api/session", "POST", {
    title,
    location: { directory: "/workspace" },
    model: MODEL,
    permissions: ["bash", "edit", "write", "glob", "grep", "list", "read", "webfetch"].map((action) => ({
      action,
      resource: "*",
      effect: "allow",
    })),
  })
  const id = result.data.id
  console.log(`Session: ${id}`)
  return id
}

async function streamPrompt(sid, prompt, label) {
  console.log(`\n--- ${label}: prompt_stream 实时事件 ---`)
  const request = fetch(`${BASE}/api/session/${sid}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({ text: prompt, metadata: {}, delivery: "queue" }),
    signal: AbortSignal.timeout(STREAM_TIMEOUT_MS),
  })
  let result
  const responsePromise = request.then(
    (response) => ({ response }),
    (error) => ({ error }),
  )
  const printed = new Map()
  let nextWaitingNotice = Date.now() + 5_000
  while (!result) {
    result = await Promise.race([responsePromise, new Promise((resolve) => setTimeout(() => resolve(undefined), 1_000))])
    if (result) break
    if (Date.now() >= nextWaitingNotice) {
      console.log(`[等待] ${label}: prompt_stream 尚未返回 SSE 响应头，持续读取 Session 状态…`)
      nextWaitingNotice = Date.now() + 5_000
    }
    // Some deployments delay SSE headers while session execution is starting.
    // Poll durable messages meanwhile so progress/errors still reach the foreground.
    try {
      const snapshot = await api(`/api/session/${sid}/message?order=asc`)
      const messages = snapshot.data ?? snapshot
      for (const message of messages) {
        for (const part of message.content ?? []) {
          const key = `${message.id}:${part.id ?? part.type}`
          if (part.type === "text" && part.text) {
            const previous = printed.get(key) ?? ""
            if (part.text.length > previous.length) {
              process.stdout.write(part.text.slice(previous.length))
              printed.set(key, part.text)
            }
          }
          if (part.type === "tool") {
            const state = part.state ?? {}
            const signature = `${state.status ?? ""}:${state.error?.message ?? ""}`
            if (signature && printed.get(key) !== signature) {
              console.log(`\n[进度 tool] ${part.name} -> ${state.status ?? "unknown"}`)
              if (state.error?.message) console.log(`[工具错误] ${state.error.message}`)
              printed.set(key, signature)
            }
          }
        }
      }
    } catch (error) {
      console.log(`[进度] 正在等待 Session/SSE 建立：${String(error).slice(0, 180)}`)
    }
  }
  if (result.error) throw result.error
  const response = result.response
  if (!response.ok) throw new Error(`prompt_stream HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`)
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i)

  const events = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n")
      if (!data || data === "[DONE]") continue
      let event
      try {
        event = JSON.parse(data)
      } catch {
        console.log(data)
        continue
      }
      events.push(event)
      const type = event.type ?? "event"
      const properties = event.properties ?? event.data ?? {}
      let detail = ""
      if (type === "session.text.delta") detail = properties.delta ?? ""
      else if (type === "session.tool.input.started") detail = properties.name ?? ""
      else if (type === "session.tool.input.ended") detail = String(properties.text ?? "").slice(0, 160)
      else if (type === "session.tool.called") {
        const input = properties.input ?? {}
        detail = `${properties.name ?? "tool"} ${input.path ?? input.filePath ?? input.command ?? ""}`.slice(0, 180)
      } else if (type === "session.tool.success") detail = `${properties.name ?? "tool"} completed`
      else if (type === "session.tool.error") detail = `${properties.name ?? "tool"}: ${properties.error?.message ?? "failed"}`
      else if (type === "session.execution.failed") detail = JSON.stringify(properties).slice(0, 200)
      console.log(`[SSE] ${type}${detail === "{}" ? "" : ` ${detail}`}`)
    }
  }
  console.log(`--- ${label}: SSE 结束（${events.length} 个事件）---`)
  assert(events.length > 0, `${label}: prompt_stream 未收到事件`)
  const eventTypes = events.map((event) => event.type)
  assert(!eventTypes.includes("session.execution.failed"), `${label}: SSE 显示执行失败`)
  assert(eventTypes.includes("session.execution.succeeded"), `${label}: SSE 未观察到执行成功终态`)
  return events
}

async function runShell(sid, command, label) {
  await api(`/api/session/${sid}/shell`, "POST", { command })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const result = await api(`/api/session/${sid}/message?order=asc`)
    const messages = result.data ?? result
    const shell = messages.filter((message) => message.type === "shell" && message.command === command).at(-1)
    if (shell && shell.status !== "running") {
      const output = shell.output?.output ?? ""
      console.log(`[shell] ${label}: status=${shell.status} exit=${shell.exit}\n${output}`)
      assert.equal(shell.status, "exited", `${label}: ${output}`)
      assert.equal(shell.exit, 0, `${label}: ${output}`)
      return output
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error(`${label}: shell 等待超时`)
}

function logResult(label, detail) {
  console.log(`\n✅ ${label}: ${detail}`)
}

function assertToolSucceeded(events, name) {
  const calls = new Map()
  const succeeded = new Set()
  for (const event of events) {
    const properties = event.properties ?? event.data ?? {}
    if (event.type === "session.tool.input.started") calls.set(properties.id, properties.name)
    if (event.type === "session.tool.success") succeeded.add(properties.id)
  }
  assert([...calls].some(([id, tool]) => tool === name && succeeded.has(id)), `SSE 未验证 ${name} 工具成功`)
}

console.log(`BASE=${BASE} MODEL=${MODEL.providerID}/${MODEL.id}`)

// T10.1 — create a project, inspect its files, and run it.
{
  const sid = await newSession("T10.1 streaming E2E")
  const events = await streamPrompt(sid, `Create a Python project at /workspace/myapp with exactly these files:
1. myapp/__init__.py (empty)
2. myapp/main.py with def main(): print("hello")
3. tests/__init__.py (empty)
4. tests/test_main.py that imports myapp.main
Use the write tool to create all four files.`, "T10.1 创建项目")
  assert(events.length > 0)
  const files = await runShell(sid, "find /workspace/myapp -type f -name '*.py' | wc -l | tr -d ' '", "T10.1 文件检查")
  assert.equal(files.trim(), "4", `Python 文件数量不符合预期: ${files}`)
  const output = await runShell(sid, "cd /workspace/myapp && python3 -c 'from myapp.main import main; main()'", "T10.1 运行项目")
  assert.equal(output.trim(), "hello")
  logResult("T10.1", "4 个 Python 文件存在，运行输出 hello")
}

// T10.2 — write/edit and verify the resulting diff and behavior.
{
  const sid = await newSession("T10.2 streaming E2E")
  await streamPrompt(sid, "Use the write tool to create /workspace/calc.py with add(a,b) returning a+b and multiply(a,b) returning a*b.", "T10.2 初始文件")
  const editEvents = await streamPrompt(sid, "Use the edit tool to add subtract(a,b) returning a-b to /workspace/calc.py.", "T10.2 修改文件")
  assertToolSucceeded(editEvents, "edit")
  const output = await runShell(sid, "cd /workspace && python3 -c 'from calc import add, subtract; print(f\"{add(2,3)},{subtract(5,2)}\")'", "T10.2 执行验证")
  assert.equal(output.trim(), "5,3")
  const diff = await runShell(sid, "cd /workspace && git diff --no-index /dev/null calc.py || test $? -eq 1", "T10.2 diff")
  assert.match(diff, /subtract/)
  logResult("T10.2", "diff 包含 subtract，运行结果为 5,3")
}

// T10.3 — the prompt_stream itself is consumed and printed event-by-event.
{
  const sid = await newSession("T10.3 streaming SSE E2E")
  const events = await streamPrompt(sid, "Use the write tool to create /workspace/hello.py containing print('hello from SSE test').", "T10.3 SSE 完整流程")
  const output = await runShell(sid, "cat /workspace/hello.py", "T10.3 文件验证")
  assert.match(output, /hello from SSE test/)
  logResult("T10.3", `收到 ${events.length} 个流式事件，文件内容验证通过`)
}

// T10.4 — two streamed turns; verify the final persisted assistant response.
{
  const sid = await newSession("T10.4 streaming context E2E")
  await streamPrompt(sid, "Remember this secret number: 42. Just reply OK.", "T10.4 Round 1")
  await streamPrompt(sid, "What was the secret number I told you? Reply with the number.", "T10.4 Round 2")
  const result = await api(`/api/session/${sid}/message?order=asc`)
  const messages = result.data ?? result
  const replies = messages
    .filter((message) => message.type === "assistant")
    .flatMap((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text))
  assert.match(replies.at(-1) ?? "", /\b42\b/, "Round 2 助手终态回复中没有找到数字 42")
  logResult("T10.4", "Round 2 消息终态包含 42")
}

console.log("\n🎉 T10.1–T10.4 全部通过")
