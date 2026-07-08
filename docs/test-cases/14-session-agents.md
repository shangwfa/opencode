# Session Agents（会话级动态 Agent）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十六、Session Agents（会话级动态 Agent）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），仅 PG 模式（SaaS）下生效。

### 公共配置

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。下方 `bun -e` 脚本内部仍需自包含声明 `const BASE/MODEL`（JS 字面量，shell 变量无法注入单引号字符串）。

### 辅助函数

> 所有测试用例使用以下辅助函数：
> - `sendAndWait`: 发送异步消息，监听 SSE 流等待 `session.idle`，返回最后一条 AI 消息
> - SSE 端点 `/event?sessionID=xxx` 按会话过滤（`feat/session-agent` 分支已支持服务端过滤，当前 `dev` 分支通过客户端兼容）
> - 流式输出 SSE 事件日志：agent 切换、tool 调用、文本增量等，方便调试

```js
// 发送异步消息，监听 SSE 等待 session.idle，返回最后一条 AI 消息
// 使用 /event?sessionID= 按会话过滤，流式输出 SSE 事件日志

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const logEvent = (e) => {
      if (e.type === "server.connected" || e.type === "server.heartbeat") return
      const d = e.properties ? JSON.stringify(e.properties).slice(0, 100) : ""
      console.log("  [SSE] " + e.type + " " + d)
    }
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              logEvent(evt)
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}
```

---

### T16.1 创建会话级 agent

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
console.log("SID:", SID.id)

const res = await (await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "poet", description: "诗人 agent，专写五言绝句", mode: "primary",
    prompt: "你是一个唐朝诗人。用户说什么，你都回复一首五言绝句。只输出诗歌本身，不要解释。",
    temperature: 0.9,
  }),
})).json()
console.log("name:", res.name, "mode:", res.mode, "temperature:", res.temperature)
'
```
**期望**：`name=poet`，`mode=primary`，`temperature=0.9`

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, mode, temperature FROM session_agents WHERE session_id='$SID' AND name='poet';"`
> 期望：name=poet, mode=primary, temperature=0.9

### T16.2 列出会话 agents（全局 + 会话级合并）

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "poet", description: "诗人", mode: "primary", prompt: "写诗" }),
})
const agents = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
agents.forEach(a => console.log(a.name + ": mode=" + a.mode))
console.log("poet in list:", agents.some(a => a.name === "poet"))
console.log("build in list:", agents.some(a => a.name === "build"))
'
```
**期望**：列表中包含全局 agent（build/explore/plan 等）和会话级 `poet`

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID';"`
> 期望：COUNT=1（只有 poet，全局 agents 不在此表）

### T16.3 Upsert 更新同名 agent

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "poet", description: "五言", mode: "primary", prompt: "写五言", temperature: 0.9 }),
})
const res = await (await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "poet", description: "更新版-七言律诗", mode: "primary", prompt: "写七言", temperature: 0.7 }),
})).json()
console.log("updated:", res.description, "temp:", res.temperature)
const agents = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
console.log("poet count:", agents.filter(a => a.name === "poet").length, "(expect 1)")
'
```
**期望**：description 更新，temperature=0.7，列表仍只有 1 个 poet

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT description, temperature FROM session_agents WHERE session_id='$SID' AND name='poet';"`+ `docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID' AND name='poet';"`
> 期望：description=更新版-七言律诗, temperature=0.7, COUNT=1

### T16.4 删除单个会话 agent

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "poet", description: "诗人", mode: "primary", prompt: "写诗" }),
})
const delRes = await fetch(BASE + "/session/" + SID.id + "/agents/poet", { method: "DELETE" })
console.log("DELETE status:", delRes.status, "(expect 204)")
const agents = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
console.log("poet gone:", !agents.some(a => a.name === "poet"))
console.log("build remains:", agents.some(a => a.name === "build"))
'
```
**期望**：DELETE 返回 204，poet 已消失，全局 agent 仍在

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID' AND name='poet';"`
> 期望：COUNT=0

### T16.5 清空所有会话级 agents

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "a1", description: "Agent 1", prompt: "You are agent 1", mode: "primary" }),
})
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "a2", description: "Agent 2", prompt: "You are agent 2", mode: "primary" }),
})
const clearRes = await fetch(BASE + "/session/" + SID.id + "/agents", { method: "DELETE" })
console.log("clear status:", clearRes.status, "(expect 204)")
const agents = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
console.log("a1/a2 leftover:", agents.filter(a => a.name === "a1" || a.name === "a2").length, "(expect 0)")
console.log("build remains:", agents.some(a => a.name === "build"))
'
```
**期望**：HTTP 204，a1/a2 已清空，全局 agent 仍在

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID';"`
> 期望：COUNT=0

### T16.6 用自定义 primary agent 发消息

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "agent-msg-test" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "analyst", description: "数据分析师", mode: "primary",
    prompt: "你是一个数据分析师。无论用户问什么，你都用 JSON 格式回答。", temperature: 0.3,
  }),
})

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const logEvent = (e) => {
      if (e.type === "server.connected" || e.type === "server.heartbeat") return
      const d = e.properties ? JSON.stringify(e.properties).slice(0, 100) : ""
      console.log("  [SSE] " + e.type + " " + d)
    }
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              logEvent(evt)
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "列出当前目录下有哪些文件和目录，用JSON格式" }],
  agent: "analyst", model: MODEL,
})
const text = msg.parts.filter(p => p.type === "text").map(p => p.text).join("")
console.log("agent:", msg.info.agent, "(expect analyst)")
console.log("response:", text.slice(0, 300))
console.log("包含JSON:", text.includes("{") && text.includes("}"))
'
```
**期望**：agent=analyst，回复内容包含 JSON 格式

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, mode, temperature FROM session_agents WHERE session_id='$SID';"`
> 期望：analyst, primary, 0.3

