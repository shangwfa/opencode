# Session Commands（会话级自定义命令）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），仅 PG 模式（SaaS）下生效。

## 设计概述

Session Commands 允许在特定 session 中动态注册**自定义命令**。命令以 `name` / `template` / `description` / `agent` / `model` / `subtask` / `hints` 形式存储在 `session_commands` 表中，运行时通过 `Command.Service` 的 `sessionList` / `sessionGet` 与 instance 级命令（内置 `init`/`review`、config `command.*`、MCP prompts、skills）**overlay 合并**：session 命令覆盖同名 instance 命令，独有项追加到列表末尾。

template 支持 `$ARGUMENTS`（全部参数）、`$1`/`$2`/…（位置参数，最后一个位置参数吸收剩余参数）。

## 公共配置

```js
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
```

### 辅助函数

```js
// 发送 command 执行请求，返回 AI 消息
async function runCommand(sid, command, args = "", timeout = 60000) {
  const res = await fetch(BASE + "/session/" + sid + "/command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, arguments: args }),
    signal: AbortSignal.timeout(timeout),
  })
  return await res.json()
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

### T33.1-T33.9 通用 CRUD 生命周期（按附录 A 清单）

> 本节按 [`00-preamble.md` 附录 A](./00-preamble.md) 的 G1-G9 通用清单执行（含通用脚本模板），资源为 `commands`（`/session/:id/commands[/create]`），PG 表 `session_commands`。原始逐步脚本见 git 历史。

| 用例 | 清单 | 资源参数 | 特有期望 |
|---|---|---|---|
| T33.1 | G1 | `{name, template}`（可含 `$ARGUMENTS`/占位符） | 返回对象字段完整；PG 一致 |
| T33.2 | G2 | 建 session command | 与 instance 级命令合并列表，同名时 session 在前 |
| T33.3 | G3 | 同名更新 template | 列表 count=1，template 已更新 |
| T33.4 | G4 | 删单个 | DELETE 200，列表/PG 移除 |
| T33.5 | G5 | 建 2 个后清空 | DELETE 200，session 项清空、instance 项保留 |
| T33.6 | G6 | A/B 各建同名 command | 列表互相隔离 |
| T33.7 | G7 | 删除 session | GET commands → 404（`requireSession`）；PG 级联 COUNT=0 |
| T33.8 | G9 | 缺 name / template | 均 400 |
| T33.9 | G8 | ses_NOTEXIST create/list | create=500（FK）；list=404（`requireSession`）。**实测（2026-08-01）**：create 也返回 404（`requireSession` 统一校验），非 FK 500——实现已改进为统一 session 存在性校验 |

### T33.10 session command 覆盖同名 instance 命令（overlay 合并）

> 验证 session command 与 instance 级 config 命令同名时，session 版本覆盖 instance 版本，且列表中不出现重复。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "overlay-test" }) })).json()

// 创建同名 command（使用 instance 级已有的名字，如 init）
await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "init", template: "SESSION OVERRIDE", description: "Overridden by session" }),
})

const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
const inits = list.filter(c => c.name === "init")
console.log("init count:", inits.length, "(expect 1, no duplicate)")
console.log("init description:", inits[0]?.description, "(expect Overridden by session)")
console.log("init template:", inits[0]?.template, "(expect SESSION OVERRIDE)")
'
```
**期望**：`init` 只有 1 条（不重复），description/template 为 session 版本

> **PG 验证**：`psql -h 127.0.0.1 -U app -d opencode -c "SELECT description, template FROM session_commands WHERE session_id='$SID' AND name='init';"`
> 期望：description=Overridden by session, template=SESSION OVERRIDE

### T33.11 删除覆盖后恢复原 instance 命令

> 验证删除 session 级覆盖命令后，instance 级原命令恢复。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "fallback-test" }) })).json()

// 记录原始 init description
const initial = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
const origInit = initial.find(c => c.name === "init")
console.log("original init desc:", origInit?.description?.slice(0, 30))

// 覆盖 init
await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "init", template: "OVERRIDE", description: "TEMP" }),
})
const overridden = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("overridden desc:", overridden.find(c => c.name === "init")?.description)

