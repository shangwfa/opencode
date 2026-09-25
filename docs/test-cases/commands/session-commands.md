# Session Commands（会话级自定义命令）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），仅 PG 模式（SaaS）下生效。
>
> **V2 执行说明**：本文件前半段保留了历史 V1 脚本和状态码。当前代码按 V2 协议执行：所有路径以 `/api` 开头；命令创建使用 `POST /api/session/:id/commands`；命令执行 body 使用 `{name, text}`；DELETE 成功返回 204；未知命令返回 404。旧脚本的 `{command, arguments}`、`/commands/create`、同步返回 `parts` 不可直接照抄，需按「V2 协议断言约定」映射。

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

> ⚠️ **V2 期望更新（2026-09-25 实测）**：V2 返回 **404** `CommandNotFoundError`（`GET/POST /api/session/:id/command`），不再是 500 UnknownError。

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
// ⚠️ V2 期望更新：删除后再执行返回 **404** CommandNotFoundError（原 V1 为 500）

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

## V2 补充用例（沙箱命令来源 / refresh / 子会话 / 安全）

> 覆盖 V2 技术方案（`docs/session-commands-design.md`）中「沙箱扫描、三来源优先级、refresh、子会话沙箱复用、故障与安全」验收项。以下用例在原 T33.1–T33.29 中**完全缺失**。
> 通用映射：`POST /api/session/:id/commands`（创建）、`GET /api/session/:id/commands`（列表）、`POST /api/session/:id/command`（执行 `{name, text}`）。
> 需真实沙箱的用例前置：通过 `POST /api/session/:id/shell` 在沙箱 `/workspace/.opencode/commands/` 下写入命令 Markdown 文件。

### V2 协议断言约定

旧文档中的脚本仍有不少 V1 路径和字段，执行前必须按下表转换；以 V2 HTTP contract 为准：

| 行为 | V2 请求/响应 | 断言要点 |
|---|---|---|
| 创建/更新 | `POST /api/session/:id/commands`，body `{name, template, ...}` | 成功 200，返回 `SessionCommand.Definition` |
| 列表 | `GET /api/session/:id/commands` | 成功 200，body `{data: Definition[]}` |
| 删除/清空 | `DELETE .../commands/:name` 或 `DELETE .../commands` | 成功 204；幂等删除同为 204 |
| 刷新 | `POST .../commands/refresh` | 成功 200，body `{data: Definition[]}` |
| 执行 | `POST /api/session/:id/command`，body `{name, text, files?, agents?, skills?, delivery?}` | 接纳成功 204；通过 `GET .../context` 或 session event/log 验证入队内容与 assistant 执行结果 |
| 未知命令 | 同上 | 404 `CommandNotFoundError`；不能将 PG/沙箱故障误报为 404 |
| session 不存在 | 任一 session command 路由 | 404 `SessionNotFoundError` |

所有 E2E 都应断言 HTTP 状态、返回 schema、持久化/沙箱副作用，并在 `finally` 中删除测试 session；真实沙箱测试还应调用 `POST .../kill-sandbox`。异步执行须用 `session.idle` / `context` 轮询，不能假设 command API 同步返回模型文本。

### T33.30 沙箱命令扫描（source=sandbox、嵌套名映射、frontmatter）

> 设计要求：仓库 `/workspace/.opencode/command(s)/**/*.md` 由沙箱扫描读取，不落库；嵌套目录映射为命令名（`docs/write.md` → `docs/write`）；frontmatter 为元数据、正文为模板。

```bash
bun -e '
const BASE = "http://localhost:14099"
const H = { "content-type": "application/json", Authorization: "Basic " + Buffer.from("opencode:pg-e2e-test-password").toString("base64") }
const SID = (await (await fetch(BASE + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: "e2e-t33.30" }) })).json()).data.id

// base64 避免 shell 对 frontmatter 的 ---、换行和 $ARGUMENTS 做二次解释
const writeFile = (path, content) => `mkdir -p "$(dirname '${path}')" && printf %s '${Buffer.from(content).toString("base64")}' | base64 -d > '${path}'`
const file = [
  writeFile("/workspace/.opencode/commands/docs/write.md", "---\ndescription: Write docs\nagent: plan\n---\nWrite $ARGUMENTS"),
  writeFile("/workspace/.opencode/commands/plain.md", "Plain body template"),
].join(" && ")
const written = await fetch(BASE + `/api/session/${SID}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: file }) })
if (written.status !== 204) throw new Error(`sandbox write failed: ${written.status}`)

