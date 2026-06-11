# Session MCP（会话级动态 MCP）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），仅 PG 模式（SaaS）下生效。

## 公共配置

```js
const BASE = "http://localhost:14096"
```

---

### T22.1 创建会话级 local MCP

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-create-local" }) })).json()
console.log("SID:", SID.id)

const res = await (await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "sandbox-shadcn",
    type: "local",
    command: ["npx", "shadcn@latest", "mcp"],
    environment: { NODE_ENV: "production" },
  }),
})).json()
console.log("name:", res.name, "type:", res.type, "command:", JSON.stringify(res.command))
console.log("enabled:", res.enabled)
'
```
**期望**：`name=sandbox-shadcn`，`type=local`，`command=["npx","shadcn@latest","mcp"]`，`enabled=true`

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, type, command FROM session_mcps WHERE session_id='$SID' AND name='sandbox-shadcn';"`
> 期望：name=sandbox-shadcn, type=local, command=["npx","shadcn@latest","mcp"]

### T22.2 创建会话级 remote MCP

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-create-remote" }) })).json()
console.log("SID:", SID.id)

const res = await (await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "search-api",
    type: "remote",
    url: "https://search.example.com/mcp",
    headers: { Authorization: "Bearer test-token" },
  }),
})).json()
console.log("name:", res.name, "type:", res.type, "url:", res.url)
console.log("headers:", JSON.stringify(res.headers))
'
```
**期望**：`name=search-api`，`type=remote`，`url=https://search.example.com/mcp`，headers 包含 `Authorization`

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, type, url, headers FROM session_mcps WHERE session_id='$SID' AND name='search-api';"`
> 期望：name=search-api, type=remote, url=https://search.example.com/mcp

### T22.3 列出会话 MCP

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-list" }) })).json()
console.log("SID:", SID.id)

await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "mcp-a", type: "local", command: ["echo", "a"] }),
})
await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "mcp-b", type: "remote", url: "https://b.example.com/mcp" }),
})

const list = await (await fetch(BASE + "/session/" + SID.id + "/mcps")).json()
list.forEach(m => console.log(m.name + ": type=" + m.type))
console.log("count:", list.length, "(expect 2)")
console.log("mcp-a in list:", list.some(m => m.name === "mcp-a"))
console.log("mcp-b in list:", list.some(m => m.name === "mcp-b"))
'
```
**期望**：列表包含 `mcp-a`（local）和 `mcp-b`（remote），count=2

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_mcps WHERE session_id='$SID';"`
> 期望：COUNT=2

### T22.4 Upsert 更新同名 MCP

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-upsert" }) })).json()
console.log("SID:", SID.id)

await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "my-mcp", type: "local", command: ["cmd", "v1"] }),
})

const updated = await (await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "my-mcp", type: "remote", url: "https://v2.example.com/mcp" }),
})).json()
console.log("type:", updated.type, "(expect remote)")
console.log("url:", updated.url, "(expect https://v2.example.com/mcp)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/mcps")).json()
console.log("count:", list.filter(m => m.name === "my-mcp").length, "(expect 1)")
'
```
**期望**：type 更新为 remote，command 变为 null，列表中仍只有 1 个 my-mcp

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT type, url, command FROM session_mcps WHERE session_id='$SID' AND name='my-mcp';"`
> 期望：type=remote, url=https://v2.example.com/mcp, command=NULL

### T22.5 删除单个 MCP

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-delete" }) })).json()
console.log("SID:", SID.id)

await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "to-delete", type: "local", command: ["rm"] }),
})

const delRes = await fetch(BASE + "/session/" + SID.id + "/mcps/to-delete", { method: "DELETE" })
console.log("DELETE status:", delRes.status, "(expect 200)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/mcps")).json()
console.log("to-delete gone:", !list.some(m => m.name === "to-delete"))
'
```
**期望**：DELETE 返回 200，to-delete 已从列表中消失

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_mcps WHERE session_id='$SID' AND name='to-delete';"`
> 期望：COUNT=0