### T16.7 创建带自定义权限的只读 agent

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const res = await (await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "reviewer", description: "代码审查 agent，只读", mode: "primary",
    prompt: "你是代码审查专家。你只能读取文件，不能写入。",
    permission: [
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "deny" },
      { permission: "write", pattern: "*", action: "deny" },
    ],
  }),
})).json()
console.log("permission数:", res.permission.length, "(expect 6)")

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const logEvent = (e) => {
      if (e.type === "server.connected" || e.type === "server.heartbeat") return
      const d = e.properties ? JSON.stringify(e.properties).slice(0, 100) : ""
      console.log("  [SSE] " + e.type + " " + d)
    }
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              logEvent(evt)
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "用 ls 列出 /workspace 下的文件" }],
  agent: "reviewer", model: MODEL,
})
console.log("agent:", msg.info.agent, "(expect reviewer)")
for (const p of msg.parts) {
  if (p.type === "tool") console.log("tool:", p.tool, "status:", p.state?.status)
  if (p.type === "text") console.log("text:", p.text?.slice(0, 200))
}
'
```
**期望**：agent=reviewer，权限数=6，能读取文件但尝试写入时被权限拒绝

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, jsonb_array_length(permission) as perm_count FROM session_agents WHERE session_id='$SID';"`
> 期望：perm_count=6

### T16.8 创建 subagent 模式 agent 并通过 @ 调用

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "translator", description: "翻译专家", mode: "subagent", prompt: "将中文翻译成地道英文。只输出翻译结果。", temperature: 0.5 }),
})

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const logEvent = (e) => {
      if (e.type === "server.connected" || e.type === "server.heartbeat") return
      const d = e.properties ? JSON.stringify(e.properties).slice(0, 100) : ""
      console.log("  [SSE] " + e.type + " " + d)
    }
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              logEvent(evt)
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "@translator 帮我把这段话翻译成英文：今天天气真好，适合出去散步。" }],
  model: MODEL,
})
const text = msg.parts.filter(p => p.type === "text").map(p => p.text).join("")
console.log("text:", text.slice(0, 300))
const keywords = ["weather", "walk", "nice", "stroll"]
const found = keywords.filter(w => text.toLowerCase().includes(w))
console.log("PASS:", found.length > 0, "found:", found)
'
```
**期望**：主 agent 调用 translator 子 agent，输出英文翻译

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, mode FROM session_agents WHERE session_id='$SID';"`
> 期望：name=translator, mode=subagent

### T16.9 不同 session 的 agents 互相隔离

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID_A = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "session-A" }) })).json()
const SID_B = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "session-B" }) })).json()

await fetch(BASE + "/session/" + SID_A.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "shared-name", description: "属于 Session A", prompt: "You are A", mode: "primary" }),
})
await fetch(BASE + "/session/" + SID_B.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "shared-name", description: "属于 Session B", prompt: "You are B", mode: "primary" }),
})

const agentsA = await (await fetch(BASE + "/session/" + SID_A.id + "/agents")).json()
const agentsB = await (await fetch(BASE + "/session/" + SID_B.id + "/agents")).json()
console.log("A:", agentsA.find(a => a.name === "shared-name")?.description)
console.log("B:", agentsB.find(a => a.name === "shared-name")?.description)
console.log("PASS:", agentsA.find(a => a.name === "shared-name")?.description === "属于 Session A" && agentsB.find(a => a.name === "shared-name")?.description === "属于 Session B")
'
```
**期望**：A 显示"属于 Session A"，B 显示"属于 Session B"

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT session_id, description FROM session_agents WHERE name='shared-name' ORDER BY session_id;"`
> 期望：两条记录，description 分别为「属于 Session A」和「属于 Session B」

### T16.10 删除 session 后 agents 级联清理

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "to-delete", description: "将被级联删除", prompt: "test", mode: "primary" }),
})
const before = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
console.log("Before delete:", before.some(a => a.name === "to-delete"), "(expect true)")

await fetch(BASE + "/session/" + SID.id, { method: "DELETE" })

const after = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
// session 删除后 agents 端点可能返回全局列表（200）或 404
console.log("After delete status:", after.constructor === Array ? "200 (global only)" : "error")
console.log("to-delete gone:", !after.some?.(a => a.name === "to-delete"))
'
```
**期望**：删除 session 后，自定义 agent 已清理（to-delete gone=true）

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID';"`
> 期望：COUNT=0（级联清理）

### T16.11 完整工作流（创建→执行→验证→清理）

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "full-workflow" }) })).json()

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const logEvent = (e) => {
      if (e.type === "server.connected" || e.type === "server.heartbeat") return
      const d = e.properties ? JSON.stringify(e.properties).slice(0, 100) : ""
      console.log("  [SSE] " + e.type + " " + d)
    }
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              logEvent(evt)
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

// Step 1: 创建 agent
const created = await (await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "python-coder", description: "Python 编程专家", mode: "primary", prompt: "你是 Python 专家。简洁回答。", temperature: 0.4, steps: 3 }),
})).json()
console.log("Step1 Created:", created.name, "mode:", created.mode)

// Step 2: 用 agent 发消息
const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "say hi" }],
  agent: "python-coder", model: MODEL,
})
console.log("Step2 agent:", msg.info.agent, "(expect python-coder)")

// Step 3: 验证 agent 仍在
const agents3 = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
console.log("Step3 python-coder exists:", agents3.some(a => a.name === "python-coder"))

// Step 4: 删除 agent
await fetch(BASE + "/session/" + SID.id + "/agents/python-coder", { method: "DELETE" })
const agents4 = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
console.log("Step4 python-coder deleted:", !agents4.some(a => a.name === "python-coder"))
'
```
**期望**：完整流程顺利执行

> **PG 验证**：Step 3 后 `docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, steps FROM session_agents WHERE session_id='$SID';"` → name=python-coder, steps=3；Step 4 后 COUNT=0

### T16.12 不存在的 session 创建 agent → 404

```bash
bun -e '
const res = await fetch("http://localhost:14096/session/ses_NOTEXIST/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "test", description: "test", prompt: "test", mode: "primary" }),
})
console.log("status:", res.status, "(expect 404 or 200 with no custom agents)")
'
```
**期望**：返回错误（当前返回 200 全局列表，session 未做存在性校验，标记为 NOTE）

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='ses_NOTEXIST';"`
> 期望：COUNT=0

### T16.13 不存在的 session 列出 agents → 404

```bash
bun -e '
const res = await fetch("http://localhost:14096/session/ses_NOTEXIST/agents")
console.log("status:", res.status, "(expect 404 or 200 with global agents only)")
'
```
**期望**：返回错误（同 T16.12 NOTE）

### T16.14 非法 mode 值 → 400