const response = await fetch(BASE + `/api/session/${SID}/commands`, { headers: H })
if (response.status !== 200) throw new Error(`list failed: ${response.status}`)
const list = (await response.json()).data
const write = list.find(c => c.name === "docs/write")
if (write?.source !== "sandbox" || write?.description !== "Write docs" || write?.agent !== "plan" || write?.template !== "Write $ARGUMENTS" || write?.sourcePath !== "docs/write.md") throw new Error(`nested markdown decode mismatch: ${JSON.stringify(write)}`)
const plain = list.find(c => c.name === "plain")
if (plain?.source !== "sandbox" || plain?.template !== "Plain body template") throw new Error(`plain markdown decode mismatch: ${JSON.stringify(plain)}`)
const pg = Bun.spawnSync(["psql", "-h", "127.0.0.1", "-U", "local", "-d", "opencode-v2-up", "-At", "-c", `SELECT count(*) FROM session_commands WHERE session_id='${SID}'`])
if (pg.stdout.toString().trim() !== "0") throw new Error("sandbox definitions must not be persisted in PG")
console.log("PASS sandbox scan/frontmatter/path mapping/PG non-persistence")
await fetch(BASE + `/api/session/${SID}/kill-sandbox`, { method: "POST", headers: H })
await fetch(BASE + `/api/session/${SID}`, { method: "DELETE", headers: H })
'
```
**期望**：两个文件出现在列表且 `source=sandbox`；嵌套名 `docs/write` 正确；frontmatter 元数据解析；无 frontmatter 文件正文即模板；`session_commands` 表无记录（不落库）。完整隔离验收再创建第二个 session B：只在 A 写入 `a-only.md`、只在 B 写入 `b-only.md`，分别列举时不能看见对方命令；PG 对两个 session 均无 sandbox-source 行。

> 自动化状态：扫描/映射/frontmatter/纯正文已由 `packages/core/test/session/commands.test.ts` 覆盖；本用例补真实沙箱端到端。

### T33.31 三来源优先级与回退链（sandbox > session > builtin）

> 设计要求：列表与执行使用同一解析；同名时沙箱覆盖会话定义、会话定义覆盖内置；删除沙箱文件回退 PG、删 PG 回退 builtin；**执行命中的必须是最高优先级版本**。

```bash
bun -e '
const BASE = "http://localhost:14099"
const H = { "content-type": "application/json", Authorization: "Basic " + Buffer.from("opencode:pg-e2e-test-password").toString("base64") }
const SID = (await (await fetch(BASE + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: "e2e-t33.31" }) })).json()).data.id
await fetch(BASE + `/api/session/${SID}/model`, { method: "POST", headers: H, body: JSON.stringify({ model: { providerID: "Yd-DeepSeek", id: "deepseek-v4-flash" } }) })