### T22.6 清空所有会话级 MCP

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-clear" }) })).json()
console.log("SID:", SID.id)

await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "m1", type: "local", command: ["1"] }),
})
await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "m2", type: "local", command: ["2"] }),
})

const clearRes = await fetch(BASE + "/session/" + SID.id + "/mcps", { method: "DELETE" })
console.log("clear status:", clearRes.status, "(expect 200)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/mcps")).json()
console.log("leftover:", list.length, "(expect 0)")
'
```
**期望**：HTTP 200，列表为空

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_mcps WHERE session_id='$SID';"`
> 期望：COUNT=0

### T22.7 不同 session 的 MCP 互相隔离

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID_A = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-iso-A" }) })).json()
const SID_B = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-iso-B" }) })).json()

await fetch(BASE + "/session/" + SID_A.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "shared", type: "local", command: ["cmd-a"] }),
})
await fetch(BASE + "/session/" + SID_B.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "shared", type: "remote", url: "https://b.example.com/mcp" }),
})

const listA = await (await fetch(BASE + "/session/" + SID_A.id + "/mcps")).json()
const listB = await (await fetch(BASE + "/session/" + SID_B.id + "/mcps")).json()
console.log("A shared type:", listA.find(m => m.name === "shared")?.type, "(expect local)")
console.log("B shared type:", listB.find(m => m.name === "shared")?.type, "(expect remote)")
'
```
**期望**：A 显示 type=local，B 显示 type=remote

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT session_id, type FROM session_mcps WHERE name='shared' ORDER BY session_id;"`
> 期望：两条记录

### T22.8 删除 session 后 MCP 级联清理

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-cascade" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "cascade-mcp", type: "local", command: ["cascade"] }),
})

const before = await (await fetch(BASE + "/session/" + SID.id + "/mcps")).json()
console.log("Before delete:", before.some(m => m.name === "cascade-mcp"), "(expect true)")

await fetch(BASE + "/session/" + SID.id, { method: "DELETE" })

const after = await fetch(BASE + "/session/" + SID.id + "/mcps")
const afterList = await after.json().catch(() => undefined)
console.log("After delete status:", after.status, "(expect 200)")
console.log("After delete list length:", Array.isArray(afterList) ? afterList.length : "n/a", "(expect 0)")
'
```
**期望**：删除 session 后 GET mcps 返回 200 且列表为空；PG 级联删除 session MCP 记录

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_mcps WHERE session_id='$SID';"`
> 期望：COUNT=0

### T22.9 不存在的 session 操作 MCP → 404

```bash
bun -e '
const BASE = "http://localhost:14096"

const createRes = await fetch(BASE + "/session/ses_NOTEXIST/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "ghost", type: "local", command: ["ghost"] }),
})
console.log("create status:", createRes.status, "(expect 500 due FK)")

const listRes = await fetch(BASE + "/session/ses_NOTEXIST/mcps")
const list = await listRes.json().catch(() => undefined)
console.log("list status:", listRes.status, "(expect 200)")
console.log("list length:", Array.isArray(list) ? list.length : "n/a", "(expect 0)")

const delRes = await fetch(BASE + "/session/ses_NOTEXIST/mcps/ghost", { method: "DELETE" })
console.log("delete status:", delRes.status, "(expect 200)")
'
```
**期望**：create 返回 500（FK 约束），list 返回 200 空数组，delete 返回 200

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -t -A -c "SELECT COUNT(*) FROM session_mcps WHERE session_id='ses_NOTEXIST';"`
> 期望：COUNT=0

### T22.10 输入校验：缺少必填字段

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-validation" }) })).json()

// 缺 name
const noName = await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ type: "local", command: ["echo"] }),
})
console.log("no name:", noName.status, "(expect 400)")

// 缺 type
const noType = await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "no-type", command: ["echo"] }),
})
console.log("no type:", noType.status, "(expect 400)")

// 非法 type
const badType = await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "bad-type", type: "invalid" }),
})
console.log("bad type:", badType.status, "(expect 400)")
'
```
**期望**：缺 name、缺 type、非法 type 均返回 400