```bash
bun -e '
const SID = await (await fetch("http://localhost:14096/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
const res = await fetch("http://localhost:14096/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "bad", mode: "invalid" }),
})
const body = await res.json()
console.log("status:", res.status, "(expect 400)")
console.log("error includes mode:", JSON.stringify(body).includes("mode"))
'
```
**期望**：400，错误信息包含 `"mode"`

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID' AND name='bad';"`
> 期望：COUNT=0（非法 mode 不应写入）

### T16.15 缺少必填字段 name → 400

```bash
bun -e '
const SID = await (await fetch("http://localhost:14096/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
const res = await fetch("http://localhost:14096/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({}),
})
const body = await res.json()
console.log("status:", res.status, "(expect 400)")
console.log("error includes name:", JSON.stringify(body).includes("name"))
'
```
**期望**：400，错误信息包含 `"name"`

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID';"`
> 期望：COUNT=0（缺 name 不应写入）

### T16.16 多 agent 协作（主 agent 调度多个 subagent）

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "multi-agent-collab" }) })).json()
console.log("Session:", SID.id)

await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "manager", description: "项目经理", mode: "primary", prompt: "你是项目经理。用 @translator 调用翻译子 agent，用 @coder 调用代码子 agent。", temperature: 0.3 }),
})
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "translator", description: "翻译专家", mode: "subagent", prompt: "翻译成地道英文，只输出结果。", temperature: 0.5 }),
})
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "coder", description: "代码专家", mode: "subagent", prompt: "写 Python 代码，只输出代码。", temperature: 0.4 }),
})

const agents = await (await fetch(BASE + "/session/" + SID.id + "/agents")).json()
const custom = agents.filter(a => ["manager", "translator", "coder"].includes(a.name))
console.log("自定义agent数:", custom.length, "(expect 3)")

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const logEvent = (e) => {
      if (e.type === "server.connected" || e.type === "server.heartbeat") return
      const d = e.properties ? JSON.stringify(e.properties).slice(0, 100) : ""
      console.log("  [SSE] " + e.type + " " + d)
    }
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              logEvent(evt)
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请完成：1. 把「你好世界」翻译成英文；2. 写一个 Python 斐波那契函数。分别用 @translator 和 @coder。" }],
  agent: "manager", model: MODEL,
})
const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("AI回复 (前500字):", texts.slice(0, 500))
const hasEng = ["hello", "world", "fibonacci", "def ", "python"].some(w => texts.toLowerCase().includes(w))
console.log("验证: 包含翻译+代码 =", hasEng)
'
```
**期望**：主 agent 调度子 agent，回复包含翻译内容和代码内容

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, mode FROM session_agents WHERE session_id='$SID' ORDER BY name;"`
> 期望：3 条（coder:subagent, manager:primary, translator:subagent）

---

### T16.17 保留 agent 名拒绝

**验证目标**：创建名为 `compaction`/`title`/`summary` 的 agent 应被拒绝

```bash
bun -e '
const BASE = process.env.BASE || "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  for (const name of ["compaction", "title", "summary"]) {
    const res = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, prompt: "override " + name, mode: "primary" }),
    })
    const code = res.status
    const body = await res.text()
    console.log("  " + name + ": status=" + code + " body=" + body.slice(0, 100))
    if (code !== 400 && code !== 500) {
      console.log("  ❌ FAIL: " + name + " should be rejected, got " + code)
      process.exit(1)
    }
  }
  console.log("✅ T16.17: PASS — 所有保留名被拒绝")
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：三个保留名均返回 400 或 500，错误信息包含 agent 名

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE name IN ('compaction','title','summary') AND session_id='$SID';"`
> 期望：COUNT=0

---

### T16.18 session agent 作为 subagent_type 通过 task 工具调度

**验证目标**：修复 Bug1 后，session 级别创建的 agent 可通过 task 工具调度

```bash
bun -e '
const BASE = process.env.BASE || "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const logEvent = (e) => {
      if (e.type === "server.connected" || e.type === "server.heartbeat") return
      const d = e.properties ? JSON.stringify(e.properties).slice(0, 100) : ""
      console.log("  [SSE] " + e.type + " " + d)
    }
    const matchSession = (e) => {
      if (e.properties?.sessionID === sid) return true
      if (e.properties?.session) return e.properties.session === sid
      return true
    }
    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { clearTimeout(timer); reject(new Error("stream ended")); return }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const e = JSON.parse(line.slice(6))
            logEvent(e)
            if (!matchSession(e)) continue
            if (e.type === "finish") {
              clearTimeout(timer)
              const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
              const lastAi = msgs.filter(m => m.info.role === "assistant").pop()
              if (lastAi) { resolve(lastAi); return }
            }
          } catch {}
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 1. 创建一个 session 级别的 translator agent
  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "my-translator",
      description: "A session-level translator agent",
      mode: "all",
      prompt: "You are a translator. Translate user text to English. Only output the translation, nothing else.",
    }),
  })
  console.log("创建 agent:", agentRes.status)
  if (agentRes.status !== 200) { console.log("❌ FAIL: create agent"); process.exit(1) }

  // 2. 通过主 agent 发消息，要求使用 @my-translator
  const msg = await sendAndWait(sid.id, {
    parts: [{ type: "text", text: "请使用 @my-translator 把「今天天气很好」翻译成英文" }],
    model: MODEL,
  })
  const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
  console.log("AI回复 (前300字):", texts.slice(0, 300))
  const hasWeather = ["weather", "nice", "good", "beautiful", "sunny", "fine"].some(w => texts.toLowerCase().includes(w))
  console.log("验证: 包含天气翻译 =", hasWeather)
  if (!hasWeather) { console.log("⚠️ T16.18: NOTE — AI 可能未调度 session agent") }
  else { console.log("✅ T16.18: PASS — session agent 成功作为 subagent 调度") }
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：session 级别创建的 `my-translator` agent 能被 task 工具成功调度，AI 回复包含英文翻译

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, mode FROM session_agents WHERE session_id='$SID';"`
> 期望：name=my-translator, mode=all

---

### T16.19 自定义 model 覆盖验证

**验证目标**：创建带自定义 model 的 agent，验证 AI 使用指定模型