// 删除覆盖
await fetch(BASE + "/session/" + SID.id + "/commands/init", { method: "DELETE" })
const restored = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
const restoredInit = restored.find(c => c.name === "init")
console.log("restored desc:", restoredInit?.description?.slice(0, 30))
console.log("restored matches original:", restoredInit?.description === origInit?.description)
'
```
**期望**：覆盖后 description=TEMP，删除覆盖后恢复原始 description

> **PG 验证**：`psql -h 127.0.0.1 -U app -d opencode -t -A -c "SELECT COUNT(*) FROM session_commands WHERE session_id='$SID' AND name='init';"`
> 期望：COUNT=0（session 级 init 已删除，instance 级 init 不在此表）

### T33.12 hints 自动推导

> 验证 template 中 `$ARGUMENTS` / `$1` / `$2` 占位符自动推导为 hints。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

// $ARGUMENTS
const r1 = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "h-args", template: "Process $ARGUMENTS" }),
})).json()
console.log("$ARGUMENTS hints:", JSON.stringify(r1.hints), "(expect [\"$ARGUMENTS\"])")

// 位置参数
const r2 = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "h-pos", template: "Create $1 in $2" }),
})).json()
console.log("$1 $2 hints:", JSON.stringify(r2.hints), "(expect [\"$1\",\"$2\"])")

// 无占位符
const r3 = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "h-none", template: "No placeholders here" }),
})).json()
console.log("no placeholder hints:", JSON.stringify(r3.hints), "(expect [])")
'
```
**期望**：`$ARGUMENTS` → `["$ARGUMENTS"]`；`$1 $2` → `["$1","$2"]`；无占位符 → `[]`

### T33.13 显式 hints 优先于自动推导

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const res = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "explicit-hints", template: "Uses $1 and $ARGUMENTS", hints: ["custom"] }),
})).json()
console.log("hints:", JSON.stringify(res.hints), "(expect [\"custom\"])")
'
```
**期望**：显式传入 `hints: ["custom"]` 时不自动推导

### T33.14 命令执行（模板替换）

> 验证通过 `POST /session/:id/command` 执行 session command，`$ARGUMENTS` 替换为全部参数，`$1` 取第一个参数，`$2`（last position）吸收剩余参数。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "cmd-exec" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "echo-cmd", template: "Respond with exactly this text and nothing else: FIRST=$1 REST=$2 ALL=$ARGUMENTS" }),
})

const result = await (await fetch(BASE + "/session/" + SID.id + "/command", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "echo-cmd", arguments: "alpha beta gamma" }),
})).json()
const text = (result.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("response:", text.slice(0, 200))
console.log("FIRST=alpha:", text.includes("FIRST=alpha"))
console.log("REST=beta gamma:", text.includes("REST=beta gamma"))
console.log("ALL=alpha beta gamma:", text.includes("ALL=alpha beta gamma"))
'
```
**期望**：`$1`→alpha，`$2`→"beta gamma"（last position 吸收剩余），`$ARGUMENTS`→"alpha beta gamma"

### T33.15 不存在的命令 → Command not found

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const res = await fetch(BASE + "/session/" + SID.id + "/command", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "no-such-cmd", arguments: "" }),
})
console.log("status:", res.status, "(expect 500)")
const body = await res.json()
console.log("error name:", body.name)
'
```
**期望**：返回 500 UnknownError（内部为 `Command not found: "no-such-cmd"`，附可用命令列表提示）

### T33.16 time_created / time_updated 行为

> 验证创建时 time_created ≈ time_updated；upsert 更新后 time_updated 变大，time_created 不变。API 不返回时间戳，需 PG 验证。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "ts-cmd", template: "v1" }),
})
console.log("SID:", SID.id)
console.log("请执行 PG 查询查看 time_created / time_updated")

await new Promise(r => setTimeout(r, 50))

await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "ts-cmd", template: "v2" }),
})
console.log("请再次执行 PG 查询对比时间戳")
'
```
> **PG 验证**：
> ```sql
> -- 第一次（创建后）
> psql -h 127.0.0.1 -U app -d opencode -c "SELECT time_created, time_updated FROM session_commands WHERE session_id='$SID' AND name='ts-cmd';"
> -- 期望：time_created ≈ time_updated
>
> -- 第二次（upsert 后）
> psql -h 127.0.0.1 -U app -d opencode -c "SELECT time_created, time_updated FROM session_commands WHERE session_id='$SID' AND name='ts-cmd';"
> -- 期望：time_created 不变，time_updated > time_created
> ```

### T33.17 删除不存在的 command name（幂等）

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const res = await fetch(BASE + "/session/" + SID.id + "/commands/nonexistent", { method: "DELETE" })
console.log("DELETE nonexistent:", res.status, "(expect 200)")
'
```
**期望**：返回 200，不报错（幂等删除）

### T33.18 清空空 session 的 commands（幂等）

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()

const res = await fetch(BASE + "/session/" + SID.id + "/commands", { method: "DELETE" })
console.log("clear empty:", res.status, "(expect 200)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("still has init:", list.some(c => c.name === "init"))
'
```
**期望**：返回 200，不报错；清空后内置命令仍在（只清 session 级）

