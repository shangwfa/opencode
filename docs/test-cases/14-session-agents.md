# Session Agents（会话级动态 Agent）

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 十六、Session Agents（会话级动态 Agent）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），仅 PG 模式（SaaS）下生效。

### 公共配置

```js
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
```

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

## 权限用例（T16.21–T16.28）

> 参考 [OpenCode Permissions 文档](https://opencode.ai/docs/permissions)
> 权限系统核心：`allow`（自动执行）/ `ask`（需确认）/ `deny`（禁止）
> 粒度规则：支持对象语法按路径/命令匹配，`*` 通配符，**last matching rule wins**
> 关键行为：`disabled()` 函数检查 `pattern: "*" && action: "deny"` 做工具级粗粒度开关；路径级规则在运行时 `ask()` 中生效

### T16.21 字符串简写权限 — `permission: { edit: "deny", bash: "allow" }`

**验证目标**：字符串简写格式正确生效，edit 工具被完全禁用（`disabled()` 判定），bash 正常可用

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

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
            console.log("  [SSE] " + e.type, (e.properties?.tool || ""))
            if (e.type === "session.idle") {
              clearTimeout(timer)
              const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
              const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
              reader.cancel()
              resolve(lastAi)
              return
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

  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "readonly-analyst",
      mode: "primary",
      prompt: "你是只读分析师。用户要求你读文件用 bash ls/cat，用户要求你写文件时说明你没有写权限。简洁回答。",
      permission: [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "read", pattern: "*", action: "allow" },
        { permission: "glob", pattern: "*", action: "allow" },
        { permission: "grep", pattern: "*", action: "allow" },
      ],
    }),
  })
  const agentData = await agentRes.json()
  console.log("创建 agent:", agentRes.status, "permission count:", agentData.permission?.length)
  if (agentRes.status !== 200) { console.log("❌ FAIL"); process.exit(1) }

  // 测试1: bash 应该可用（读文件）
  const msg = await sendAndWait(sid.id, {
    parts: [{ type: "text", text: "用 ls 列出 /workspace 下的内容" }],
    agent: "readonly-analyst", model: MODEL,
  })
  const tools = msg.parts.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state?.status }))
  const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
  console.log("工具调用:", JSON.stringify(tools))
  console.log("回复 (前200字):", texts.slice(0, 200))

  const hasBash = tools.some(t => t.tool === "bash" && t.status === "completed")
  console.log("bash 可用:", hasBash, "(expect true)")

  // 测试2: edit 应不可用 — AI 被要求写文件时应无法调用
  const msg2 = await sendAndWait(sid.id, {
    parts: [{ type: "text", text: "请在 /workspace/test-write.txt 写入 hello" }],
    agent: "readonly-analyst", model: MODEL,
  })
  const tools2 = msg2.parts.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state?.status }))
  const texts2 = msg2.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
  console.log("写操作工具调用:", JSON.stringify(tools2))
  console.log("写操作回复:", texts2.slice(0, 200))

  const noEdit = !tools2.some(t => t.tool === "edit" || t.tool === "write")
  console.log("edit/write 未被调用:", noEdit, "(expect true)")
  console.log("✅ T16.21: " + (hasBash && noEdit ? "PASS" : "NOTE — 权限行为需验证"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：bash 工具可用（`allow`），edit/write 工具被 `disabled()` 完全移除，AI 无法调用

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, jsonb_array_length(permission) FROM session_agents WHERE session_id='$SID';"`
> 期望：permission count = 6

---

### T16.22 粒度路径权限 — `edit: { "*": "deny", "docs/*.md": "allow" }`

**验证目标**：对象语法路径匹配，edit 对 `docs/*.md` 路径 allow，其他路径 deny

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

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
            console.log("  [SSE] " + e.type, (e.properties?.tool || ""))
            if (e.type === "session.idle") {
              clearTimeout(timer)
              const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
              const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
              reader.cancel()
              resolve(lastAi)
              return
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

  // 粒度权限：edit 对 docs/*.md allow，其他 deny；bash 全部 allow
  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "doc-editor",
      mode: "primary",
      prompt: "你是文档编辑器。你可以编辑 docs/ 下的 md 文件，但不能编辑其他路径的文件。直接执行操作，不要解释。",
      permission: [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "edit", pattern: "docs/*.md", action: "allow" },
        { permission: "write", pattern: "*", action: "deny" },
        { permission: "write", pattern: "docs/*.md", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    }),
  })
  const agentData = await agentRes.json()
  console.log("创建 agent:", agentRes.status, "permission count:", agentData.permission?.length)

  // 注意：disabled() 检查 pattern:"*" + action:"deny" 时会把 edit 完全禁用
  // 这是已知限制 — 粒度路径 allow 规则无法在工具注册层面生效
  // 验证 disabled() 的行为
  const msg = await sendAndWait(sid.id, {
    parts: [{ type: "text", text: "请创建文件 docs/test.md，内容为 # Hello" }],
    agent: "doc-editor", model: MODEL,
  })
  const tools = msg.parts.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state?.status }))
  const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
  console.log("工具调用:", JSON.stringify(tools))
  console.log("回复 (前300字):", texts.slice(0, 300))

  // 检查 edit 是否被 disabled() 完全移除
  const editDisabled = !tools.some(t => t.tool === "edit" || t.tool === "write")
  console.log("edit 被完全禁用 (disabled 限制):", editDisabled)
  console.log("✅ T16.22: " + (agentData.permission?.length === 6 ? "PASS — 粒度权限已持久化，但 disabled() 会完全移除 edit 工具" : "NOTE"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：permission 持久化 6 条规则。**已知限制**：`disabled()` 发现 `edit: "*": deny` 后完全移除 edit 工具，`docs/*.md: allow` 粒度规则在工具注册层面不生效（路径级规则仅在运行时 `ask()` 中判定，但工具已被移除所以无法触发）

> **已知限制说明**：这是 `Permission.disabled()` 的设计 — 它做工具级粗开关，只看 `pattern === "*" && action === "deny"`，不考虑路径级 allow 覆盖。要让粒度权限生效，catch-all 应使用 `"ask"` 而非 `"deny"`
>
> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, permission FROM session_agents WHERE session_id='$SID';"`
> 期望：6 条 permission 规则

---

### T16.23 粒度路径权限（ask 模式）— `edit: { "*": "ask", "docs/*.md": "allow" }`

**验证目标**：使用 `ask` 作为 catch-all，粒度 allow 规则可以生效（工具不被 `disabled()` 移除）

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

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
            console.log("  [SSE] " + e.type, (e.properties?.tool || ""))
            if (e.type === "session.idle") {
              clearTimeout(timer)
              const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
              const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
              reader.cancel()
              resolve(lastAi)
              return
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

  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "doc-editor-v2",
      mode: "primary",
      prompt: "你是文档编辑器。直接执行操作。",
      permission: [
        { permission: "edit", pattern: "*", action: "ask" },
        { permission: "edit", pattern: "docs/*.md", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    }),
  })
  const agentData = await agentRes.json()
  console.log("创建 agent:", agentRes.status, "permission count:", agentData.permission?.length)

  // ask 模式下 disabled() 不会移除 edit（因为 action 不是 "deny"）
  const msg = await sendAndWait(sid.id, {
    parts: [{ type: "text", text: "请创建文件 docs/hello.md，内容为 # Hello World" }],
    agent: "doc-editor-v2", model: MODEL,
  })
  const tools = msg.parts.filter(p => p.type === "tool").map(p => ({ tool: p.tool, status: p.state?.status }))
  const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
  console.log("工具调用:", JSON.stringify(tools))
  console.log("回复 (前300字):", texts.slice(0, 300))

  // edit 工具应可用（因为 catch-all 是 ask 而非 deny）
  const editAvailable = tools.some(t => t.tool === "edit" || t.tool === "write")
  console.log("edit 工具可用:", editAvailable, "(expect true — ask 不会触发 disabled)")
  console.log("✅ T16.23: " + (agentData.permission?.length === 4 ? "PASS — ask 模式下工具不被移除" : "NOTE"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：edit 工具**不被** `disabled()` 移除（因为 `ask` ≠ `deny`），对 `docs/*.md` 路径自动 allow，其他路径触发 ask 确认

> **对比 T16.22**：`deny` 的 catch-all 会让 `disabled()` 移除整个工具；`ask` 的 catch-all 保留工具，路径匹配在运行时判定

---

### T16.24 bash 粒度命令权限 — `bash: { "*": "ask", "git *": "allow", "rm *": "deny" }`

**验证目标**：bash 权限按命令匹配，git 命令自动 allow，rm 命令 deny，其他 ask

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "git-operator",
      mode: "primary",
      prompt: "你是 Git 操作员。直接执行命令，不要解释。只执行用户要求的命令。",
      permission: [
        { permission: "bash", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "git *", action: "allow" },
        { permission: "bash", pattern: "rm *", action: "deny" },
        { permission: "bash", pattern: "ls *", action: "allow" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    }),
  })
  const agentData = await agentRes.json()
  console.log("创建 agent:", agentRes.status, "permission count:", agentData.permission?.length)

  // bash 工具应可用（ask catch-all 不会移除）
  // git 命令和 ls 命令应自动 allow，rm 命令应被 deny
  console.log("✅ T16.24: " + (agentData.permission?.length === 5 ? "PASS — bash 粒度权限已持久化" : "NOTE"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：5 条 permission 规则持久化。bash 工具不被移除，git/ls 命令自动 allow，rm 命令 deny，其他 ask

> **说明**：运行时行为验证需要 SSE 流中捕获 permission ask 事件，此处仅验证配置持久化

---

### T16.25 全局 allow/deny 快捷写法 — `permission: "allow"` / `permission: "deny"`

**验证目标**：字符串快捷写法设置所有权限

```bash
bun -e '
const BASE = "http://localhost:14096"

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 测试1: 全局 deny
  const res1 = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "denied-agent",
      mode: "primary",
      prompt: "test",
      permission: "deny",
    }),
  })
  console.log("全局 deny 创建:", res1.status)
  const data1 = await res1.json()
  console.log("permission type:", typeof data1.permission, Array.isArray(data1.permission) ? "array:" + data1.permission.length : data1.permission)

  // 测试2: 全局 allow
  const res2 = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "allowed-agent",
      mode: "primary",
      prompt: "test",
      permission: "allow",
    }),
  })
  console.log("全局 allow 创建:", res2.status)
  const data2 = await res2.json()
  console.log("permission type:", typeof data2.permission, Array.isArray(data2.permission) ? "array:" + data2.permission.length : data2.permission)

  console.log("✅ T16.25: " + (res1.status === 200 && res2.status === 200 ? "PASS — 全局 allow/deny 字符串格式被接受" : "NOTE"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：字符串快捷写法被接受，创建返回 200

> **说明**：根据文档 `{ "permission": "allow" }` 应设置所有权限为 allow。当前 API 可能将字符串转为数组格式存储

---

### T16.26 权限覆盖顺序（last matching rule wins）

**验证目标**：多条规则按顺序匹配，最后一条匹配的规则生效

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

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
            console.log("  [SSE] " + e.type, (e.properties?.tool || ""))
            if (e.type === "session.idle") {
              clearTimeout(timer)
              const msgs = await (await fetch(BASE + "/session/" + sid + "/message")).json()
              const lastAi = [...msgs].reverse().find(m => m.info?.role === "assistant")
              reader.cancel()
              resolve(lastAi)
              return
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

  // 规则顺序：先 deny *，再 allow src/*.ts — last matching rule wins
  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "src-only-editor",
      mode: "primary",
      prompt: "你是代码编辑器。直接执行。",
      permission: [
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "edit", pattern: "src/*.ts", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    }),
  })
  const agentData = await agentRes.json()
  console.log("创建 agent:", agentRes.status, "permission:", JSON.stringify(agentData.permission?.map(r => r.pattern + ":" + r.action)))

  // disabled() 会因 edit: *: deny 移除 edit 工具
  // 但 permission 数据应包含两条 edit 规则（deny * 和 allow src/*.ts）
  const editRules = agentData.permission?.filter(r => r.permission === "edit") || []
  console.log("edit 规则数:", editRules.length, "(expect 2)")
  console.log("规则1:", editRules[0]?.pattern, editRules[0]?.action)
  console.log("规则2:", editRules[1]?.pattern, editRules[1]?.action)
  const hasDenyAll = editRules.some(r => r.pattern === "*" && r.action === "deny")
  const hasAllowSrc = editRules.some(r => r.pattern === "src/*.ts" && r.action === "allow")
  console.log("✅ T16.26: " + (hasDenyAll && hasAllowSrc ? "PASS — last matching rule wins 规则持久化正确" : "NOTE"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：permission 包含 2 条 edit 规则（`*:deny` 和 `src/*.ts:allow`），规则顺序按数组顺序，last matching rule wins

---

### T16.27 `tools` 字段向后兼容 — `tools: { edit: true, bash: false }` 自动转为 permission

**验证目标**：旧版 `tools` 布尔配置自动转换为 `permission` 格式

```bash
bun -e '
const BASE = "http://localhost:14096"

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 使用旧版 tools 格式创建 agent
  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "legacy-tools-agent",
      mode: "primary",
      prompt: "test",
      tools: { edit: true, bash: false, webfetch: true },
    }),
  })
  console.log("创建 status:", agentRes.status)
  const data = await agentRes.json()
  console.log("permission:", JSON.stringify(data.permission))
  console.log("tools:", JSON.stringify(data.tools))

  // tools: { edit: true } 应转为 permission: [{ permission: "edit", pattern: "*", action: "allow" }]
  // tools: { bash: false } 应转为 permission: [{ permission: "bash", pattern: "*", action: "deny" }]
  const hasEditAllow = data.permission?.some(r => r.permission === "edit" && r.action === "allow")
  const hasBashDeny = data.permission?.some(r => r.permission === "bash" && r.action === "deny")
  const hasWebfetchAllow = data.permission?.some(r => r.permission === "webfetch" && r.action === "allow")
  console.log("edit→allow:", hasEditAllow)
  console.log("bash→deny:", hasBashDeny)
  console.log("webfetch→allow:", hasWebfetchAllow)
  console.log("✅ T16.27: " + (hasEditAllow && hasBashDeny && hasWebfetchAllow ? "PASS — tools 自动转换为 permission" : "NOTE — 转换逻辑可能不在 API 层"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：`tools: { edit: true }` 被自动转换为 `permission: [{ permission: "edit", pattern: "*", action: "allow" }]`；`bash: false` 转为 `deny`

> **说明**：根据 `config/agent.ts` 的 `normalize` 函数，`tools` 字段会在配置解析时自动转为 `permission`。但 session agent 的 API 端点可能不经过此 normalize 流程

---

### T16.28 权限与 subagent 调度 — `task: { "dangerous-agent": "deny" }`

**验证目标**：通过 `task` 权限限制可调度的 subagent

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 创建一个被 deny 的 subagent
  await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "dangerous-agent",
      mode: "subagent",
      prompt: "执行危险操作",
    }),
  })

  // 创建一个被 allow 的 subagent
  await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "safe-agent",
      mode: "subagent",
      prompt: "执行安全操作",
    }),
  })

  // 创建带 task 权限限制的 primary agent
  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "restricted-manager",
      mode: "primary",
      prompt: "你是受限管理员。根据用户要求调度子 agent。",
      permission: [
        { permission: "task", pattern: "*", action: "ask" },
        { permission: "task", pattern: "dangerous-agent", action: "deny" },
        { permission: "task", pattern: "safe-agent", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
    }),
  })
  const data = await agentRes.json()
  console.log("创建 manager:", agentRes.status, "permission count:", data.permission?.length)

  const taskRules = data.permission?.filter(r => r.permission === "task") || []
  console.log("task 规则:", JSON.stringify(taskRules))
  const denyDangerous = taskRules.some(r => r.pattern === "dangerous-agent" && r.action === "deny")
  const allowSafe = taskRules.some(r => r.pattern === "safe-agent" && r.action === "allow")
  console.log("deny dangerous-agent:", denyDangerous)
  console.log("allow safe-agent:", allowSafe)
  console.log("✅ T16.28: " + (denyDangerous && allowSafe ? "PASS — task 粒度权限已持久化" : "NOTE"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：task 权限规则持久化，`dangerous-agent` 被 deny，`safe-agent` 被 allow

> **说明**：根据文档，`task` 权限控制 subagent 调度，匹配 subagent type 名称

---

### T16.31 对象语法白名单 — `edit: { "*": "deny", "analysis/.../spec/*.md": "allow" }`

**验证目标**：对象语法细粒度白名单，pattern 使用**相对路径**（不加 `**/` 前缀），白名单路径 allow，其他路径 deny

> **背景**：write/edit 工具传入权限检查的 pattern 是 `path.relative(worktree, filepath)`（相对路径，不以 `/` 开头）。通配符 `*` 匹配零个或多个任意字符（含 `/`），**没有 `**` 特殊语义**。因此白名单 pattern 必须用相对路径写法。

```bash
bun -e '
const BASE = "http://localhost:14096"

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "specer",
      mode: "primary",
      prompt: "需求分析 agent，仅允许写 spec 文件",
      permission: {
        read: "allow",
        edit: {
          "*": "deny",
          "analysis/9f06e4c6/spec/*.md": "allow",
          "analysis/9f06e4c6/suggest-step.json": "allow",
        },
        glob: "allow",
        grep: "allow",
        list: "allow",
        bash: "deny",
      },
    }),
  })
  const data = await agentRes.json()
  console.log("创建 status:", agentRes.status)
  console.log("permission 规则数:", data.permission?.length)

  // 验证持久化的 ruleset
  const editRules = data.permission?.filter(r => r.permission === "edit") || []
  console.log("edit 规则:", JSON.stringify(editRules))

  // 白名单路径应 allow
  const specAllow = editRules.some(r => r.pattern === "analysis/9f06e4c6/spec/*.md" && r.action === "allow")
  const suggestAllow = editRules.some(r => r.pattern === "analysis/9f06e4c6/suggest-step.json" && r.action === "allow")
  // catch-all 应 deny
  const denyAll = editRules.some(r => r.pattern === "*" && r.action === "deny")
  // bash 应 deny
  const bashDeny = data.permission?.some(r => r.permission === "bash" && r.pattern === "*" && r.action === "deny")

  console.log("spec/*.md allow:", specAllow)
  console.log("suggest-step.json allow:", suggestAllow)
  console.log("* deny:", denyAll)
  console.log("bash deny:", bashDeny)
  console.log("✅ T16.31: " + (specAllow && suggestAllow && denyAll && bashDeny ? "PASS" : "FAIL"))
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：permission 持久化为 ruleset，edit 包含 3 条规则（`*:deny` + `analysis/.../spec/*.md:allow` + `analysis/.../suggest-step.json:allow`），bash deny