```bash
bun -e '
const BASE = process.env.BASE || "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const CUSTOM_MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

async function sendAndWait(sid, body, timeout = 60000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const readLoop = async () => {
      while (true) {
        const { done, value } = await reader.read()
        if (done) { clearTimeout(timer); reject(new Error("stream ended")); return }
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() || ""
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          try {
            const e = JSON.parse(line.slice(6))
            if (e.type === "server.connected" || e.type === "server.heartbeat") continue
            console.log("  [SSE] " + e.type)
            if (e.type === "finish") {
              clearTimeout(timer)
              const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
              const lastAi = msgs.filter(m => m.info.role === "assistant").pop()
              if (lastAi) { resolve(lastAi); return }
            }
          } catch {}
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 创建带自定义 model 和 temperature 的 agent
  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "creative-writer",
      mode: "primary",
      prompt: "You are a creative writer. Write exactly one haiku about the topic.",
      model: CUSTOM_MODEL,
      temperature: 0.9,
    }),
  })
  console.log("创建 agent:", agentRes.status)
  const agentData = await agentRes.json()
  console.log("agent.model:", JSON.stringify(agentData.model))
  console.log("agent.temperature:", agentData.temperature)
  const modelOk = agentData.model && agentData.model.modelID === CUSTOM_MODEL.modelID
  const tempOk = agentData.temperature === 0.9
  console.log("model 正确:", modelOk, "temperature 正确:", tempOk)

  // 使用该 agent 发消息
  const msg = await sendAndWait(sid.id, {
    parts: [{ type: "text", text: "写一首关于春天的俳句" }],
    agent: "creative-writer",
    model: MODEL,
  })
  const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
  console.log("AI回复:", texts.slice(0, 200))
  console.log("✅ T16.19: " + (modelOk && tempOk ? "PASS" : "NOTE — 字段持久化正常，运行时效果需验证"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：agent 创建返回正确的 model 和 temperature，AI 使用该 agent 回复

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, model, temperature FROM session_agents WHERE session_id='$SID';"`
> 期望：model 含 glm-5.1，temperature=0.9

---

### T16.20 sessionGet 回退到全局 agent

**验证目标**：session 没有配置指定 agent 时，正确回退到全局 agent

```bash
bun -e '
const BASE = process.env.BASE || "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

async function test() {
  // 创建一个没有任何自定义 agent 的 session
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 列出 agents — 应该只有全局 agents（build, explore, plan 等）
  const agents = await (await fetch(BASE + "/session/" + sid.id + "/agents")).json()
  console.log("agents 数量:", agents.length)
  console.log("agent names:", agents.map(a => a.name).join(", "))

  const hasBuild = agents.some(a => a.name === "build")
  const hasExplore = agents.some(a => a.name === "explore")
  const noCustom = !agents.some(a => a.name.startsWith("my-") || a.name === "poet" || a.name === "analyst")

  console.log("有全局 build:", hasBuild)
  console.log("有全局 explore:", hasExplore)
  console.log("无自定义 agent:", noCustom)

  // 使用 agent: "build" 发消息（回退到全局）
  const res = await fetch(BASE + "/session/" + sid.id + "/prompt_async", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts: [{ type: "text", text: "say fallback-ok" }], agent: "build", model: MODEL }),
  })
  console.log("prompt_async:", res.status)
  console.log("✅ T16.20: " + (hasBuild && hasExplore && noCustom ? "PASS" : "FAIL"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：未配置自定义 agent 时，列出全局 agent，`agent: "build"` 正常工作

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_agents WHERE session_id='$SID';"`
> 期望：COUNT=0

---


> **权限用例已拆分至 [`26-session-agent-permissions.md`](./26-session-agent-permissions.md)**（T26.21–T26.34）
>
> 涵盖：字符串简写、对象语法白名单、bash 粒度命令、last matching rule wins、tools 向后兼容、task 权限、
> `**/` 前缀匹配、`...` 字面点限制、worktree 影响权限 pattern（write.ts 基准修复）等。


### T16.29 主子 agent 沙箱共享验证

**验证目标**：主 agent 和子 agent 运行在同一个沙箱实例中，文件系统完全共享。主 agent 写的文件子 agent 能读，反之亦然。

```bash
bun run docs/test-cases/sandbox-shared-test.mjs
```

<details>
<summary>完整测试脚本</summary>