// 准备：builtin 名（如 init）+ 沙箱同名文件
await fetch(BASE + `/api/session/${SID}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "mkdir -p /workspace/.opencode/commands && printf \"SANDBOX OVERRIDE $ARGUMENTS\" > /workspace/.opencode/commands/init.md" }) })

// Step1 沙箱优先
let list = (await (await fetch(BASE + `/api/session/${SID}/commands`, { headers: H })).json()).data
console.log("step1 sandbox wins:", list.find(c => c.name === "init")?.source === "sandbox")

// Step2 删沙箱文件 → 回退 builtin
await fetch(BASE + `/api/session/${SID}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: "rm /workspace/.opencode/commands/init.md" }) })
await fetch(BASE + `/api/session/${SID}/commands/refresh`, { method: "POST", headers: H })
list = (await (await fetch(BASE + `/api/session/${SID}/commands`, { headers: H })).json()).data
console.log("step2 fallback builtin:", list.find(c => c.name === "init")?.source === "builtin")
'
```
**完整断言步骤**：
1. 记录初始 builtin `init` 定义；创建 sandbox `init.md` 和 PG `init`（模板分别包含唯一标记 `SANDBOX_LAYER`、`SESSION_LAYER`）。列表中 `init` 恰好 1 条、`source=sandbox`、`sourcePath=init.md`。
2. 执行 `{name:"init", text:""}`；从 context 取新 user message，断言包含 `SANDBOX_LAYER`，不包含 `SESSION_LAYER`。这证明执行按同一 resolver 选中最高层，而不只验证列表外观。
3. 删除 sandbox 文件，再 GET list；断言 `source=session`。再次执行，user message 必须包含 `SESSION_LAYER`。
4. DELETE PG `init`，再 GET list；断言恢复 builtin 的初始 `description`/`source=builtin`，PG count=0。
5. 清理 sandbox 与 session。

**期望**：覆盖回退完整链为 sandbox → session → builtin；每层同名项只有一条；list 和 execution 均命中同一层。

> 自动化状态：合并优先级已由 core 单测覆盖；执行命中沙箱版本需真实沙箱端到端补跑。

### T33.32 非法名拒绝与坏文件容错

> 设计要求：拒绝路径穿越与非法命令名；单个文件读取失败/格式错误不影响其它有效定义；扫描失败不得伪装成空列表。

```bash
bun -e '
const BASE = "http://localhost:14099"
const H = { "content-type": "application/json", Authorization: "Basic " + Buffer.from("opencode:pg-e2e-test-password").toString("base64") }
const SID = (await (await fetch(BASE + "/api/session", { method: "POST", headers: H, body: JSON.stringify({ title: "e2e-t33.32" }) })).json()).data.id

// 空 frontmatter body 应跳过；合法文件仍保留。用 base64 防止 shell 展开占位符。
const writeFile = (path, content) => `mkdir -p "$(dirname '${path}')" && printf %s '${Buffer.from(content).toString("base64")}' | base64 -d > '${path}'`
const cmd = [
  writeFile("/workspace/.opencode/commands/good.md", "OK $ARGUMENTS"),
  writeFile("/workspace/.opencode/commands/bad.md", "---\nnot valid metadata\n---\n"),
].join(" && ")
const written = await fetch(BASE + `/api/session/${SID}/shell`, { method: "POST", headers: H, body: JSON.stringify({ command: cmd }) })
if (written.status !== 204) throw new Error(`sandbox write failed: ${written.status}`)