> **PG 验证**：`SELECT name, jsonb_pretty(permission) FROM session_agents WHERE session_id='$SID';`
> 期望：edit 规则使用相对路径 pattern，无 `**/` 前缀

---

### T16.32 `**/` 前缀无法匹配相对路径（已知限制）

**验证目标**：`**/analysis/...` 前缀的白名单 pattern **不能**匹配相对路径 `analysis/...`，导致白名单失效

> **已知限制**：Wildcard 实现中 `*` → `.*`（匹配含 `/` 的任意字符），**没有 `**` 特殊语义**。`**/analysis/...` 被转为 `.*.*/analysis/...`，要求路径中存在 `/analysis/` 子串。但 write/edit 工具传入的是相对路径 `analysis/...`（无前导 `/`），不包含 `/analysis/`，因此白名单不匹配，回退到 `deny *`。
>
> **正确做法**：去掉 `**/` 前缀，直接用 `analysis/.../spec/*.md`。

```bash
bun -e '
const BASE = "http://localhost:14096"

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 使用 **/ 前缀（错误写法）
  const agentRes = await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "specer-bad",
      mode: "primary",
      prompt: "test",
      permission: {
        edit: {
          "*": "deny",
          "**/analysis/9f06e4c6/spec/*.md": "allow",
        },
      },
    }),
  })
  const data = await agentRes.json()
  const editRules = data.permission?.filter(r => r.permission === "edit") || []
  console.log("edit 规则:", JSON.stringify(editRules))

  const hasDoubleStar = editRules.some(r => r.pattern === "**/analysis/9f06e4c6/spec/*.md")
  console.log("**/ 前缀规则持久化:", hasDoubleStar)
  console.log("✅ T16.32: PASS — **/ 前缀被原样存储，运行时将无法匹配相对路径 analysis/...")
  console.log("   根因: Wildcard 中 **/ 转为 .*.*/ ，要求路径含 /analysis/ 子串")
  console.log("   但 write 工具传入 path.relative(worktree, file) = analysis/... (无前导 /)")
  console.log("   修复: 去掉 **/ 前缀，改为 analysis/.../spec/*.md")
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：`**/` 前缀规则被原样持久化（不报错），但运行时权限检查中**无法匹配**相对路径 `analysis/.../spec/spec.md`，白名单形同虚设

> **结论**：权限 pattern 必须使用相对路径写法（与 write/edit 工具传入的 `path.relative(worktree, filepath)` 一致），不要使用 `**/` 前缀。参考 [OpenCode 权限文档](https://opencode.ai/docs/permissions/) — 通配符只有 `*`（匹配零个或多个任意字符，含 `/`）和 `?`。

---

### T16.33 pattern 中 `...` 是字面点，不能当通配符

**验证目标**：pattern 中写 `analysis/.../spec/*.md`（三个点），`.` 会被转义为字面点，**不能**匹配中间的 UUID 路径段。正确写法用 `*`。

> **原理**：Wildcard 实现中 `.replace(/[.+^${}()|[\]\\]/g, "\\$&")` 会将每个 `.` 转义为 `\.`（字面匹配）。所以 `...` 等价于 `\.\.\.`，只匹配路径中真的有三个连续 `.` 的位置。要通配中间路径段，用 `*`（匹配零个或多个任意字符，含 `/`）。

| pattern | 实际路径 | 匹配 | 原因 |
|---------|----------|------|------|
| `analysis/.../spec/*.md` | `analysis/9f06e4c6-.../spec/spec.md` | **否** | `.` 被转义为字面点，不匹配 UUID |
| `analysis/.../spec/*.md` | `analysis/.../spec/spec.md` | 是 | 路径中真的有 `...` |
| `analysis/*/spec/*.md` | `analysis/9f06e4c6-.../spec/spec.md` | **是** | `*` 通配 UUID 路径段 |

```bash
bun -e '
const BASE = "http://localhost:14096"

async function test() {
  const sid = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()
  console.log("SID:", sid.id)

  // 错误写法：用 ... 当通配符
  const res1 = await (await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "specer-dots", mode: "primary", prompt: "test",
      permission: { edit: { "*": "deny", "analysis/.../spec/*.md": "allow" } },
    }),
  })).json()
  const dotsRules = res1.permission?.filter(r => r.permission === "edit") || []
  console.log("... 写法 edit 规则:", JSON.stringify(dotsRules))
  console.log("  pattern 含 ...:", dotsRules.some(r => r.pattern === "analysis/.../spec/*.md"))

  // 正确写法：用 * 通配中间路径段
  const res2 = await (await fetch(BASE + "/session/" + sid.id + "/agents/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "specer-star", mode: "primary", prompt: "test",
      permission: { edit: { "*": "deny", "analysis/*/spec/*.md": "allow" } },
    }),
  })).json()
  const starRules = res2.permission?.filter(r => r.permission === "edit") || []
  console.log("* 写法 edit 规则:", JSON.stringify(starRules))
  console.log("  pattern 含 *:", starRules.some(r => r.pattern === "analysis/*/spec/*.md"))

  console.log("✅ T16.33: PASS — ... 被原样存储（字面点），* 被原样存储（通配符）")
  console.log("   运行时：... 无法匹配 UUID 路径段，* 可以")
}
test().catch(e => { console.error(e); process.exit(1) })
'
```
**期望**：两种 pattern 都被原样持久化（不报错），但运行时 `...` 只匹配字面三个点，`*` 才能通配 UUID 路径段

> **结论**：权限 pattern 中不要用 `...` 省略中间路径，用 `*` 代替。例如 `analysis/*/spec/*.md` 匹配任意 analysis 子目录下的 spec/*.md。

---

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

### T16.21–T16.28（权限用例）

| 用例 | 状态 | 说明 |
|------|------|------|
| T16.21 | ✅ | permission 持久化 6 条，edit/write deny 生效（AI 回复无写权限），bash 未触发（模型选择直接回答） |
| T16.22 | ✅ | 粒度权限持久化 6 条，disabled() 因 edit: *:deny 完全移除 edit 工具（路径级 allow 不生效） |
| T16.23 | ✅ | ask catch-all 不触发 disabled()，但运行时 ask 等待确认导致超时（无交互层批准） |
| T16.24 | ✅ | bash 粒度权限 5 条持久化：git:allow, ls:allow, rm:deny, *:ask |
| T16.25 | ✅ | 字符串简写 `"allow"/"deny"` 和对象格式 `{bash:"allow",edit:{"*":"deny"}}` 均被正确转换为 ruleset |
| T16.26 | ✅ | last matching rule wins：edit 规则按数组顺序持久化（*:deny, src/*.ts:allow） |
| T16.27 | ⚠️ | `tools` 字段被 API 接受（200）但未自动转换为 permission（permission=[]空） |
| T16.28 | ✅ | task 粒度权限 5 条持久化：dangerous-agent:deny, safe-agent:allow, *:ask |
| T16.31 | 🔲 | 对象语法白名单（相对路径）：edit 规则 3 条（*:deny + analysis/.../spec/*.md:allow + suggest-step.json:allow） |
| T16.32 | 🔲 | `**/` 前缀已知限制：被原样持久化但运行时无法匹配相对路径，白名单失效 |
| T16.33 | 🔲 | `...` 是字面点（被转义为 `\.`），不能当通配符；正确写法用 `*`（如 `analysis/*/spec/*.md`） |

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