### T22.11 完整字段持久化

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-full-fields" }) })).json()
console.log("SID:", SID.id)

const res = await (await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "full-mcp",
    type: "remote",
    url: "https://full.example.com/mcp",
    headers: { "x-token": "tok123", "x-extra": "extra456" },
    enabled: true,
  }),
})).json()
console.log("name:", res.name)
console.log("type:", res.type)
console.log("url:", res.url)
console.log("headers:", JSON.stringify(res.headers))
console.log("enabled:", res.enabled)
'
```
**期望**：remote MCP 字段正确返回；remote 不接受 `environment`

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, type, url, headers, enabled FROM session_mcps WHERE session_id='$SID';"`
> 期望：所有字段对应 PG 存储值一致

### T22.12 disabled MCP 持久化

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-disabled" }) })).json()

const res = await (await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "off-mcp", type: "local", command: ["silent"], enabled: false }),
})).json()
console.log("name:", res.name, "enabled:", res.enabled, "(expect false)")
'
```
**期望**：enabled=false

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT enabled FROM session_mcps WHERE session_id='$SID' AND name='off-mcp';"`
> 期望：enabled=false

### T22.13 Remote MCP 工具执行验证（E2E）

> **前置条件**：需要在 opencode 服务器可访问的地址上运行一个 MCP 服务。以下示例用 `@modelcontextprotocol/server-everything` 作为测试 MCP。

**Step 1** — 在宿主机启动测试 MCP server（StreamableHTTP 模式）：

```bash
# 安装并启动一个支持 StreamableHTTP 的 MCP server
# 方案 A：用 supergateway 桥接 stdio → HTTP
npx -y @modelcontextprotocol/server-everything &
# 另开终端
npx -y supergateway --stdio "npx @modelcontextprotocol/server-everything" --port 9105 --outputTransport streamableHttp
```

**Step 2** — 创建 session、注册 remote MCP、触发工具调用并断言结果：

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

async function waitForTool(sessionID, prefix, expected, timeoutMs = 90000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = await (await fetch(BASE + "/session/" + sessionID + "/message")).json()
    for (const m of msgs) {
      for (const p of m.parts || []) {
        if (p.type === "tool" && p.tool?.startsWith(prefix)) {
          const output = JSON.stringify(p.state?.output || p.state || "")
          console.log("MCP TOOL:", p.tool, "status:", p.state?.status, "output:", output.slice(0, 300))
          if (p.state?.status === "completed" && output.includes(expected)) return true
        }
      }
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  return false
}

const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-exec-remote" }) })).json()

// 注册 session MCP（指向本机 supergateway 暴露的地址）
const res = await (await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "test-tools",
    type: "remote",
    url: "http://host.docker.internal:9105/mcp",
  }),
})).json()
console.log("MCP registered:", res.name, res.type)