### T33.19 PG 直接验证（CRUD 用例的数据库层断言）

> 对 CRUD 操作做 PG 直接验证，确认数据库记录与 API 返回一致。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) })).json()
console.log("SID:", SID.id)

// 创建 2 个 command
await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "pg-a", template: "A", description: "Alpha", agent: "build", subtask: true }),
})
await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "pg-b", template: "B with $ARGUMENTS" }),
})

console.log("请执行:")
console.log("psql -h 127.0.0.1 -U app -d opencode -c \"SELECT name, description, agent, subtask, hints::text FROM session_commands WHERE session_id='" + SID.id + "' ORDER BY name;\"")
console.log("期望: 2 条记录, pg-a (desc=Alpha,agent=build,subtask=true), pg-b (hints 含 $ARGUMENTS)")

// 删除一个
await fetch(BASE + "/session/" + SID.id + "/commands/pg-a", { method: "DELETE" })
console.log("请执行: psql ... \"SELECT COUNT(*) FROM session_commands WHERE session_id='" + SID.id + "';\"")
console.log("期望: 1")

// 清空
await fetch(BASE + "/session/" + SID.id + "/commands", { method: "DELETE" })
console.log("请执行: psql ... \"SELECT COUNT(*) FROM session_commands WHERE session_id='" + SID.id + "';\"")
console.log("期望: 0")
'
```
**期望**：API 返回与 PG 直接查询一致；每步后附 PG 验证 SQL

### T33.20 完整工作流（创建 → 执行 → 验证 → 清理）

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "cmd-full-workflow" }) })).json()

// Step 1: 创建 command
const created = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "greet", template: "Respond with exactly: Hello $ARGUMENTS! and nothing else.", description: "Greet someone" }),
})).json()
console.log("Step1 created:", created.name, "hints:", JSON.stringify(created.hints))

// Step 2: 执行 command
const result = await (await fetch(BASE + "/session/" + SID.id + "/command", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "greet", arguments: "World" }),
})).json()
const text = (result.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("Step2 response:", text.slice(0, 100))
console.log("Step2 contains Hello World:", text.includes("Hello") && text.includes("World"))

// Step 3: 验证 command 仍在列表中
const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("Step3 greet exists:", list.some(c => c.name === "greet"))

// Step 4: 删除 command
await fetch(BASE + "/session/" + SID.id + "/commands/greet", { method: "DELETE" })
const list2 = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("Step4 greet deleted:", !list2.some(c => c.name === "greet"))

// Step 5: 执行已删除的 command 应报 not found
const errRes = await fetch(BASE + "/session/" + SID.id + "/command", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "greet", arguments: "test" }),
})
console.log("Step5 deleted cmd status:", errRes.status, "(expect 500)")

// 清理
await fetch(BASE + "/session/" + SID.id, { method: "DELETE" })
'
```
**期望**：完整流程：创建→执行返回 "Hello World"→列表存在→删除后消失→再执行报 not found

### T33.21 清空后 instance 级命令恢复

> 验证 `commandsClear` 清空所有 session 级命令后，instance 级命令（init/review 等）恢复原样。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "clear-restore" }) })).json()

const initial = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
const initialCount = initial.length
const initialInitDesc = initial.find(c => c.name === "init")?.description

// 创建多个 session commands，其中 1 个覆盖 init
await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "temp1", template: "Temp 1" }),
})
await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "init", template: "OVERRIDE", description: "TEMP INIT" }),
})

const overridden = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("before clear count:", overridden.length, "(expect", initialCount + 1, ")")
console.log("init overridden:", overridden.find(c => c.name === "init")?.description === "TEMP INIT")

// 清空
await fetch(BASE + "/session/" + SID.id + "/commands", { method: "DELETE" })

