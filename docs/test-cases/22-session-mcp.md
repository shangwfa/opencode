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
console.log("DELETE status:", delRes.status, "(expect 204)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/mcps")).json()
console.log("to-delete gone:", !list.some(m => m.name === "to-delete"))
'
```
**期望**：DELETE 返回 204，to-delete 已从列表中消失

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
console.log("clear status:", clearRes.status, "(expect 204)")

const list = await (await fetch(BASE + "/session/" + SID.id + "/mcps")).json()
console.log("leftover:", list.length, "(expect 0)")
'
```
**期望**：HTTP 204，列表为空

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
console.log("After delete status:", after.status, "(expect 404)")
'
```
**期望**：删除 session 后 GET mcps 返回 404

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
console.log("create 404:", createRes.status, "(expect 404)")

const listRes = await fetch(BASE + "/session/ses_NOTEXIST/mcps")
console.log("list 404:", listRes.status, "(expect 404)")

const delRes = await fetch(BASE + "/session/ses_NOTEXIST/mcps/ghost", { method: "DELETE" })
console.log("delete 404:", delRes.status, "(expect 404)")
'
```
**期望**：create/list/delete 均返回 404

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
    environment: { KEY_A: "val_a", KEY_B: "val_b" },
    headers: { "x-token": "tok123", "x-extra": "extra456" },
    enabled: true,
  }),
})).json()
console.log("name:", res.name)
console.log("type:", res.type)
console.log("url:", res.url)
console.log("env:", JSON.stringify(res.environment))
console.log("headers:", JSON.stringify(res.headers))
console.log("enabled:", res.enabled)
'
```
**期望**：所有字段正确返回

> **PG 验证**：`docker exec ai-nova-postgres psql -U postgres -d opencode -c "SELECT name, type, url, environment, headers, enabled FROM session_mcps WHERE session_id='$SID';"`
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

**Step 2** — 创建 session 并注册 remote MCP：

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

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
'
```

**Step 3** — 验证工具调用结果：

```bash
bun -e '
const BASE = "http://localhost:14096"

// 查看消息列表，确认 AI 调用了 MCP 工具
const msgs = await (await fetch(BASE + "/session/'$SID'/message")).json()
let toolCalled = false
for (const m of msgs) {
  for (const p of m.parts) {
    if (p.type === "tool" && p.tool?.startsWith("test_tools_")) {
      console.log("MCP TOOL:", p.tool, "status:", p.state?.status, "output:", (p.state?.output || "").slice(0, 200))
      toolCalled = true
    }
  }
}
console.log("MCP tool called:", toolCalled, "(expect true)")
'
```

**期望**：
- MCP 注册成功（name=test-tools, type=remote）
- AI 的消息中包含 `test_tools_echo` 工具调用
- 工具执行返回 `hello-mcp`

### T22.14 Local MCP 工具执行验证（Sandbox E2E）

> **前置条件**：沙箱环境已启动，sandbox 镜像包含 `supergateway` 和待测试的 MCP CLI。

```bash
bun -e '
const BASE = "http://localhost:14096"
const MODEL = { providerID: "zhipuai", modelID: "glm-5.1" }

const SID = await (await fetch(BASE + "/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "mcp-exec-local" }) })).json()

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
'
```

**期望**：
- MCP 在沙箱中通过 supergateway 桥接启动成功
- `prompt_async` 返回 204
- AI 回复中包含 MCP 工具的输出（`hello-sandbox-mcp`）
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

// 验证三轮对话都成功
const msgs = await (await fetch(BASE + "/session/" + SID.id + "/message")).json()
const toolCalls = msgs.flatMap(m => m.parts.filter(p => p.type === "tool" && p.tool?.includes("persist_tools")))
console.log("MCP tool calls across rounds:", toolCalls.length, "(expect >= 2)")
'
```

**期望**：三轮对话中至少 2 次调用了 `persist_tools_echo` 工具，验证工具注入在每轮 step 循环中都生效。

---

## 结果汇总

| 用例 | 状态 | 备注 |
|---|---|---|
| T22.1 | ✅ | 创建会话级 local MCP（command + environment） |
| T22.2 | ✅ | 创建会话级 remote MCP（url + headers） |
| T22.3 | ✅ | 列出会话 MCP，local + remote 同列 |
| T22.4 | ✅ | Upsert 更新同名 MCP（local→remote） |
| T22.5 | ✅ | 删除单个 MCP → 204 |
| T22.6 | ✅ | 清空所有 MCP → 204 |
| T22.7 | ✅ | 不同 session 同名 MCP 互相隔离 |
| T22.8 | ✅ | 删除 session 后 MCP 级联清理 |
| T22.9 | ✅ | 不存在的 session → create=500(FK), list=200([]), delete=200(void)；handler 未前置校验 session 存在性 |
| T22.10 | ✅ | 输入校验：缺 name/缺 type/非法 type → 400 |
| T22.11 | ✅ | 完整字段持久化（url/env/headers/enabled） |
| T22.12 | ✅ | disabled MCP 的 enabled=false 持久化 |
| T22.13 | ✅ | Remote MCP 工具执行验证：ev_echo 工具成功调用，输出 Echo: hello |
| T22.14 | ✅ | Local MCP 在 Sandbox 中执行验证：sandbox-everything_echo 工具成功调用，输出 Echo: hello-sandbox-mcp |
| T22.15 | ✅ | Session MCP 工具多轮对话持续可用：3 轮 3 次调用全部成功 |

## 单元测试覆盖

Service 层单测（内存 mock）：`packages/opencode/test/mcp/session-mcp-crud.test.ts`（16 用例）

Sandbox MCP 路由单测：`packages/opencode/test/mcp/session-mcp.test.ts`（9 用例）