// 发消息要求 AI 使用 MCP 工具
const msg = await fetch(BASE + "/session/" + SID.id + "/prompt_async", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "使用 test-tools 里的 echo 工具，echo 内容为 hello-mcp" }],
    model: MODEL,
  }),
})
console.log("prompt_async status:", msg.status)
const ok = await waitForTool(SID.id, "test_tools_", "hello-mcp")
console.log("MCP tool completed with expected output:", ok, "(expect true)")
if (!ok) process.exit(1)
'
```

**期望**：
- MCP 注册成功（name=test-tools, type=remote）
- AI 的消息中包含 `test_tools_echo` 工具调用
- 工具执行状态为 completed，输出包含 `hello-mcp`

### T22.14 Local MCP 工具执行验证（Sandbox E2E）

> **前置条件**：沙箱环境已启动，sandbox 镜像包含 `supergateway` 和待测试的 MCP CLI。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-exec-local" }) })).json()

async function waitForTool(sessionID, prefix, expected, timeoutMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = await (await fetch(BASE + "/session/" + sessionID + "/message")).json()
    for (const m of msgs) {
      for (const p of m.parts || []) {
        if (p.type === "tool" && p.tool?.startsWith(prefix)) {
          const output = JSON.stringify(p.state?.output || p.state || "")
          console.log("MCP TOOL:", p.tool, "status:", p.state?.status, "output:", output.slice(0, 300))
          if (p.state?.status === "completed" && output.includes(expected)) return true
        }
      }
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  return false
}

// keepAlive 防止沙箱回收
await fetch(BASE + "/session/" + SID.id + "/keep-alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) })

// Step 1: 在沙箱中安装 MCP server 依赖
const install = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "npm install -g @modelcontextprotocol/server-everything 2>&1 | tail -1" }),
})).json()
console.log("install:", install.stdout?.trim() || install.stderr?.trim())

// Step 2: 注册 session local MCP
const res = await (await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "sandbox-everything",
    type: "local",
    command: ["npx", "-y", "@modelcontextprotocol/server-everything"],
  }),
})).json()
console.log("MCP registered:", res.name, res.type)

// Step 3: 发消息触发 MCP 工具调用
const msg = await fetch(BASE + "/session/" + SID.id + "/prompt_async", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "使用 sandbox-everything 里的 echo 工具，echo 内容为 hello-sandbox-mcp" }],
    model: MODEL,
  }),
})
console.log("prompt_async status:", msg.status)
const ok = await waitForTool(SID.id, "sandbox_everything_", "hello-sandbox-mcp")
console.log("MCP tool completed with expected output:", ok, "(expect true)")
if (!ok) process.exit(1)
'
```

**期望**：
- MCP 在沙箱中通过 supergateway 桥接启动成功
- `prompt_async` 返回 204
- MCP 工具调用状态为 completed，输出包含 `hello-sandbox-mcp`
- 同一 session 再次调用时复用已缓存的 MCP 连接（不再重复启动沙箱进程）

### T22.15 Session MCP 工具在 agent 模型切换后仍然可用

> 验证 session MCP 的工具在 LLM step 循环的每一轮都被正确注入（`toolsForSession` 每次 step 都调用）。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).json()

// 注册一个 session MCP
await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "persist-tools", type: "remote", url: "http://host.docker.internal:9105/mcp" }),
})

// 发多轮对话，每轮都验证工具可用
const messages = [
  "使用 persist-tools 的 echo 工具 echo: round-1",
  "刚才用的是哪个 MCP 工具？确认它的名字。",
  "再次使用那个工具的 echo，echo: round-3",
]

for (const text of messages) {
  const res = await fetch(BASE + "/session/" + SID.id + "/prompt_async", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parts: [{ type: "text", text }],
      model: { providerID: "zhipuai", modelID: "glm-5.1" },
    }),
  })
  console.log(text.slice(0, 40), "→", res.status)
}

async function waitForOutputs(sessionID, expected, timeoutMs = 120000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const msgs = await (await fetch(BASE + "/session/" + sessionID + "/message")).json()
    const outputs = msgs.flatMap(m => (m.parts || [])
      .filter(p => p.type === "tool" && p.tool?.includes("persist_tools"))
      .map(p => JSON.stringify(p.state?.output || p.state || "")))
    console.log("MCP outputs:", outputs.map(o => o.slice(0, 120)))
    if (expected.every(x => outputs.some(o => o.includes(x)))) return outputs
    await new Promise(r => setTimeout(r, 3000))
  }
  return []
}

const msgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
const toolCalls = msgs.flatMap(m => m.parts.filter(p => p.type === "tool" && p.tool?.includes("persist_tools")))
console.log("MCP tool calls across rounds:", toolCalls.length, "(expect >= 2)")
const outputs = await waitForOutputs(SID.id, ["round-1", "round-3"])
const ok = outputs.length > 0
console.log("MCP outputs contain round-1 and round-3:", ok, "(expect true)")
if (!ok) process.exit(1)
'
```

**期望**：三轮对话中至少 2 次调用了 `persist_tools_echo` 工具，且工具输出分别包含 `round-1` 和 `round-3`，验证工具注入在每轮 step 循环中都生效。

### T22.16 输入校验：local/remote 必填字段互斥

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-schema-strict" }) })).json()

const cases = [
  ["local missing command", { name: "bad-local-1", type: "local" }],
  ["local empty command", { name: "bad-local-2", type: "local", command: [] }],
  ["remote missing url", { name: "bad-remote-1", type: "remote" }],
]

for (const [label, body] of cases) {
  const res = await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  console.log(label + ":", res.status, "(expect 400)")
}
'
```

**期望**：缺失必填字段或 `local.command=[]` 全部返回 400，且 PG 不产生记录。

### T22.17 local MCP environment 真正注入到 sandbox 命令

> 该用例验证 `environment` 不只是持久化，而是实际进入 local MCP 启动进程环境。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-env-injection" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/keep-alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) })

await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "env-everything",
    type: "local",
    command: ["sh", "-lc", "printf \"$MCP_ENV_TEST\" >/tmp/mcp-env-test && npx -y @modelcontextprotocol/server-everything"],
    environment: { MCP_ENV_TEST: "hello-env-value" },
  }),
})

await fetch(BASE + "/session/" + SID.id + "/prompt_async", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "列出并使用 env-everything 的 echo 工具 echo hello" }], model: MODEL }),
})

await new Promise(r => setTimeout(r, 8000))
const check = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "cat /tmp/mcp-env-test 2>/dev/null || true" }),
})).json()
console.log("env file:", JSON.stringify((check.stdout || "").trim()), "(expect hello-env-value)")
'
```

**期望**：`/tmp/mcp-env-test` 内容为 `hello-env-value`。

### T22.18 shell 安全：恶意 name/command/env 不应产生命令注入

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-shell-safety" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/keep-alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) })

await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    name: "bad;touch /tmp/mcp-name-pwned;#",
    type: "local",
    command: ["sh", "-lc", "printf safe >/tmp/mcp-safe-marker && npx -y @modelcontextprotocol/server-everything"],
    environment: { SAFE_VALUE: "a b c ' quote", "BAD-ENV;touch /tmp/mcp-env-pwned": "x" },
  }),
})

await fetch(BASE + "/session/" + SID.id + "/prompt_async", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "使用 bad touch 对应 MCP 的 echo 工具 echo safe" }], model: MODEL }),
})

await new Promise(r => setTimeout(r, 8000))
const check = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "test -f /tmp/mcp-name-pwned && echo NAME_PWNED || true; test -f /tmp/mcp-env-pwned && echo ENV_PWNED || true; test -f /tmp/mcp-safe-marker && echo SAFE_MARKER || true" }),
})).json()
console.log(check.stdout)
'
```

**期望**：输出包含 `SAFE_MARKER`，不包含 `NAME_PWNED` 或 `ENV_PWNED`。

### T22.19 local MCP lifecycle：pid/log 文件与清理

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }
const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-pid-cleanup" }) })).json()

await fetch(BASE + "/session/" + SID.id + "/keep-alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true }) })
await fetch(BASE + "/session/" + SID.id + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "pid-everything", type: "local", command: ["npx", "-y", "@modelcontextprotocol/server-everything"] }),
})
await fetch(BASE + "/session/" + SID.id + "/prompt_async", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ parts: [{ type: "text", text: "使用 pid-everything 的 echo 工具 echo pid" }], model: MODEL }),
})
await new Promise(r => setTimeout(r, 8000))

let check = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "ls /tmp/opencode-mcp/*9100.pid /tmp/opencode-mcp/*9100.log 2>/dev/null" }),
})).json()
console.log("before cleanup:", check.stdout)

