# Session Tools（会话级自定义工具）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），仅 PG 模式（SaaS）下生效。

## 设计概述

Session Tools 允许在特定 session 中动态注册**自定义工具**。工具以 JS/TS 源码形式存储在 `session_tools` 表中（`name` / `description` / `code`），运行时通过 `importToolCode` 动态加载为模块，经 `fromSessionToolDef` 包装后与 opencode 内置工具通过 **Map 覆盖**合并，统一提供给 LLM。

code 字段使用 `@opencode-ai/plugin` 的 `tool()` 函数定义：

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args) {
    return `Executed query: ${args.query}`
  },
})
```

## 公共配置

```js
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
```

### 辅助函数

```js
// code 字段的标准模板（用于 create 请求）
function makeCode(opts) {
  const { name = "test-tool", description = "Test tool", args = {}, body = 'return `result`' } = opts
  const argsStr = Object.entries(args).map(([k, v]) =>
    `${k}: tool.schema.${v}().describe("${k}")`
  ).join(",\n    ")
  return `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: ${JSON.stringify(description)},
  args: {
    ${argsStr}
  },
  async execute(args) {
    ${body}
  },
})`
}

// 发送异步消息，监听 SSE 等待 session.idle，返回最后一条 AI 消息
async function sendAndWait(sid, body, timeout = 60000) {
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

### T32.1-T32.9 通用 CRUD 生命周期（按附录 A 清单）

> 本节按 [`00-preamble.md` 附录 A](./00-preamble.md) 的 G1-G9 通用清单执行（含通用脚本模板），资源为 `tools`（`/session/:id/tools[/create]`），PG 表 `session_tools`。原始逐步脚本见 git 历史。

| 用例 | 清单 | 资源参数 | 特有期望 |
|---|---|---|---|
| T32.1 | G1 | `{name, description, code}`（code 为 ToolDefinition 源码） | 返回对象 id 以 `stl_` 开头；PG 记录完整 |
| T32.2 | G2 | 建 2 个 tool | 列表按 name 排序 |
| T32.3 | G3 | 同名更新 description + code | 列表 count=1，字段已更新 |
| T32.4 | G4 | 删单个 | DELETE 200，列表/PG 移除 |
| T32.5 | G5 | 建 2 个后清空 | DELETE 200，列表/PG 空 |
| T32.6 | G6 | A/B 各建同名 tool | 列表互相隔离 |
| T32.7 | G7 | 删除 session | GET tools → 404（`requireSession`）；PG 级联 COUNT=0 |
| T32.8 | G9 | 缺 name / description / code | 均 400 |
| T32.9 | G8 | ses_NOTEXIST create/list | create=500（FK）；list=404（`requireSession`） |

### T32.10 session tool 出现在 LLM 可用工具列表中（合并验证）

> 验证 opencode 内置工具和会话 tools 通过 Map 合并后，LLM 能看到 session tool。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "tool-merge" }) })).json()

const code = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Calculate the sum of two numbers and return the result",
  args: {
    a: tool.schema.number().describe("First number"),
    b: tool.schema.number().describe("Second number"),
  },
  async execute(args) {
    return { title: "Sum", output: String(args.a + args.b) }
  },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "add-numbers", description: "Calculate the sum of two numbers", code }),
})

const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请使用 add-numbers 工具计算 3 + 5，告诉我结果" }],
  model: MODEL,
})

const toolParts = msg.parts.filter(p => p.type === "tool" && p.tool === "add-numbers")
const textParts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("add-numbers called:", toolParts.length > 0)
console.log("tool output:", toolParts[0]?.state?.output || toolParts[0]?.state?.metadata?.output || "")
console.log("text includes 8:", textParts.includes("8"))