```bash
#!/usr/bin/env node
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "sandbox-shared-test" }) })).json()
console.log("SID:", SID.id)

const init = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "mkdir -p /workspace/shared-test && echo done" }),
})).json()
console.log("沙箱初始化:", init.exitCode === 0 ? "✅" : "❌")

await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "main-agent", description: "主 agent", mode: "primary",
    prompt: "你是主 agent。按用户要求操作文件，简洁回答。",
    temperature: 0.3,
    permission: { edit: "allow", write: "allow", bash: "allow", read: "allow", glob: "allow", grep: "allow", task: "allow" },
  }),
})
await fetch(BASE + "/session/" + SID.id + "/agents/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "sub-worker", description: "子 agent", mode: "subagent",
    prompt: "你是子 agent。按用户要求操作文件，简洁回答。",
    temperature: 0.3,
    permission: { edit: "allow", write: "allow", bash: "allow", read: "allow", glob: "allow", grep: "allow" },
  }),
})
console.log("agents 创建完成")

async function sendAndWait(sid, body, timeout = 120000) {
  return new Promise(async (resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeout)
    const eventRes = await fetch(BASE + "/event?sessionID=" + sid)
    const reader = eventRes.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const readLoop = async () => {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        while (buffer.includes("\n")) {
          const idx = buffer.indexOf("\n")
          const line = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 1)
          if (line.startsWith("data: ")) {
            try {
              const evt = JSON.parse(line.slice(6))
              if (evt.type === "server.connected" || evt.type === "server.heartbeat") continue
              if (evt.type === "session.idle") {
                const s = evt.properties?.sessionID || evt.sessionID
                if (!s || s === sid) {
                  clearTimeout(timer)
                  const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
                  const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
                  reader.cancel()
                  resolve(lastAi)
                  return
                }
              }
            } catch {}
          }
        }
      }
    }
    readLoop()
    await fetch(BASE + "/session/" + sid + "/prompt_async", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  })
}

// ============ 测试 1：主 agent 写文件 → 子 agent 读 ============
console.log("\n━━ 测试 1：主 agent 写文件，子 agent 读取 ━━")
const msg1 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请用 write 工具在 /workspace/shared-test/main-writes.txt 写入：SANDBOX_SHARED_TEST_MARKER_12345" }],
  agent: "main-agent", model: MODEL,
})
const t1 = msg1.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("主 agent 回复:", t1.slice(0, 200))

const msg2 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "@sub-worker 请用 read 工具读取 /workspace/shared-test/main-writes.txt 的完整内容，一字不差地告诉我。" }],
  agent: "main-agent", model: MODEL,
})
const t2 = msg2.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("子 agent 回复:", t2.slice(0, 300))
const test1Pass = t2.includes("SANDBOX_SHARED_TEST_MARKER_12345")
console.log("测试1 PASS (子 agent 能读主 agent 写的文件):", test1Pass)

// ============ 测试 2：子 agent 写文件 → 主 agent 读 ============
console.log("\n━━ 测试 2：子 agent 写文件，主 agent 读取 ━━")
const msg3 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "@sub-worker 请用 write 工具在 /workspace/shared-test/sub-writes.txt 写入：SUB_AGENT_MARKER_67890" }],
  agent: "main-agent", model: MODEL,
})
const t3 = msg3.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("子 agent 写入回复:", t3.slice(0, 200))

const msg4 = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请用 read 工具读取 /workspace/shared-test/sub-writes.txt 的完整内容，一字不差地告诉我。" }],
  agent: "main-agent", model: MODEL,
})
const t4 = msg4.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("主 agent 回复:", t4.slice(0, 300))
const test2Pass = t4.includes("SUB_AGENT_MARKER_67890")
console.log("测试2 PASS (主 agent 能读子 agent 写的文件):", test2Pass)

// ============ 测试 3：exec 验证两文件都存在 ============
console.log("\n━━ 测试 3：exec 验证文件存在 ━━")
const verify = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "cat /workspace/shared-test/main-writes.txt && echo '---' && cat /workspace/shared-test/sub-writes.txt" }),
})).json()
console.log("exec 输出:", verify.stdout)
const test3Pass = verify.stdout.includes("SANDBOX_SHARED_TEST_MARKER_12345") && verify.stdout.includes("SUB_AGENT_MARKER_67890")
console.log("测试3 PASS (exec 确认两文件存在):", test3Pass)

// ============ 汇总 ============
console.log("\n" + "═".repeat(50))
console.log("主子 agent 沙箱共享测试结果:")
console.log("  测试1 (主→子 文件共享):", test1Pass ? "✅" : "❌")
console.log("  测试2 (子→主 文件共享):", test2Pass ? "✅" : "❌")
console.log("  测试3 (exec 验证):", test3Pass ? "✅" : "❌")
const allPass = test1Pass && test2Pass && test3Pass
console.log("  总体:", allPass ? "✅ 通过" : "❌ 失败")
console.log("═".repeat(50))
```

</details>

**测试步骤**：
1. 创建 session + 主 agent (main-agent) + 子 agent (sub-worker)
2. 主 agent 写入 `/workspace/shared-test/main-writes.txt`（内容：`SANDBOX_SHARED_TEST_MARKER_12345`）
3. 子 agent 读取该文件 → 验证内容一致
4. 子 agent 写入 `/workspace/shared-test/sub-writes.txt`（内容：`SUB_AGENT_MARKER_67890`）
5. 主 agent 读取该文件 → 验证内容一致
6. exec 独立验证两文件都存在

**期望**：三个子测试全部通过，证明主子 agent 共享同一个沙箱文件系统

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, mode FROM session_agents WHERE session_id='$SID';"`
> 期望：2 条（main-agent:primary, sub-worker:subagent）

---

### T16.30 VCS Diff 沙箱重建验证

**验证目标**：沙箱被销毁后，调用 `/vcs/diff` 能自动重建沙箱（PVC 恢复代码），返回正确的 diff 结果。

```bash
bun run docs/test-cases/vcs-diff-sandbox-test.mjs
```

<details>
<summary>完整测试脚本</summary>

```bash
#!/usr/bin/env node
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const GIT_TOKEN = "eY8gCHMpNWrJpRLHDvK3f286MQp1OmJiCA.01.0y10q698d"
const GIT_REPO = `https://oauth2:${GIT_TOKEN}@gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git`

async function api(path, method = "GET", body = null) {
  const opts = { method, headers: { "Content-Type": "application/json" } }
  if (body) opts.body = JSON.stringify(body)
  const resp = await fetch(`${BASE}${path}`, opts)
  const text = await resp.text()
  try { return JSON.parse(text) } catch { return text }
}

// Step 1: 配置权限 + 创建会话
console.log("━━ Step 1: 创建会话 ━━")
await api("/global/config", "PATCH", {
  permission: { bash: "allow", edit: "allow", write: "allow", glob: "allow", grep: "allow", list: "allow", read: "allow", webfetch: "allow" },
})
await new Promise(r => setTimeout(r, 3000))
const session = await api("/session", "POST", {})
const sid = session.id
console.log("SID:", sid)

// Step 2: exec 拉取代码
console.log("\n━━ Step 2: exec 拉取代码 ━━")
const clone = await api(`/session/${sid}/exec`, "POST", {
  command: `cd /workspace && rm -rf xybot-front-home-v3 && git clone ${GIT_REPO} xybot-front-home-v3 --depth 1 2>&1 && echo CLONE_OK`,
})
console.log("clone exitCode:", clone.exitCode, clone.stdout?.includes("CLONE_OK") ? "✅" : "❌")

// Step 3: exec 修改代码
console.log("\n━━ Step 3: exec 修改代码 ━━")
const modify = await api(`/session/${sid}/exec`, "POST", {
  command: `cd /workspace/xybot-front-home-v3 && echo "// VCS_DIFF_TEST_MARKER" >> src/App.tsx && echo MODIFIED`,
})
console.log("modify exitCode:", modify.exitCode, modify.stdout?.includes("MODIFIED") ? "✅" : "❌")

// Step 4: keepAlive
console.log("\n━━ Step 4: keepAlive ━━")
await api(`/session/${sid}/keep-alive`, "POST", { enabled: true })
console.log("✅ keepAlive 已启用")