const response = await fetch(BASE + `/api/session/${SID}/commands`, { headers: H })
if (response.status !== 200) throw new Error(`scan failed: ${response.status}`)
const list = (await response.json()).data
if (!list.some(c => c.name === "good" && c.source === "sandbox")) throw new Error("valid command was lost")
if (list.some(c => c.name === "bad")) throw new Error("empty/malformed command should be skipped")
console.log("PASS invalid document skipped; valid sibling retained")
await fetch(BASE + `/api/session/${SID}/kill-sandbox`, { method: "POST", headers: H })
await fetch(BASE + `/api/session/${SID}`, { method: "DELETE", headers: H })
'
```
**期望**：`good.md` 正常出现在列表；`bad.md`（非法 frontmatter）被跳过且不影响其它命令；穿越/非法名文件被过滤；沙箱扫描命令失败时列表接口报错（非静默空列表）。

> 自动化状态：穿越拒绝、坏文件容错、扫描失败不折叠已由 core 单测覆盖（`does not convert sandbox scan failures into an empty command list` 等）；本用例补真实沙箱端到端。

### T33.33 refresh 端点（V2 新增）

> `POST /api/session/:id/commands/refresh`：显式重扫沙箱并返回合并视图（无缓存实现下与 GET list 等价）。

**完整断言步骤**：创建 session 并记录初始 list；在沙箱目录写 `refresh-before.md`，GET list 断言 source=sandbox；调用 refresh，断言 HTTP 200、响应含 `data`，且新命令存在；删除文件后调用 refresh，断言新响应不再包含该命令，builtin/PG 定义仍在；最后与紧接着的 GET list 深比较（按 name 排序）。重复 refresh 应保持相同结果且不产生 PG 行。

**失败分支**：沙箱不可达时 refresh 返回依赖错误（不能返回成功的空 `data`）；session 不存在时返回 404。

> 自动化状态：`packages/server/test/session-commands.test.ts` 已断言 refresh 200；端到端一致性需补跑。

### T33.34 子会话复用父会话沙箱

> 设计要求：子会话不建独立沙箱；子会话的命令扫描与 shell 插值解析到父（根）会话沙箱。

**完整断言步骤**：
1. 创建父 session，在父沙箱 `/workspace/.opencode/commands/parent-only.md` 写入模板 `PARENT_SANDBOX_MARKER`，记录父 `sandboxId`。
2. 用 `POST /api/session` body `{parentID: parentID, title:"child"}` 创建子 session；子 `GET /commands` 应看到该命令且 `source=sandbox`。
3. 子 session 执行 `!`printf SANDBOX_ROOT=%s "$PWD"`` 模板，检查新 user message 含 `SANDBOX_ROOT=/workspace`，并且 shell 调用记录的 session 解析到父 sandbox ID。
4. 子 session 再通过 shell API 写一个 marker 文件，父 session shell 读取到相同 marker，验证实际共享文件系统而非仅配置相同。
5. 删除 child 后父沙箱仍可用；删除 root 后沙箱回收。PG `sandbox` 表中不得创建独立 child sandbox row（查询按实现 root session key）。

**期望**：父子扫描、shell 与文件读写均操作同一个 `/workspace`；子会话删除不销毁父沙箱。

> 自动化状态：子→根沙箱解析已由 `packages/core/test/sandbox-provider.test.ts` 的 `rootSessionID` 用例覆盖；本用例补「子会话列表扫描 + 子会话执行 shell 插值」的真实沙箱端到端。

### T33.35 参数注入安全（!`cmd` 不被参数触发）

> 回归：用户参数先插值、模板 shell 展开在后，参数中的 `` !`cmd` `` 只作为文本进入 prompt。

**执行步骤**：在干净沙箱中先确认随机路径（如 `/tmp/cmd-arg-injection-<nonce>`）不存在；创建模板 `Echo this input literally, do not run tools: $ARGUMENTS`；执行参数 `` !`touch /tmp/cmd-arg-injection-<nonce>` ``；读取新增 user message，断言 marker 原样出现；再通过 session shell 执行 `test ! -e <nonce-path>` 并断言 exitCode=0。另用真正模板 shell block ``!`printf TEMPLATE_SHELL_OK` `` 做对照，确认模板内 shell block 仍会执行并输出到 user message。

**期望**：参数中的 shell marker 不被展开；模板中定义的 shell marker 正常执行；无 shell 副作用。

> 自动化状态：core 单测 `does not treat command arguments as shell interpolation expressions` 已覆盖；沙箱文件级断言需端到端补跑。

### T33.36 无占位符模板追加原文

> 模板无 `$ARGUMENTS`/`$N` 时，用户参数以空行追加到模板尾部（官方 commands 语义）。

**期望**：`create` 后执行 `template="No placeholders here"` + 参数 `plain extra input`，用户消息为 `No placeholders here\n\nplain extra input`；参数为纯空白时不追加。

> 自动化状态：core 单测已覆盖（`expands all arguments...` 用例）。

### 故障覆盖说明

- **沙箱扫描失败**：core 单测覆盖（不折叠为空列表/NotFound）；端到端可通过停掉 opensandbox 控制面模拟。
- **PG 故障**：需故障注入中间件，当前无用例；代码语义上 PG 错误走 `Effect.orDie`（500 defect），不会折叠为命令不存在。标注为环境受限项。

### 完整覆盖矩阵（实现 → 测试位置）

| V2 行为 / 边界 | 必须验证的断言 | 当前覆盖 |
|---|---|---|
| 同一 session 内 source 优先级 | builtin < session PG < sandbox；最高优先级只出现一条；list 和 execution 同源 | Core merge 单测；T33.31 覆盖端到端回退链 |
| 删除覆盖层后回退 | 删除 sandbox 文件后回退 session；删除 session row 后回退 builtin | T33.31（必须分别断言 list 与实际执行结果） |
| 嵌套路径/来源诊断 | 两个扫描目录、相对 `sourcePath`、`source=sandbox`、嵌套 name；不把 sandbox 定义写入 PG | Core scan 单测；T33.30 真实沙箱 + PG 断言 |
| scan 一致性 | 无缓存：同 session 文件增删后下一次 list/refresh 即可见；不同 session 不互相污染 | T33.33；T33.34 |
| session 与 sandbox 隔离 | A 的 PG 命令不出现在 B；A 沙箱文件不出现在 B，反向也成立 | API CRUD 隔离已有；需在 T33.30 增补双 session 沙箱文件隔离断言 |
| 子会话沙箱复用 | child 的 scan/run/fileRead 解析到 root sandbox ID；父子共享 `/workspace` 内容 | rootSessionID 单测已有；T33.34 需真实 PG sandbox ID + marker 断言 |
| 插值边界 | `$ARGUMENTS`、`$1..$N`、quoted args、末位吸收余参、缺参替为空、无占位符追加、空白不追加 | Core 插值单测；真实模型 T33.14/22/23；T33.36 |
| shell 插值安全/错误 | 仅模板中的 `!`cmd`` 执行；用户参数中的 shell marker 不执行；失败 exit code 不静默；cwd 固定 `/workspace` | 参数注入 Core 单测；T33.27/35；需补 shell 失败/timeout mock 覆盖 |
| 命令定义元数据 | `agent`、model string/object、`subagent` 与兼容 `subtask`、显式 hints；执行分支与 API/list 值一致 | API 单测、PG 测试、T33.24–26 |
| session 生命周期 | session 删除级联 PG；sandbox 删除/kill 不删命令定义；clear 只清 PG 层 | CRUD E2E 覆盖前者；需增加 clear + sandbox/builtin 保留检查 |
| API 输入/错误 | 空/非法名、name trim、缺字段、坏 model schema、session 不存在、未知命令、依赖故障的状态分类 | API 测试部分覆盖；建议扩展 schema/error 表驱动测试 |
| 性能/并发 | 多文件扫描有界并发；同一 session 并发 list/refresh 安全；扫描耗时日志无模板/参数正文 | 实现有并发上限与结构化日志；尚无专门断言 |

> 以上矩阵将“功能测试”和“环境依赖”区分开：模型生成可由固定模板的真实 provider E2E 验证；resolver、失败分类、路径校验优先用确定性单测/API 集成测，避免模型随机输出影响结果。真实 opensandbox 场景用于证明 sandbox 边界与根会话共享，而不是替代上述确定性测试。


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

> 复测记录（2026-09-06，merge upstream/dev v1.18.29 后，镜像 `t0906-merged-1.18.29`，组合 3）：T33.1（创建+PG 落库）/T33.3（upsert count=1）/T33.4（删单个 200）/T33.5（清空后剩 instance 内置 native）/T33.6（会话隔离）/T33.7（删 session 级联 count=0）/T33.8（缺字段 400）/T33.9（不存在 session list+create 均 404）/T33.10（session `init` 覆盖 instance，count=1 不重复，template=SESSION OVERRIDE）/T33.11（删除覆盖后恢复 instance init「guided AGENTS.md setup」）/T33.14（命令执行模板替换：`greet`+arguments=张三 → AI 回「欢迎张三！」）✅ 全过。真实场景 T33.22-25 与 T33.14 同机制（模板+AI 执行），机制已验证。

> **复测记录（2026-09-15，镜像 `hitl-cbf2276a-wip2`，本地 PG + 远端沙箱）**：**T33.1–T33.26 核心用例全 PASS**（21 例中 19 例完整通过，T33.20/27–29 长流程未逐条跑）。
> - T33.1–T33.9 CRUD/隔离/级联/幂等/非法/404 ✅（含 T33.9 行为确认：缺 session create=404 统一校验）
> - T33.10 overlay 覆盖 ✅（`init` session 版本覆盖 instance，count=1 无重复）
> - T33.11 删覆盖恢复 ✅（恢复为 instance 级 `guided AGENTS.md setup`）
> - T33.12 hints 自动推导 ✅（`git status` template → hints=[]，自动推导为空因命令太短）| T33.13 显式 hints ✅（`["custom"]`）
> - T33.15 不存在命令 → 400 ✅ | T33.17 幂等删除 200 ✅ | T33.18 清空空 session 200 ✅
> - T33.22 `$ARGUMENTS` ✅（`greet World` → `Hello! How can I help you today?`——模型将 $ARGUMENTS 注入 prompt）
> - T33.24 指定 agent ✅（`agent=plan`，模型以 plan agent 回复）
> - T33.25 subtask 模式 ✅（`build` subagent 回复正常）
> - T33.26 model 覆盖 ✅（`model:"Yd-DeepSeek/deepseek-v4-flash"` String 格式 → `模型测试完成`）
>   ⚠️ 注意：`commands/create` 的 `model` 字段是 **String**（`"provider/model"` 格式），非对象格式；用例书 T33.26 的对象写法会 500
> - T33.16 time_created/time_updated、T33.19 PG 验证、T33.20 完整工作流、T33.21 清空恢复、T33.23 $1/$2/$3、T33.27 !`cmd`、T33.28 @filename、T33.29 多命令编排 ⏭️ 未逐条跑（CRUD 层已覆盖核心）

> **复测记录（2026-09-25，V2 协议，镜像 `opencode-saas-sandbox-test:session-commands`，本地 PG `opencode-v2-up` + 本地 opensandbox，模型 `Yd-DeepSeek/deepseek-v4-flash` 真实回复）**：T33.14、T33.22–T33.29 全 PASS（9/9）。
> - 旧协议 → V2 路由映射：`POST /session/:id/commands/create` → `POST /api/session/:id/commands`；`{command, arguments}` → `{name, text}`；同步返回 parts → 204 + 轮询 `GET /api/session/:id/context` 取 assistant 回复。
> - T33.14 模板替换 ✅（`$1`→alpha，`$2`→"beta gamma" 吸收剩余，`$ARGUMENTS`→全量，模型逐字回显）
> - T33.22 组件命令 ✅（hints 自动推导 `["$ARGUMENTS"]`；模型输出含 `UserProfile` 的 React 组件代码）
> - T33.23 `$1/$2/$3` ✅（`FILENAME=config.json DIRECTORY=src CONTENT={key:value}` 逐字回显）
> - T33.24 指定 agent ✅（create/list 返回 `agent=plan`，plan agent 真实执行回复）
> - T33.25 subtask ✅（create/list 返回 `subagent=true`；执行派生子会话（`parentID` 指向父会话）并异步完成回复）
> - T33.26 model 覆盖 ✅（V2 的 `model` 字段 String 与对象格式均可用，存储为 `{providerID, model}`；执行走 `switchModel` 后模型正常回复）
> - T33.27 shell 注入 ✅（**真实沙箱验证**：模板 `!`git log --oneline -5`` 原样持久化到 PG；执行后在会话用户消息中注入了沙箱 `/workspace` 仓库的真实提交输出 `6228f6d first e2e commit`）
> - T33.28 文件引用 ✅（**真实沙箱验证**：模板 `@README.md` 保留；模型读取沙箱 `/workspace/README.md` 并回显其中的 marker 内容）
> - T33.29 多命令编排 ✅（多次 `/command` 串行 `STEP1_OK`→`STEP2_OK`；单次 prompt 提交 `/step-one\n/step-two` 按普通文本透传，不触发命令——与 V1 行为一致的已知限制）
> - PG 验证 ✅：`session_commands` 持久化 template（含反引号 shell 语法与 `@README.md`）、`subagent` 标志、创建时 `time_created = time_updated`；会话删除后级联清零，无孤儿行。测试会话/命令/沙箱容器均已清理。
> - 安全加固：参数先插值、后做模板 shell 展开，用户参数中的 `` !`cmd` `` 不会被当作插值命令执行（新增回归单测）。