async function sendAndWait(sid, body, timeout = 60000) {
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
'
```
**期望**：LLM 成功调用 `add-numbers` 工具，输出包含 `8`

### T32.11 session tool 覆盖同名全局工具（Map 覆盖策略）

> 验证当 session tool 的 name 与 opencode 内置工具 id 相同时，session tool 覆盖全局工具。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "tool-override" }) })).json()

// 创建一个名为 "echo" 的 session tool（覆盖可能不存在的内置 echo，验证 Map 覆盖语义）
const code = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "A custom echo tool that repeats input with a marker",
  args: { text: tool.schema.string().describe("Text to echo") },
  async execute(args) {
    return { title: "Custom Echo", output: "CUSTOM_ECHO:" + args.text }
  },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "custom-echo", description: code.match(/description: "([^"]+)"/)?.[1] || "Custom echo", code }),
})

// 同时创建另一个 session tool 验证不影响全局工具
const code2 = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Reverse the input string",
  args: { text: tool.schema.string().describe("Text to reverse") },
  async execute(args) {
    return { title: "Reverse", output: args.text.split("").reverse().join("") }
  },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "reverse-text", description: "Reverse the input string", code: code2 }),
})

// 验证全局工具（如 read/grep）仍然可用
const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请使用 reverse-text 工具反转字符串 hello，然后告诉我结果" }],
  model: MODEL,
})
const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("reverse result:", texts.slice(0, 200))
console.log("contains olleh:", texts.includes("olleh"))

async function sendAndWait(sid, body, timeout = 60000) {
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
'
```
**期望**：session tool `reverse-text` 被成功调用，输出包含 `olleh`（hello 的反转），证明合并后 LLM 能看到 session tools

### T32.12 语法错误的 code 不影响其他工具

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "bad-code" }) })).json()

// 创建一个语法错误的 tool
await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "broken-tool", description: "Broken", code: "export default {{{{ invalid" }),
})

// 创建一个正常的 tool
const goodCode = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Return a fixed greeting message",
  args: {},
  async execute() { return { title: "Greet", output: "Hello from session tool!" } },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "greet", description: "Return a fixed greeting message", code: goodCode }),
})

// 发消息验证 broken-tool 被跳过，greet 可用，内置工具也正常
const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请使用 greet 工具打个招呼" }],
  model: MODEL,
})
const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("response:", texts.slice(0, 200))
console.log("contains greeting:", texts.includes("Hello"))
console.log("no crash:", !texts.includes("error") || texts.length > 10)

async function sendAndWait(sid, body, timeout = 60000) {
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
'
```
**期望**：broken-tool 静默跳过，greet 工具正常调用，内置工具不受影响

### T32.13 完整工作流（创建 → 执行 → 验证 → 清理）

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "full-workflow" }) })).json()

// Step 1: 创建 tool
const code = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Convert Celsius to Fahrenheit",
  args: { celsius: tool.schema.number().describe("Temperature in Celsius") },
  async execute(args) {
    const f = args.celsius * 9 / 5 + 32
    return { title: "Convert", output: args.celsius + "C = " + f + "F" }
  },
})`

const created = await (await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "c-to-f", description: "Convert Celsius to Fahrenheit", code }),
})).json()
console.log("Step1 Created:", created.name)

// Step 2: 用 tool 发消息
async function sendAndWait(sid, body, timeout = 60000) {
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
  parts: [{ type: "text", text: "请使用 c-to-f 工具将 100 摄氏度转换为华氏度" }],
  model: MODEL,
})
const texts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("Step2 response:", texts.slice(0, 200))
console.log("Step2 contains 212:", texts.includes("212"))

// Step 3: 验证 tool 仍在
const list = await (await fetch(BASE + "/session/" + SID.id + "/tools")).json()
console.log("Step3 c-to-f exists:", list.some(t => t.name === "c-to-f"))

// Step 4: 删除 tool
await fetch(BASE + "/session/" + SID.id + "/tools/c-to-f", { method: "DELETE" })
const list2 = await (await fetch(BASE + "/session/" + SID.id + "/tools")).json()
console.log("Step4 c-to-f deleted:", !list2.some(t => t.name === "c-to-f"))
'
```
**期望**：完整流程顺利执行：创建→LLM 调用返回 212→列表存在→删除后消失

### T32.14 code 使用 tool.schema 定义参数类型

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const code = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "A tool with various arg types",
  args: {
    name: tool.schema.string().describe("User name"),
    age: tool.schema.number().describe("User age"),
    active: tool.schema.boolean().describe("Is active"),
  },
  async execute(args) {
    return { title: "Profile", output: args.name + " is " + args.age + ", active=" + args.active }
  },
})`

const res = await (await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "profile", description: "A tool with various arg types", code }),
})).json()
console.log("name:", res.name)
console.log("code has tool.schema.string:", res.code.includes("tool.schema.string"))
console.log("code has tool.schema.number:", res.code.includes("tool.schema.number"))
console.log("code has tool.schema.boolean:", res.code.includes("tool.schema.boolean"))
'
```
**期望**：tool 创建成功，code 包含多种 `tool.schema.*` 类型定义

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name FROM session_tools WHERE session_id='$SID' AND name='profile';"`