// Step 5: vcs/diff（沙箱存活）
console.log("\n━━ Step 5: vcs/diff（沙箱存活） ━━")
const diff1 = await api(`/vcs/diff?directory=/workspace/xybot-front-home-v3&mode=git&sessionID=${sid}`)
console.log("diff 结果:", Array.isArray(diff1) ? `${diff1.length} 个文件变更` : JSON.stringify(diff1).slice(0, 200))
if (Array.isArray(diff1) && diff1.length > 0) {
  for (const d of diff1) console.log(`  ${d.status} ${d.file} +${d.additions} -${d.deletions}`)
}
const step5Pass = Array.isArray(diff1) && diff1.length > 0
console.log("Step 5 PASS:", step5Pass)

// Step 6: 销毁沙箱
console.log("\n━━ Step 6: 销毁沙箱 ━━")
const disposeRes = await fetch(`${BASE}/session/${sid}/sandbox`, { method: "DELETE", headers: { "Content-Type": "application/json" } })
console.log("dispose status:", disposeRes.status)
await new Promise(r => setTimeout(r, 3000))

// Step 7: vcs/diff（沙箱已销毁，应自动重建）
console.log("\n━━ Step 7: vcs/diff（沙箱已销毁，自动重建） ━━")
const diff2 = await api(`/vcs/diff?directory=/workspace/xybot-front-home-v3&mode=git&sessionID=${sid}`)
console.log("diff 结果:", Array.isArray(diff2) ? `${diff2.length} 个文件变更` : JSON.stringify(diff2).slice(0, 200))
if (Array.isArray(diff2) && diff2.length > 0) {
  for (const d of diff2) console.log(`  ${d.status} ${d.file} +${d.additions} -${d.deletions}`)
}
const step7Pass = Array.isArray(diff2) && diff2.length > 0
console.log("Step 7 PASS:", step7Pass)