const restored = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("after clear count:", restored.length, "(expect", initialCount, ")")
console.log("init restored:", restored.find(c => c.name === "init")?.description === initialInitDesc)
console.log("temp1 gone:", !restored.some(c => c.name === "temp1"))
'
```
**期望**：清空后总数恢复为初始值，init 的 description 恢复原样，session 级命令全部消失

> **PG 验证**：`psql -h 127.0.0.1 -U app -d opencode -t -A -c "SELECT COUNT(*) FROM session_commands WHERE session_id='$SID';"`
> 期望：COUNT=0

---

## 真实场景用例

> 以下用例模拟 opencode 官方文档中的典型命令场景（[https://opencode.ai/docs/commands/](https://opencode.ai/docs/commands/)），覆盖参数传递、agent 指定、subtask、model 覆盖、shell 注入、文件引用。

### T33.22 创建组件命令（$ARGUMENTS 单参数场景）

> 模拟官方文档 `/component Button` 场景：用户传入组件名，AI 生成对应的 React 组件代码。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "component-cmd" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "component",
    template: "Create a new React component named $ARGUMENTS with TypeScript support. Include proper typing, props interface, and basic structure. Only output the code, no explanations.",
    description: "Create a new React component",
    agent: "build",
  }),
})

const result = await (await fetch(BASE + "/session/" + SID.id + "/command", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "component", arguments: "UserProfile" }),
})).json()
const text = (result.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("hints:", JSON.stringify(list.find(c => c.name === "component")?.hints))
console.log("response includes UserProfile:", text.includes("UserProfile"))
console.log("response includes code:", /export|function|const/.test(text))
console.log("response snippet:", text.slice(0, 200))
'
```
**期望**：AI 生成包含 `UserProfile` 的 React 组件代码（含 `export`/`function`/`const`），hints=`["$ARGUMENTS"]`

### T33.23 创建文件命令（$1/$2/$3 多位置参数场景）

> 模拟官方文档 `/create-file config.json src "{ key: value }"` 场景。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "create-file-cmd" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "create-file",
    template: "Respond with exactly this text and nothing else: FILENAME=$1 DIRECTORY=$2 CONTENT=$3",
    description: "Create a new file with content",
  }),
})

const result = await (await fetch(BASE + "/session/" + SID.id + "/command", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "create-file", arguments: "config.json src {key:value}" }),
})).json()
const text = (result.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("response:", text.slice(0, 200))
console.log("$1 -> config.json:", text.includes("FILENAME=config.json"))
console.log("$2 -> src:", text.includes("DIRECTORY=src"))
console.log("$3 -> {key:value}:", text.includes("CONTENT={key:value}"))
'
```
**期望**：`$1`→config.json，`$2`→src，`$3`→{key:value}（last position 吸收剩余）

### T33.24 指定 agent 执行命令

> 模拟官方文档 `"agent": "plan"` 场景。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "agent-cmd" }) })).json()

const created = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "plan-review", template: "List available agents.", description: "Plan review", agent: "plan" }),
})).json()
console.log("created agent:", created.agent, "(expect plan)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("list agent:", list.find(c => c.name === "plan-review")?.agent, "(expect plan)")
'
```
**期望**：创建返回和列表中 `agent=plan`

### T33.25 subtask 模式命令

> 模拟官方文档 `"subtask": true` 场景。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "subtask-cmd" }) })).json()

const created = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "analyze", template: "Analyze project structure.", description: "Subtask analyze", subtask: true }),
})).json()
console.log("created subtask:", created.subtask, "(expect true)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("list subtask:", list.find(c => c.name === "analyze")?.subtask, "(expect true)")
'
```
**期望**：创建返回和列表中 `subtask=true`

### T33.26 model 覆盖命令

> 模拟官方文档 `"model": "anthropic/claude-3-5-sonnet-20241022"` 场景。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "model-cmd" }) })).json()

const created = await (await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "smart-analysis", template: "Analyze codebase.", description: "Custom model", model: "Yd-DeepSeek/deepseek-v4-flash" }),
})).json()
console.log("created model:", created.model, "(expect Yd-DeepSeek/deepseek-v4-flash)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
console.log("list model:", list.find(c => c.name === "smart-analysis")?.model, "(expect Yd-DeepSeek/deepseek-v4-flash)")
'
```
**期望**：创建返回和列表中 `model=Yd-DeepSeek/deepseek-v4-flash`

### T33.27 Shell 输出注入命令（!`cmd`）

> 模拟官方文档 `/review-changes` 场景：模板中 `` !`git log --oneline -5` `` 注入 shell 命令输出。
>
> ⚠️ **需要沙箱环境**：shell 命令在沙箱中执行。无沙箱时 `!`cmd`` 不展开。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "shell-inject" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "review-changes",
    template: "Recent git commits:\n!`git log --oneline -5`\nReview these changes and suggest improvements.",
    description: "Review recent changes",
  }),
})