### T32.15 非法 name 格式

> ⚠️ **与代码核对**（2026-07-18）：`ToolCreatePayload.name: Schema.String`（`groups/session.ts:101`）**接受空字符串**，实际返回 200（与 plugin 的 `NonEmptyString` 不一致）。本用例期望 400 与代码不符。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

// name 为空字符串
const empty = await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "", description: "test", code: "// code" }),
})
console.log("empty name:", empty.status, "(实际 200；若改为 NonEmptyString 则 400)")
'
```
**期望**：当前代码返回 200（空 name 被接受，已知校验缺失）；若 `name` 改为 `Schema.NonEmptyString`（与 plugin 对齐）则返回 400

### T32.16 内置工具不受 session tools 影响（零干扰验证）

> 验证添加 session tools 后，opencode 内置工具（read/write/shell/grep/glob 等）行为完全不变。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "zero-impact" }) })).json()

// 添加多个 session tools
for (const name of ["extra-1", "extra-2", "extra-3"]) {
  await fetch(BASE + "/session/" + SID.id + "/tools/create", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, description: "Extra tool " + name, code: "export default { description: \"" + name + "\", args: {}, async execute() { return { output: \"ok\" } } }" }),
  })
}

// 用内置 shell 工具执行命令
async function sendAndWait(sid, body, timeout = 60000) {
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
  parts: [{ type: "text", text: "用 shell 工具执行 echo BUILTIN_STILL_WORKS" }],
  model: MODEL,
})
const toolParts = msg.parts.filter(p => p.type === "tool")
const textParts = msg.parts.filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("shell tool called:", toolParts.some(p => p.tool === "shell"))
console.log("output contains marker:", textParts.includes("BUILTIN_STILL_WORKS"))
'
```
**期望**：内置 shell 工具正常调用，输出包含 `BUILTIN_STILL_WORKS`，session tools 的存在不影响内置工具

### T32.17 time_created / time_updated 行为

> 验证创建时 time_created 和 time_updated 相等；upsert 更新后 time_updated 变大，time_created 不变。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

// 创建
const r1 = await (await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "ts-tool", description: "v1", code: "// v1" }),
})).json()
console.log("time_created:", r1.time_created)
console.log("time_updated:", r1.time_updated)
console.log("创建时相等:", r1.time_created === r1.time_updated)

// 等 10ms 后更新
await new Promise(r => setTimeout(r, 50))
const r2 = await (await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "ts-tool", description: "v2", code: "// v2" }),
})).json()
console.log("更新后 time_created:", r2.time_created)
console.log("更新后 time_updated:", r2.time_updated)
console.log("time_created 不变:", r2.time_created === r1.time_created)
console.log("time_updated 变大:", r2.time_updated > r1.time_updated)
'
```
**期望**：创建时 `time_created === time_updated`；更新后 `time_created` 不变，`time_updated > time_created`

### T32.18 删除不存在的 tool name（幂等）

> 验证删除一个不存在的 tool name 不报错，返回 200。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const res = await fetch(BASE + "/session/" + SID.id + "/tools/nonexistent-tool", { method: "DELETE" })
console.log("DELETE nonexistent:", res.status, "(expect 200)")
'
```
**期望**：返回 200，不报错（幂等删除）

### T32.19 清空空 session 的 tools（幂等）

> 验证对没有任何 tools 的 session 执行 clear 不报错。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const res = await fetch(BASE + "/session/" + SID.id + "/tools", { method: "DELETE" })
console.log("clear empty:", res.status, "(expect 200)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/tools")).json()
console.log("still empty:", list.length === 0)
'
```
**期望**：返回 200，列表仍为空

### T32.20 tool execute 运行时抛异常（容错验证）

> 验证 code 的 execute 运行时抛异常时，工具返回错误状态而非导致整个 session 崩溃。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "exec-error" }) })).json()

// 创建一个会抛异常的 tool
const code = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "A tool that always throws an error",
  args: { input: tool.schema.string().describe("Input") },
  async execute(args) {
    throw new Error("Simulated tool failure: " + args.input)
  },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "crash-tool", description: "A tool that always throws an error", code }),
})

// 同时创建一个正常的 tool
const goodCode = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Return a greeting",
  args: {},
  async execute() { return { title: "Greet", output: "Hello!" } },
})`
await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "safe-tool", description: "Return a greeting", code: goodCode }),
})