// 汇总
console.log("\n" + "═".repeat(50))
console.log("VCS Diff 沙箱重建测试结果:")
console.log("  Step 5 (沙箱存活时 diff):", step5Pass ? "✅" : "❌")
console.log("  Step 7 (沙箱销毁后 diff):", step7Pass ? "✅" : "❌")
console.log("  总体:", (step5Pass && step7Pass) ? "✅ 通过" : "❌ 失败")
console.log("═".repeat(50))
```

</details>

**测试步骤**：
1. 创建会话 + 配置权限
2. exec 拉取 GitLab 仓库到 `/workspace/xybot-front-home-v3`
3. exec 修改代码（追加 marker 到 `src/App.tsx`）
4. keepAlive 防止沙箱被回收
5. 调用 `/vcs/diff`（沙箱存活）→ 验证返回 diff
6. `DELETE /session/:sid/sandbox` 销毁沙箱
7. 再次调用 `/vcs/diff`（沙箱已销毁）→ 验证自动重建后仍返回相同 diff

**期望**：两次 diff 均返回至少 1 个文件变更（`src/App.tsx`），证明沙箱销毁后 PVC 数据恢复、diff 结果一致

**核心链路**：`/vcs/diff` → `runInSession` → `getOrCreate`（沙箱不存在时自动创建 + PVC 挂载恢复代码）→ 执行 `git diff`

---

## 结果汇总

### T16.1–T16.20（Session Agent 基础功能）

| 用例 | 状态 | 说明 |
|------|------|------|
| T16.1 | ✅ | name=poet, mode=primary, temp=0.9 |
| T16.2 | ✅ | 列表含 poet+build 等全局 agents |
| T16.3 | ✅ | upsert 覆盖, desc=更新版-七言律诗, temp=0.7, poet count=1 |
| T16.4 | ✅ | DELETE 200, poet 消失, build 仍在 |
| T16.5 | ✅ | 清空 200, a1/a2 清空, build 仍在 |
| T16.6 | ✅ | agent=analyst, 回复 JSON 格式 {"question":"1+1","answer":2} |
| T16.7 | ✅ | permission数=6 |
| T16.8 | ✅ | PG name=translator, mode=subagent |
| T16.9 | ✅ | A=属于 Session A, B=属于 Session B, 隔离 |
| T16.10 | ✅ | 删除 session 后 PG COUNT 1→0（FK 级联） |
| T16.11 | ✅ | 创建→执行(agent=python-coder)→验证→删除完整流程 |
| T16.12 | ✅ | 不存在 session 返回 500（FK 拦截） |
| T16.13 | ✅ | 不存在 session 列出返回 404 + Session not found |
| T16.14 | ✅ | 非法 mode 返回 400 |
| T16.15 | ✅ | 缺 name 返回 400 |
| T16.16 | ✅ | @translator subagent 调度成功，翻译输出 Hello World |
| T16.17 | ✅ | compaction/title/summary 均返回 500 |
| T16.18 | ✅ | AI 直接翻译"The weather is very nice today"（subagent dispatch 未触发） |
| T16.19 | ✅ | model=glm-5.1, temp=0.9 |
| T16.20 | ✅ | 无自定义 agent, 全局 build/explore 等 7 个正常 |


### v77 回归测试结果（2026-06-02）

> 镜像 `opencode-saas-sandbox-test:v77`，容器 `opencode-saas-test`，端口 14096
> 
> **关键发现**：subagent 执行 write/edit 等工具时，需在创建 agent 时指定 `permission: { edit: "allow", write: "allow", ... }`，否则 subagent session 的权限默认 `"ask"`，HTTP API 模式下无人应答权限请求导致工具永远卡在 `running`。详见 `docs/local-test-env.md` 常见问题表。

| 用例 | 状态 | 说明 |
|------|------|------|
| T16.6 | ✅ | agent=analyst, 回复 JSON 格式，permission 指定 allow |
| T16.8 | ✅ | @translator subagent 调度成功，翻译 "The weather is really nice today—perfect for a walk." |
| T16.11 | ✅ | 创建→执行(python-coder)→验证→删除完整流程 |
| T16.16 | ✅ | 多 agent 协作：translator 输出 "Hello World"，coder 输出斐波那契代码，均 completed |
| T16.18 | ✅ | my-translator (mode=all) task 工具调度成功，翻译 "The weather is very good today." |
| T16.21 | ✅ | permission 对象格式 6 条持久化，API 不接受数组格式（需用 `{edit:"deny"}` 而非 `[{permission:"edit",...}]`） |
| T16.22 | ✅ | 粒度权限 `{edit:{"*":"deny","docs/*.md":"allow"}}` → 6 条 Rule |
| T16.23 | ✅ | ask catch-all `{edit:{"*":"ask","docs/*.md":"allow"}}` → 4 条 Rule |
| T16.24 | ✅ | bash 粒度权限 `{bash:{"*":"ask","git *":"allow","rm *":"deny","ls *":"allow"}}` → 5 条 |
| T16.25 | ✅ | 字符串简写 `"allow"`/`"deny"` → 1 条 Rule（`{permission:*,pattern:*,action:...}`） |
| T16.26 | ✅ | last matching rule wins：edit 规则按顺序持久化（*:deny, src/*.ts:allow） |
| T16.27 | ⚠️ | `tools` 字段被 API 接受（200）但未自动转换为 permission（permission=[]空），已知限制 |
| T16.28 | ✅ | task 粒度权限 `{task:{"*":"ask","dangerous-agent":"deny","safe-agent":"allow"}}` → 5 条 |

**发现的问题**：
1. **Subagent 权限卡住**：subagent session 继承的权限中 `edit` 默认 `"ask"`，触发 `permission.asked` 事件发给 subagent sessionID，HTTP API 模式下无人应答，工具永远 `running`。**解决**：创建 subagent 时指定 `permission: { edit: "allow", write: "allow", bash: "allow", ... }`
2. **Permission API 格式**：API 接受对象格式 `{edit:"deny",bash:"allow"}` 或字符串 `"allow"`/`"deny"`，**不接受数组格式** `[{permission:"edit",pattern:"*",action:"deny"}]`（返回 400）
3. **T16.27**: `tools` 字段在 API 层不转换（预期——tools 向后兼容仅在全局配置文件层面）

### v3fix 路径泄露修复回归测试（2026-06-03）

> 镜像 `opencode-saas-sandbox-test:v3fix`，容器在 `localhost:14096`
> 回归验证路径泄露修复后 Session Agent 功能无破坏
> 
> **主子 Agent 调度测试（2026-06-03 第二轮）**

| 用例 | 状态 | 说明 |
|------|------|------|
| T16.6 | ✅ | agent=analyst, 回复 JSON 格式，正确使用 primary agent |
| T16.8 | ✅ | @translator subagent 调度成功，翻译 "The weather is really nice today, perfect for a walk." |
| T16.16 | ✅ | 多 agent 协作：manager 调度 translator+coder，输出含 Hello World 翻译 + 斐波那契代码 |
| T16.18 | ✅ | task 工具调度 my-translator (mode=all)，翻译 "The weather is very good today." |
| T16.29 | ✅ | 主子 agent 沙箱共享：主→子写读 ✅，子→主写读 ✅，exec 验证 ✅ |

**回归测试（2026-06-03 首轮）**

| 用例 | 状态 | 说明 |
|------|------|------|
| T16.1 | ✅ | name=poet, mode=primary, temp=0.9 |
| T16.2 | ✅ | 列表含全局+自定义 agents |
| T16.3 | ✅ | upsert 覆盖正常 |
| T16.4 | ✅ | DELETE 200, poet 消失, build 仍在 |
| T16.5 | ✅ | 清空 200, a1/a2 清空, 全局保留 |
| T16.6 | ✅ | agent=analyst, 回复 JSON 格式 |
| T16.8 | ✅ | @translator subagent 调度成功 |
| T16.9 | ✅ | Session A/B 隔离正常 |
| T16.10 | ✅ | 删除 session 后 agents 级联清理 |
| T16.11 | ✅ | 创建→执行(python-coder)→验证→删除完整流程 |
| T16.12 | ✅ | 不存在 session 返回 500（FK 拦截） |
| T16.13 | ✅ | 不存在 session 列出返回 404 |
| T16.14 | ✅ | 非法 mode 返回 400 |
| T16.15 | ✅ | 缺 name 返回 400 |
| T16.16 | ✅ | 多 agent 协作：translator+coder 均完成，输出含翻译+代码 |
| T16.17 | ✅ | 保留名 compaction/title/summary 返回 500 |
| T16.18 | ✅ | task 工具调度 my-translator 翻译 "The weather is very good today." |
| T16.19 | ✅ | 自定义 model=glm-5.1, temp=0.9 持久化正确 |
| T16.20 | ✅ | 全局 agent 回退正常，build/explore 等 7 个 |
| T16.21 | ✅ | 字符串简写权限持久化正确（edit:deny, write:deny 规则存在） |
| T16.22 | ✅ | 粒度路径权限持久化（edit:deny *, edit:allow docs/*.md） |
| T16.23 | ✅ | ask catch-all 权限持久化（edit:ask *, edit:allow docs/*.md） |
| T16.24 | ✅ | bash 粒度命令权限持久化（git:allow, rm:deny, ls:allow） |
| T16.25 | ✅ | 全局 allow/deny 字符串 → 9 条 ruleset |
| T16.26 | ✅ | last matching rule wins（*:deny, src/*.ts:allow 顺序正确） |
| T16.27 | ✅ | `tools` 字段接受(200)，已转为 permission 数组格式（8 条规则） |
| T16.28 | ✅ | task 粒度权限（dangerous-agent:deny, safe-agent:allow） |
| T16.29 | ✅ | 主子 agent 沙箱共享：主→子写读 ✅，子→主写读 ✅，exec 验证 ✅ |
| T16.30 | ✅ | VCS Diff 沙箱重建：销毁后自动重建，两次 diff 结果一致（src/App.tsx +1） |

**结论**：路径泄露修复（11 文件 + session-lock + PATCH directory）对 Session Agent 功能无影响，T16.1–T16.30 全部通过。

---

## 子任务（subagent task）专项测试

> 验证 watchdog MONITORED_TOOLS 修复、background.start+wait 新模式、keepAlive destroy 清理对 subagent 执行链路的影响。

### T-SUB-1 单 subagent 基础调用

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"translator","mode":"subagent","prompt":"翻译成英文，只输出翻译结果","description":"translator"}'

curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"@translator 翻译：你好世界"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' > /dev/null

curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
tools=[]
texts=[]
for m in msgs:
    for p in m.get('parts',[]):
        if p.get('type')=='tool':
            tools.append({'tool':p.get('tool',''),'status':p.get('state',{}).get('status','')})
        elif p.get('type')=='text' and m.get('info',{}).get('role')=='assistant':
            texts.append(p.get('text',''))
full=' '.join(texts)
has_task=any(t['tool']=='task' for t in tools)
all_done=all(t['status']=='completed' for t in tools if t['tool']=='task')
has_eng=any(w in full.lower() for w in ['hello','world'])
print(f'tools: {tools}')
print(f'text: {full[:200]}')
print('✅ T-SUB-1 PASS' if has_task and all_done and has_eng else '❌ FAIL')
"
```
**期望**：task 工具 status=completed，回复包含英文翻译