const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
const cmd = list.find(c => c.name === "review-changes")
console.log("template has !`git log`:", cmd?.template?.includes("!`git log"))
console.log("template:", cmd?.template?.slice(0, 80))
'
```
**期望**：命令创建成功，template 包含 `!`git log`` 语法。（执行需沙箱展开 shell 输出）

> **PG 验证**：`psql -h 127.0.0.1 -U app -d opencode -c "SELECT template FROM session_commands WHERE session_id='$SID' AND name='review-changes';"`
> 期望：template 含 `!`git log --oneline-5``

### T33.28 文件引用命令（@filename）

> 模拟官方文档 `/review-component` 场景：模板中 `@README.md` 引用文件内容。
>
> ⚠️ **需要沙箱/工作区环境**：文件读取在工作区中进行。无沙箱时 `@file` 不展开。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "file-ref" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/commands/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "review-file",
    template: "Review the file @README.md and suggest improvements.",
    description: "Review file by reference",
  }),
})

const list = await (await fetch(BASE + "/session/" + SID.id + "/commands")).json()
const cmd = list.find(c => c.name === "review-file")
console.log("template has @README.md:", cmd?.template?.includes("@README.md"))
console.log("template:", cmd?.template)
'
```
**期望**：命令创建成功，template 包含 `@README.md` 文件引用语法。（执行需沙箱展开文件内容）

---

### T33.29 多命令编排（一个任务顺序触发多个命令）

> **背景（2026-08-01 实测确认）**：命令只能通过 `POST /session/:id/command` 触发，且**一次调用只执行一个命令**。前端 `prompt-input/submit.ts:76` 的 `text.split(" ")` 只取第一个词作为命令，剩余作为 arguments——`/cmd1 ... \n/cmd2 ...` 单次提交只有 `/cmd1` 被识别，`/cmd2` 会成为 cmd1 的 arguments。因此**多命令编排必须多次调用 `/command`**（每个命令一次，串行执行）。
>
> 服务端 `/message` / `prompt_async` **不解析命令前缀**：单次 message 提交 `/cmd1\n/cmd2` 被当作普通文本（AI 会误读为文件路径/普通指令），不触发任何命令。

**验证目标**：
1. 多次 `/command` 调用可顺序执行多个命令（步骤编排）
2. 单次 message 提交含多命令文本不触发命令（记录当前限制）

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = "Yd-DeepSeek/deepseek-v4-flash"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "multi-cmd" }) })).json()
const runCommand = (command, args = "") =>
  fetch(BASE + "/session/" + SID.id + "/command", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ command, arguments: args, model: MODEL }) }).then(r => r.json())

// 创建 2 个顺序编排命令
await fetch(BASE + "/session/" + SID.id + "/commands/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "step-one", template: "Respond with exactly: STEP1_OK and nothing else." }) })
await fetch(BASE + "/session/" + SID.id + "/commands/create", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "step-two", template: "Respond with exactly: STEP2_OK and nothing else." }) })

// 方式一：多次 /command 串行编排（推荐）
const r1 = await runCommand("step-one")
const r2 = await runCommand("step-two")
const t1 = (r1.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
const t2 = (r2.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
console.log("cmd1:", t1.slice(0, 40), "| contains STEP1_OK:", t1.includes("STEP1_OK"))
console.log("cmd2:", t2.slice(0, 40), "| contains STEP2_OK:", t2.includes("STEP2_OK"))
console.log("✅ 方式一 多命令串行编排:", t1.includes("STEP1_OK") && t2.includes("STEP2_OK"))

// 方式二：单次 message 提交多命令（应不触发命令）
const msgRes = await fetch(BASE + "/session/" + SID.id + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: "/step-one\\n/step-two" }], model: { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" } }) }).then(r => r.json())
const msgText = (msgRes.parts || []).filter(p => p.type === "text").map(p => p.text).join(" ")
const triggeredAsCommand = msgText.includes("STEP1_OK")
console.log("单次 message 提交多命令被当命令执行:", triggeredAsCommand, "（期望 false — 服务端不解析命令前缀）")
console.log("⚠️ 方式二 记录限制: 单次提交不触发命令, 需多次 /command")
'
```

**期望**：
- 多次 `/command` 调用依次返回 `STEP1_OK`、`STEP2_OK`（多命令串行编排可用）
- 单次 message 提交 `/cmd1\n/cmd2` **不触发命令**（服务端 `/message` 不解析命令前缀；AI 当普通文本处理）
- 多命令编排的正确方式是**多次调用 `/command`**，每次一个命令