await fetch(BASE + "/session/" + SID.id + "/keep-alive", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: false }) })
await fetch(BASE + "/session/" + SID.id + "/abort", { method: "POST" }).catch(() => {})
await new Promise(r => setTimeout(r, 15000))

check = await (await fetch(BASE + "/session/" + SID.id + "/exec", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command: "ls /tmp/opencode-mcp/*9100.pid /tmp/opencode-mcp/*9100.log 2>/dev/null || true" }),
})).json().catch(e => ({ stdout: "sandbox destroyed" }))
console.log("after cleanup:", check.stdout || "")
'
```

**期望**：启动后存在 pid/log；session sandbox 回收后 pid/log 被删除，supergateway 进程不再存在。

### T22.20 不存在 session 当前语义

> 当前实现未在 session MCP handler 中前置校验 session 存在性：list/delete 是幂等操作，create 依赖数据库 FK 失败。

```bash
bun -e '
const BASE = "http://localhost:14096"
const SID = "ses_NOTEXIST_MCP"

const list = await fetch(BASE + "/session/" + SID + "/mcps")
const create = await fetch(BASE + "/session/" + SID + "/mcps/create", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ name: "ghost", type: "local", command: ["echo", "ghost"] }),
})
const del = await fetch(BASE + "/session/" + SID + "/mcps/ghost", { method: "DELETE" })

const rows = await list.json().catch(() => undefined)
console.log("list:", list.status, "(expect 200)")
console.log("list length:", Array.isArray(rows) ? rows.length : "n/a", "(expect 0)")
console.log("create:", create.status, "(expect 500 due FK)")
console.log("delete:", del.status, "(expect 200)")
'
```

**期望**：list 返回 200 空数组，create 返回 500（FK 约束），delete 返回 200。

---

## 结果汇总

| 用例 | 状态 | 备注 |
|---|---|---|
| T22.1 | ✅ | 创建会话级 local MCP（command + environment） |
| T22.2 | ✅ | 创建会话级 remote MCP（url + headers） |
| T22.3 | ✅ | 列出会话 MCP，local + remote 同列 |
| T22.4 | ✅ | Upsert 更新同名 MCP（local→remote） |
| T22.5 | ✅ | 删除单个 MCP → 200，记录消失 |
| T22.6 | ✅ | 清空所有 MCP → 200，列表为空 |
| T22.7 | ✅ | 不同 session 同名 MCP 互相隔离 |
| T22.8 | ✅ | 删除 session 后 MCP 级联清理；GET mcps 返回 200 空数组 |
| T22.9 | ✅ | 不存在 session → create=500(FK), list=200([]), delete=200 |
| T22.10 | ✅ | 输入校验：缺 name/缺 type/非法 type → 400 |
| T22.11 | ✅ | remote 完整字段持久化（url/headers/enabled） |
| T22.12 | ✅ | disabled MCP 的 enabled=false 持久化 |
| T22.13 | ✅ | Remote MCP 工具执行验证：ev_echo 工具成功调用，输出 Echo: hello |
| T22.14 | ✅ | Local MCP 在 Sandbox 中执行验证：sandbox-everything_echo 工具成功调用，输出 Echo: hello-sandbox-mcp |
| T22.15 | ✅ | Session MCP 工具多轮对话持续可用：3 轮 3 次调用全部成功 |
| T22.16 | ⬜ | 严格输入校验：local command 必填且非空，remote url 必填 |
| T22.17 | ⬜ | local MCP environment 实际注入 sandbox 进程 |
| T22.18 | ⬜ | shell 安全：恶意 name/env/command 不产生注入 |
| T22.19 | ⬜ | local MCP pid/log 生命周期与清理 |
| T22.20 | ⬜ | 不存在 session 当前语义：create=500(FK), list=200([]), delete=200 |

## 单元测试覆盖

Service 层单测（内存 mock）：`packages/opencode/test/mcp/session-mcp-crud.test.ts`（16 用例）

Sandbox MCP 路由单测：`packages/opencode/test/mcp/session-mcp.test.ts`（9 用例）