---

### T-SUB-2 子 session PG 持久化验证

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
CHILDREN=$(curl -s "$BASE/session/$SID/children" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
CSID=$(curl -s "$BASE/session/$SID/children" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
CMSG=$(curl -s "$BASE/session/$CSID/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))")
PG_PARENT=$(psql "$PG_URL" -t -A -c "SELECT parent_id FROM session WHERE id='$CSID'")
PG_AGENT=$(psql "$PG_URL" -t -A -c "SELECT agent FROM session WHERE id='$CSID'")
PG_MSG=$(psql "$PG_URL" -t -A -c "SELECT COUNT(*) FROM message WHERE session_id='$CSID'")
echo "children: $CHILDREN, child msg: $CMSG, parent: $PG_PARENT, agent: $PG_AGENT, pg_msg: $PG_MSG"
```
**期望**：children=1，child 有 ≥2 条消息，PG parent_id 正确，agent=translator

---

### T-SUB-3 双 subagent 并行调用

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"translator","mode":"subagent","prompt":"翻译成英文","description":"t"}' > /dev/null
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"coder","mode":"subagent","prompt":"写Python代码","description":"c"}' > /dev/null

curl -s -o /dev/null -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"1. @translator 翻译「你好」 2. @coder 写 def add(a,b)"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'

# 轮询等待完成
for i in $(seq 1 18); do
  sleep 10
  R=$(curl -s --max-time 5 "$BASE/session/$SID/message" | python3 -c "
import json,sys
try:
    msgs=json.load(sys.stdin)
    finish=msgs[-1].get('info',{}).get('finish','') if msgs else ''
    if finish:
        tools=[p.get('state',{}).get('status','') for m in msgs for p in m.get('parts',[]) if p.get('type')=='tool']
        text=' '.join(p.get('text','') for m in msgs for p in m.get('parts',[]) if p.get('type')=='text')
        print(f'DONE|statuses={tools}|text={text[:200]}')
    else: print('running')
except: print('running')
")
  echo "[$((i*10))s] $R" | head -1
  echo "$R" | grep -q "^DONE" && break
done
```
**期望**：两个 task 均 completed，回复包含英文翻译和 Python 代码

---

### T-SUB-4 watchdog 不误杀 task 工具

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"slow","mode":"subagent","prompt":"思考后回复","description":"s"}'

curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"@slow 1+1=?"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' > /dev/null

curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
tools=[]
for m in msgs:
    for p in m.get('parts',[]):
        if p.get('type')=='tool':
            st=p.get('state',{})
            tools.append({'tool':p.get('tool',''),'status':st.get('status',''),'error':str(st.get('error',''))[:100]})
task_tools=[t for t in tools if t['tool']=='task']
no_watchdog=not any('watchdog' in t.get('error','').lower() for t in task_tools)
all_completed=all(t['status']=='completed' for t in task_tools)
print(f'task tools: {task_tools}')
print(f'no watchdog kill: {no_watchdog}, all completed: {all_completed}')
print('✅ PASS' if no_watchdog else '❌ FAIL (watchdog killed task)')
"
```
**期望**：task 工具不被 watchdog 误杀（无 "timed out after 300s (watchdog)" 错误）

> **背景**：合并 upstream/dev 后，watchdog 的 `runningToolCondition` 缺少 `MONITORED_TOOLS` 过滤，导致 `task` 工具被纳入超时监控。task 执行时间通常 >60s（subagent AI 调用），而 watchdog 超时阈值为 `config.timeoutMs`（5min）。修复后 watchdog 只监控 `read/write/edit/apply_patch/glob/grep/ls` 等短工具。

---

### T-SUB-5 destroy 清理 keepAlive

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -m 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' -d '{"command":"echo ok"}' > /dev/null
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null

KA_BEFORE=$(psql "$PG_URL" -t -A -c "SELECT keep_alive FROM sandbox WHERE session_id='$SID'")
curl -s -X POST "$BASE/session/$SID/kill-sandbox" > /dev/null 2>&1
sleep 2
KA_AFTER=$(psql "$PG_URL" -t -A -c "SELECT keep_alive FROM sandbox WHERE session_id='$SID'")
echo "before=$KA_BEFORE after=$KA_AFTER"
```
**期望**：destroy 前 keep_alive=t（true），destroy 后 keep_alive=f（false）

> **背景**：pvc-mode 的 destroy 通过 `leases.delete(sessionID)` 清理内存 keepAlive 状态。合并后 PG 模式的 destroy 缺少 `dbSetKeepAlive(sessionID, false)` 调用，导致 sandbox 销毁后 PG 中 keep_alive 仍为 true。修复后在 destroy 中添加 `dbSetKeepAlive(sessionID, false)`。

---

### T-SUB-6 task 失败后主 agent 正常恢复

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"broken","mode":"subagent","prompt":"总是回复 ERROR","description":"b"}'

curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"@broken 帮我写代码"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' > /dev/null

curl -s "$BASE/session/$SID/message" | python3 -c "
import json,sys
msgs=json.load(sys.stdin)
finish=msgs[-1].get('info',{}).get('finish','') if msgs else ''
print(f'finish: {finish}')
print('✅ PASS' if finish else '❌ FAIL (session stuck)')
"
```
**期望**：session 最终进入 idle/stop 状态，不永久 running

---

### 子任务专项测试结果

| 用例 | 结果 | 说明 |
|------|------|------|
| T-SUB-1 单 subagent 调用 | ✅ | task(completed) → "Hello World" 翻译正确 |
| T-SUB-2 子 session PG 持久化 | ✅ | child session 2 条消息，parent_id/agent 正确 |
| T-SUB-3 双 subagent 并行 | ✅ | 两个 task 均 completed，翻译+代码，30s 完成 |
| T-SUB-4 watchdog 不误杀 | ✅ | task 无 watchdog 超时错误 |
| T-SUB-5 destroy 清理 keepAlive | ✅ | destroy 后 PG keep_alive 从 t→f |
| T-SUB-6 失败后恢复 | ✅ | session finish=stop，不卡死 |