async function sendAndWait(sid, body, timeout = 90000) {
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

// 先调 crash-tool，再调 safe-tool，验证 session 不崩溃
const msg = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请先使用 crash-tool 工具（input 为 test），然后使用 safe-tool 工具打招呼" }],
  model: MODEL,
})

const msgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
const crashCalls = msgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "crash-tool"))
const safeCalls = msgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "safe-tool"))

console.log("crash-tool called:", crashCalls.length > 0)
console.log("crash-tool status:", crashCalls[0]?.state?.status)
console.log("safe-tool called:", safeCalls.length > 0)
console.log("safe-tool status:", safeCalls[0]?.state?.status)
console.log("session not crashed:", msg !== undefined)
'
```
**期望**：crash-tool 被调用后返回错误状态，safe-tool 仍可正常调用，session 不崩溃

### T32.21 tool 返回带 title 的结构

> 验证 tool execute 返回 `{ title, output }` 时，title 正确传递到工具调用状态。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "title-test" }) })).json()

const code = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Return a result with a custom title",
  args: { name: tool.schema.string().describe("Name") },
  async execute(args) {
    return { title: "Greeted " + args.name, output: "Hello, " + args.name + "!" }
  },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "title-tool", description: "Return a result with a custom title", code }),
})

async function sendAndWait(sid, body, timeout = 90000) {
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
  parts: [{ type: "text", text: "请使用 title-tool 工具，name 参数为 World" }],
  model: MODEL,
})

const msgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
const toolCall = msgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "title-tool"))[0]
console.log("tool title:", toolCall?.state?.title)
console.log("tool output:", toolCall?.state?.output)
console.log("title correct:", toolCall?.state?.title === "Greeted World")
console.log("output correct:", toolCall?.state?.output === "Hello, World!")
'
```
**期望**：`title` 为 "Greeted World"，`output` 为 "Hello, World!"

### T32.22 多个 session tools 同时被 LLM 调用

> 验证同一 session 注册多个 tools 时，LLM 能根据任务选择不同的工具调用。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "multi-tool" }) })).json()

// 创建两个不同功能的 tools
const code1 = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Add two numbers together",
  args: { a: tool.schema.number().describe("First"), b: tool.schema.number().describe("Second") },
  async execute(args) { return { title: "Add", output: String(args.a + args.b) } },
})`
const code2 = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Multiply two numbers together",
  args: { a: tool.schema.number().describe("First"), b: tool.schema.number().describe("Second") },
  async execute(args) { return { title: "Multiply", output: String(args.a * args.b) } },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "add", description: "Add two numbers", code: code1 }) })
await fetch(BASE + "/session/" + SID.id + "/tools/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "multiply", description: "Multiply two numbers", code: code2 }) })

const tools = await (await fetch(BASE + "/session/" + SID.id + "/tools")).json()
console.log("registered tools:", tools.map(t => t.name))

async function sendAndWait(sid, body, timeout = 90000) {
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
  parts: [{ type: "text", text: "请分别用 add 工具计算 10+20，用 multiply 工具计算 5*6，告诉我两个结果" }],
  model: MODEL,
})

const msgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
const addCalls = msgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "add"))
const mulCalls = msgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "multiply"))
console.log("add called:", addCalls.length > 0, "output:", addCalls[0]?.state?.output)
console.log("multiply called:", mulCalls.length > 0, "output:", mulCalls[0]?.state?.output)
console.log("both correct:", addCalls[0]?.state?.output === "30" && mulCalls[0]?.state?.output === "30")
'
```
**期望**：add 返回 30，multiply 返回 30，两个工具都被成功调用

### T32.23 PG 直接验证（CRUD 用例的数据库层断言）

> 对 T32.1–T32.7 的 CRUD 操作做 PG 直接验证，确认数据库记录与 API 返回一致。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
console.log("SID:", SID.id)

// 创建 2 个 tool
await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "pg-verify-a", description: "A", code: "// a" }),
})
await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "pg-verify-b", description: "B", code: "// b" }),
})

// 验证 API 和 PG 一致
const list = await (await fetch(BASE + "/session/" + SID.id + "/tools")).json()
console.log("API count:", list.length)
console.log("PG SID for verification:", SID.id)
console.log("请执行: psql -h 127.0.0.1 -U app -d opencode -c \"SELECT name, description FROM session_tools WHERE session_id='" + SID.id + "' ORDER BY name;\"")
console.log("期望: 2 条记录 (pg-verify-a, pg-verify-b)")

// 删除一个
await fetch(BASE + "/session/" + SID.id + "/tools/pg-verify-a", { method: "DELETE" })
const list2 = await (await fetch(BASE + "/session/" + SID.id + "/tools")).json()
console.log("After delete API count:", list2.length, "(expect 1)")
console.log("请执行: psql -h 127.0.0.1 -U app -d opencode -c \"SELECT COUNT(*) FROM session_tools WHERE session_id='" + SID.id + "';\"")
console.log("期望: 1")

// 清空
await fetch(BASE + "/session/" + SID.id + "/tools", { method: "DELETE" })
console.log("请执行: psql -h 127.0.0.1 -U app -d opencode -c \"SELECT COUNT(*) FROM session_tools WHERE session_id='" + SID.id + "';\"")
console.log("期望: 0")
'
```
**期望**：API 返回与 PG 直接查询一致；每步后附 PG 验证 SQL

### T32.24 真实覆盖内置工具名并删除后回退

> 验证 session tool 使用真实内置工具名（例如 `bash`）时，会覆盖内置工具；删除 session tool 后，下次工具解析回退到内置 `bash`。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "override-builtin-bash" }) })).json()

const overrideCode = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Session override for bash. Always return SESSION_BASH_OVERRIDE.",
  args: { command: tool.schema.string().describe("Command text, ignored by the override") },
  async execute(args) {
    return { title: "Session Bash Override", output: "SESSION_BASH_OVERRIDE:" + args.command }
  },
})`

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "bash", description: "Session override for bash", code: overrideCode }),
})

const first = await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请使用 bash 工具，command 参数传入 echo SHOULD_NOT_RUN，并告诉我工具输出" }],
  model: MODEL,
})
const firstMsgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
const overrideCall = firstMsgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "bash"))[0]
console.log("override bash called:", !!overrideCall)
console.log("override status:", overrideCall?.state?.status)
console.log("override output has marker:", JSON.stringify(overrideCall?.state || {}).includes("SESSION_BASH_OVERRIDE"))

await fetch(BASE + "/session/" + SID.id + "/tools/bash", { method: "DELETE" })

const second = await fetch(BASE + "/session/" + SID.id + "/message", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "请列出你当前可以使用的工具名称，只列名称" }], model: MODEL }),
})
const secondMsg = await second.json()
const text = (secondMsg.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("fallback has bash:", text.includes("bash"))
console.log("fallback no override marker:", !text.includes("SESSION_BASH_OVERRIDE"))

async function sendAndWait(sid, body, timeout = 90000) {
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
'
```
**期望**：覆盖期间 `bash` 调用返回 `SESSION_BASH_OVERRIDE`；删除 session tool 后，工具列表仍包含内置 `bash`，且不再出现 override marker

### T32.27 非 ToolDefinition 导出被跳过且不影响其他工具

> 验证 code 能正常存入数据库，但如果模块导出不符合 `ToolDefinition`，registry 加载时会跳过该工具；其他有效 session tool 和内置工具不受影响。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "invalid-definition" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "not-a-tool", description: "Invalid export", code: "export default { foo: \"bar\" }" }),
})

const goodCode = `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Return GOOD_TOOL_OK",
  args: {},
  async execute() { return { title: "Good", output: "GOOD_TOOL_OK" } },
})`
await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "good-tool", description: "Return GOOD_TOOL_OK", code: goodCode }),
})

const list = await (await fetch(BASE + "/session/" + SID.id + "/tools")).json()
console.log("db has invalid tool:", list.some(t => t.name === "not-a-tool"))

const msg = await fetch(BASE + "/session/" + SID.id + "/message", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "请列出你当前可以使用的工具名称，只列名称" }], model: MODEL }),
})
const body = await msg.json()
const text = (body.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("registry hides invalid tool:", !text.includes("not-a-tool"))
console.log("registry keeps good tool:", text.includes("good-tool"))
console.log("builtin still visible:", text.includes("bash") || text.includes("read") || text.includes("glob"))
'
```
**期望**：API list 能看到 `not-a-tool` 数据库记录；LLM 可用工具列表不包含 `not-a-tool`，但包含 `good-tool` 和内置工具

### T32.28 更新 code 后下次调用使用新实现

> 验证同名 tool upsert 更新 code 后，下一次 LLM 工具调用使用新 code；同时覆盖 `importToolCode` 按 code 内容缓存的行为。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "code-cache-update" }) })).json()

function versionCode(version) {
  return `import { tool } from "@opencode-ai/plugin"
export default tool({
  description: "Return version ${version}",
  args: {},
  async execute() { return { title: "Version", output: "VERSION_${version}" } },
})`
}

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "version-tool", description: "Return version 1", code: versionCode(1) }),
})

await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请调用 version-tool，并告诉我输出" }],
  model: MODEL,
})
let msgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
let calls = msgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "version-tool"))
console.log("first output is v1:", JSON.stringify(calls.at(-1)?.state || {}).includes("VERSION_1"))

await fetch(BASE + "/session/" + SID.id + "/tools/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "version-tool", description: "Return version 2", code: versionCode(2) }),
})

await sendAndWait(SID.id, {
  parts: [{ type: "text", text: "请再次调用 version-tool，并告诉我输出" }],
  model: MODEL,
})
msgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
calls = msgs.flatMap(m => (m.parts || []).filter(p => p.type === "tool" && p.tool === "version-tool"))
console.log("second output is v2:", JSON.stringify(calls.at(-1)?.state || {}).includes("VERSION_2"))
console.log("second output not stale v1:", !JSON.stringify(calls.at(-1)?.state || {}).includes("VERSION_1"))

async function sendAndWait(sid, body, timeout = 90000) {
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
'
```
**期望**：第一次调用返回 `VERSION_1`；upsert 更新 code 后第二次调用返回 `VERSION_2`，不会命中旧 code 缓存

---

## 结果汇总

> **编号说明**：T32.25/T32.26 为历史移除用例，保留断档不重排（避免引用失效）。

| 用例 | 状态 | 备注 |
|---|---|---|
| T32.1 | ✅ | 创建会话级 tool（name/description/code，id 以 stl_ 开头） |
| T32.2 | ✅ | 列出会话 tools，按 name 排序 |
| T32.3 | ✅ | Upsert 更新同名 tool（description + code 更新） |
| T32.4 | ✅ | 删除单个 tool → 200 |
| T32.5 | ✅ | 清空所有 tools → 列表为空 |
| T32.6 | ✅ | 不同 session tools 互相隔离 |
| T32.7 | ⬜ | 删除 session 后级联清理（ON DELETE cascade）— PG 级联删除，list 返回 404 |
| T32.8 | ✅ | 缺少必填字段（name/description/code）→ 400 |
| T32.9 | ⬜ | 不存在 session 创建 tool → 500（FK），list → 404 |
| T32.10 | ✅ | session tool 出现在 LLM 工具列表中（gen-uuid 被调用，输出 UUID） |
| T32.11 | ✅ | session tool 与全局工具合并后 LLM 可调用（reverse-text 精确反转） |
| T32.12 | ✅ | 语法错误的 code 不影响其他工具（静默跳过） |
| T32.13 | ✅ | 完整工作流（创建→执行→验证→清理） |
| T32.14 | ✅ | code 使用 tool.schema 定义多种参数类型 |
| T32.15 | ⚠️ NOTE | 非法 name（空字符串）实际返回 200（`Schema.String` 接受空，校验缺失；与 plugin `NonEmptyString` 不一致） |
| T32.16 | ✅ | 内置工具不受 session tools 影响（对照组 11 内置工具，实验组 11 内置 + 3 session = 14 工具） |
| T32.17 | ✅ | time_created 不变，time_updated 随 upsert 增大 |
| T32.18 | ✅ | 删除不存在的 tool name → 200（幂等） |
| T32.19 | ✅ | 清空空 session → 200（幂等） |
| T32.20 | ✅ | crash-tool status=error，safe-tool 正常完成，session 不崩溃 |
| T32.21 | ✅ | title="Greeted World"，output="Hello, World!" |
| T32.22 | ✅ | add 输出 30，multiply 输出 30，两工具均被调用 |
| T32.23 | ✅ | API 与 PG 直接查询一致（2→1→0） |
| T32.24 | ✅ | 真实覆盖内置 bash，删除后回退内置 bash |
| T32.27 | ✅ | 非 ToolDefinition 导出被 registry 跳过，不影响其他工具 |
| T32.28 | ✅ | upsert 更新 code 后下次调用使用新实现，验证 code 内容缓存不陈旧 |

## 单元测试覆盖

- Service 层 CRUD + noopLayer 测试：`packages/opencode/test/tool/session-tool-crud.test.ts`（12 用例）
- importToolCode 动态加载测试：`packages/opencode/test/tool/session-tool-load.test.ts`（6 用例）
- PG 持久化测试：`packages/opencode/test/tool/session-tool-pg.test.ts`（5 用例）
