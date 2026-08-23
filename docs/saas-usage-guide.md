# OpenCode SaaS 使用指南

面向接入方的 API 使用文档。后端服务部署及内部架构见 `deployment.md` / `saas-architecture.md`。

## 快速链接

- 测试环境：`https://test-opencode.shadow-rpa.net`
- 健康检查：`GET /global/health`
- API 文档（OpenAPI）：`GET /doc`

---

## 一、核心概念

| 概念 | 说明 |
|---|---|
| **Session** | 一次会话，包含完整对话历史、配置、关联沙箱 |
| **Message** | session 内的单条消息，包含多个 part |
| **Part** | 消息的子结构：text / reasoning / tool / step-start / step-finish 等 |
| **Provider** | AI 服务商（moonshotai-cn / anthropic / opencode ...） |
| **Model** | provider 下的具体模型（kimi-k2.6 / claude-sonnet-4 ...） |
| **Agent** | 角色 / 模式：build（默认）/ plan / general / explore |
| **Sandbox** | 远程隔离的代码执行环境，工具调用都在沙箱里执行 |
| **PVC** | 沙箱挂载的持久卷，文件跨 session/沙箱 重启持久化 |
| **/workspace** | 沙箱内的工作目录，所有文件操作默认根目录 |

---

## 二、5 分钟接入

### Step 1：探测服务

```bash
curl https://test-opencode.shadow-rpa.net/global/health
# → {"healthy":true,"version":"local"}
```

### Step 2：配置 Provider 凭据（一次性）

```bash
curl -X PUT https://test-opencode.shadow-rpa.net/auth/moonshotai-cn \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-YOUR_KEY"}'
# → true
```

凭据持久化到 PG，服务重启不丢。可用的 provider 见 `GET /provider`。

### Step 3：创建 Session

```bash
SID=$(curl -s -X POST https://test-opencode.shadow-rpa.net/session \
  -H 'Content-Type: application/json' \
  -d '{}' | jq -r .id)
echo "session: $SID"
```

可选 body：
```json
{
  "title": "我的会话",
  "parentID": "ses_xxx"          // 用于 fork
}
```

### Step 4：发消息

```bash
curl -X POST https://test-opencode.shadow-rpa.net/session/$SID/message \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"hello"}],
    "model": {"providerID":"moonshotai-cn","modelID":"kimi-k2.6"}
  }'
```

返回完整的 assistant 消息（含 reasoning / tool / text）。

### Step 5：触发工具调用

```bash
curl -X POST https://test-opencode.shadow-rpa.net/session/$SID/message \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"使用 bash 工具执行 ls /workspace"}],
    "model": {"providerID":"moonshotai-cn","modelID":"kimi-k2.6"}
  }'
```

AI 会自动判断需要工具，调用沙箱执行命令并返回结果。

---

## 三、完整 API 参考

### 3.1 元信息

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/global/health` | 健康检查 |
| GET | `/global/config` | 全局配置 |
| PATCH | `/global/config` | 修改全局配置（默认模型、agent 配置等） |
| GET | `/path` | 路径信息（cwd/home/state...） |
| GET | `/doc` | OpenAPI 规范 |
| GET | `/global/event` | **全局** SSE 事件流（所有 session 的事件） |
| GET | `/event?sessionID=ses_xxx` | **指定 session** 的 SSE 事件流（推荐） |

### 3.2 Auth / Provider 凭据管理

| 方法 | 路径 | 说明 |
|---|---|---|
| PUT | `/auth/:providerID` | 设置凭据 `{type:"api",key:"..."}` |
| DELETE | `/auth/:providerID` | 删除凭据 |
| GET | `/provider` | 列出所有 provider 及连接状态 |

#### 设置凭据

```bash
curl -X PUT https://test-opencode.shadow-rpa.net/auth/moonshotai-cn \
  -H 'Content-Type: application/json' \
  -d '{"type":"api","key":"sk-YOUR_KEY"}'
# → true
```

凭据持久化到 PG（或 `auth.json`），服务重启不丢。

#### 查询已连接的 Provider

```bash
# 方式 1：查看已连接的 provider ID 列表
curl -s https://test-opencode.shadow-rpa.net/provider | jq '.connected'
# → ["deepseek", "zhipuai", "moonshotai-cn", "opencode"]

# 方式 2：查看所有 provider 及其模型
curl -s https://test-opencode.shadow-rpa.net/provider | jq '.all[] | {id, models: [.models[].id]}'

# 方式 3：查看某个 provider 的可用模型
curl -s https://test-opencode.shadow-rpa.net/provider | jq '[.all[] | select(.id == "moonshotai-cn")] | .[0].models[].id'
# → "kimi-k2-turbo-preview"
# → "kimi-k2.6"
# → "kimi-k2-thinking-turbo"
# → ...
```

> **注意**：API key 出于安全原因不会通过任何接口返回。只能通过 `connected` 列表判断是否已配置 key。

#### 查看支持的认证方式

```bash
curl -s https://test-opencode.shadow-rpa.net/provider/auth | jq '.["openai"]'
# → [
#     {"type":"oauth","label":"ChatGPT Pro/Plus (browser)"},
#     {"type":"oauth","label":"ChatGPT Pro/Plus (headless)"},
#     {"type":"api","label":"Manually enter API Key"}
#   ]
```

### 3.3 Session

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/session` | 列出所有 session |
| POST | `/session` | 创建 session |
| GET | `/session/:sessionID` | 详情 |
| PATCH | `/session/:sessionID` | 修改 title 等 |
| DELETE | `/session/:sessionID` | 删除 session + 关联 PVC volume + 全部快照 |
| POST | `/session/:sessionID/fork` | fork 一个新 session |
| POST | `/session/:sessionID/share` | 生成分享链接 |
| POST | `/session/:sessionID/snapshot` | 沙箱快照（快照模式下，异步创建） |
| GET | `/session/:sessionID/snapshot` | 最新快照状态查询 |

**创建参数（body 可选字段）**：`parentID` / `title` / `agent` / `model` / `metadata` / `permission` / `workspaceID` / `pvcMode` / `appId` / `sandbox`

`sandbox` 对象（沙箱资源与启动源，子会话自动继承）：

```json
{
  "sandbox": {
    "cpu": "1",              // 必填：如 "1" / "0.5" / "500m"
    "memory": "2Gi",         // 必填：如 "2Gi" / "512Mi"
    "image": "registry/…",   // 可选：会话级沙箱镜像（覆盖部署默认值）
    "snapshotId": "uuid"     // 可选：从指定快照恢复（环境派生/回滚，优先级最高）
  }
}
```

### 3.4 消息

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/session/:sessionID/message` | 获取所有消息历史 |
| POST | `/session/:sessionID/message` | **同步发消息**（流式返回完整结果） |
| POST | `/session/:sessionID/prompt_async` | **异步发消息**（立即返回 204） |
| POST | `/session/:sessionID/abort` | 中断当前 AI 处理 |
| GET | `/session/:sessionID/message/:messageID` | 单条消息详情 |
| GET | `/session/:sessionID/diff` | 消息引起的文件变更 |

### 3.5 Session Skills

Session Skill 是绑定到单个 session 的能力包，用于给某次任务注入专门的工作流、规则、参考文档或脚本模板。Skill 数据持久化在 PG 中，服务重启或多 pod 切换后仍可通过同一个 session 读取。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/session/:sessionID/skills` | 列出该 session 已绑定的 skills |
| POST | `/session/:sessionID/skills/create` | 创建或更新 session skill |
| POST | `/session/:sessionID/skills/load` | 从服务端本地目录加载 `SKILL.md` skill bundle |
| DELETE | `/session/:sessionID/skills/:name` | 删除指定 session skill |
| DELETE | `/session/:sessionID/skills` | 清空该 session 的所有 skills |

Skill 统一使用 bundle 模型：简单 skill 是 `resources: []` 的 bundle，复杂 skill 可以带文档、脚本和模板资源。

```json
{
  "name": "complex-reviewer",
  "description": "代码审查专家，使用内置 checklist 和模板检查数据库代码",
  "content": "# Complex Reviewer\n\n请根据 resources 中的 checklist 和模板审查代码。",
  "resources": [
    {
      "path": "references/security-checklist.md",
      "type": "doc",
      "content": "- SQL injection: direct string interpolation into SQL is HIGH severity."
    },
    {
      "path": "templates/safe-query.py",
      "type": "template",
      "content": "query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"
    }
  ]
}
```

`resources[].type` 可选值：`doc` / `script` / `template` / `asset`。

资源限制：单个 resource 最大 256KB，单个 skill bundle 最大 1MB，单个 skill 最多 64 个 resources。`path` 必须是相对路径，不能是绝对路径，也不能包含 `..`。

### 3.6 实例/沙箱

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/session/:sessionID/kill-sandbox` | **按 session 销毁沙箱**（PVC 保留，文件不丢） |
| POST | `/instance/dispose` | 销毁当前 instance 的所有沙箱（PVC 保留） |
| POST | `/global/dispose` | 销毁所有实例 |

### 3.7 沙箱文件管理

直接操作沙箱文件系统（不经 AI 消息）。沙箱不存在时自动创建（app 模式挂对应 PVC subPath）；`path` 参数为沙箱内绝对路径（`/workspace/...`），也接受 session 目录形式的 host 路径。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/session/:sessionID/files/mkdir?path=/workspace/newdir` | 创建目录（含多级，类似 `mkdir -p`） |
| POST | `/session/:sessionID/files/create?path=/workspace/foo.txt` | 创建文件（body 为文件内容原始字节，可空） |
| GET | `/session/:sessionID/files/download?path=/workspace/foo` | 下载指定文件或目录（目录自动打包） |
| POST | `/session/:sessionID/files/upload?path=/workspace/dir&filename=foo.bin` | 上传文件到指定目录（body 为原始字节） |

#### 创建目录

```bash
curl -X POST "https://test-opencode.shadow-rpa.net/session/$SID/files/mkdir?path=/workspace/project/src"
# → {"sessionID":"ses_xxx","path":"/workspace/project/src","created":true}
```

多级目录自动递归创建，已存在不报错（幂等）。

#### 创建文件

```bash
# body 为文件内容（可为空，创建空文件）
curl -X POST "https://test-opencode.shadow-rpa.net/session/$SID/files/create?path=/workspace/project/src/app.py" \
  --data-binary 'print("hello")'
# → {"sessionID":"ses_xxx","path":"/workspace/project/src/app.py","size":15,"created":true}
```

父目录自动创建，同路径已存在时覆盖写。单文件上限 512MB，超限返回 413。

#### 下载

```bash
# 文件：返回原始字节，Content-Type 按扩展名推断（mime-types），带 Content-Disposition
curl -o report.md "https://test-opencode.shadow-rpa.net/session/$SID/files/download?path=/workspace/report.md"

# 目录：沙箱内用 python zipfile 打包为 zip 后流式返回，带 Content-Length
curl -o project.zip "https://test-opencode.shadow-rpa.net/session/$SID/files/download?path=/workspace/project"
```

支持任意格式文件（文本/图片/PDF/二进制等，Content-Type 用 `mime-types` 按扩展名推断，未知回退 `application/octet-stream`）。目录**统一打包为 zip**（沙箱内 python `zipfile` 实现，不依赖系统 zip 命令；空目录也含根条目）。打包在沙箱 `/tmp`（overlay，不占 PVC）完成，回传后自动清理临时文件。path 不存在返回 404。

#### 上传

```bash
# body 为文件原始字节（非 multipart）
curl -X POST "https://test-opencode.shadow-rpa.net/session/$SID/files/upload?path=/workspace/data&filename=model.bin" \
  --data-binary @model.bin
# → {"sessionID":"ses_xxx","path":"/workspace/data/model.bin","filename":"model.bin","size":1048576}
```

目标目录不存在时自动创建（含多级）。流式写入，单文件上限 512MB，超限返回 413。`filename` 必须是纯文件名（不含 `/`）。上传同路径文件为覆盖写。

#### 前端 fetch 示例

```typescript
// 创建目录
await fetch(`${baseURL}/session/${sid}/files/mkdir?path=/workspace/project`, { method: "POST" })

// 创建文件
await fetch(`${baseURL}/session/${sid}/files/create?path=/workspace/project/app.py`, {
  method: "POST",
  body: "print('hello')",
})

// 上传
await fetch(`${baseURL}/session/${sid}/files/upload?path=/workspace/data&filename=model.bin`, {
  method: "POST",
  body: file,  // File/Blob 直接作为 body
})

// 下载（触发浏览器保存）
const a = document.createElement("a")
a.href = `${baseURL}/session/${sid}/files/download?path=${encodeURIComponent(path)}`
a.click()
```

四个接口都会在 `exec_log` 表留下 `file-mkdir` / `file-create` / `file-download` / `file-upload` 记录，可通过 `GET /session/:id/execs` 审计。

---

## 四、核心使用模式

### 4.1 同步对话（小任务推荐）

```typescript
const res = await fetch(`/session/${sid}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "1+1等于几" }],
    model: { providerID: "moonshotai-cn", modelID: "kimi-k2.6" }
  })
})
const msg = await res.json()
const text = msg.parts.find(p => p.type === "text")?.text
```

**返回结构**：
```json
{
  "info": {
    "id": "msg_xxx",
    "sessionID": "ses_xxx",
    "role": "assistant",
    "modelID": "kimi-k2.6",
    "providerID": "moonshotai-cn",
    "cost": 0.001,
    "tokens": { "input": ..., "output": ... },
    "time": { "created": ..., "completed": ... },
    "finish": "stop"
  },
  "parts": [
    { "type": "step-start", ... },
    { "type": "reasoning", "text": "AI 内心思考..." },
    { "type": "tool", "tool": "bash", "state": { "status": "completed", "output": "..." } },
    { "type": "text", "text": "AI 给用户的回答" },
    { "type": "step-finish", ... }
  ]
}
```

### 4.2 SSE 事件流（实时监听 AI 进度）

#### 4.2.1 订阅方式

```
GET /event?sessionID={sid}    ← 只收该 session 的事件（推荐）
GET /global/event             ← 收所有 session 的事件（运维/大盘）
```

返回 `text/event-stream`，标准 SSE 协议（`data:` 前缀 + `\n\n` 分隔）。

#### 4.2.2 完整事件类型

| 事件 type | properties 结构 | 说明 |
|---|---|---|
| `server.connected` | `{}` | SSE 连接建立，**第一个事件** |
| `server.heartbeat` | `{}` | 10s 心跳保活，无业务含义 |
| `message.updated` | `{ sessionID, info }` | 消息元信息变化（创建、token 累计、完成等） |
| `message.part.updated` | `{ sessionID, part, time }` | **核心事件**：单个 part 增量（reasoning/text/tool） |
| `session.updated` | `{ sessionID, info }` | session 元数据变化（title、summary、time 等） |
| `session.status` | `{ sessionID, status: { type } }` | 状态机：`"busy"` → `"idle"` |
| `session.idle` | `{ sessionID }` | 空闲状态（与 `session.status.idle` 同时发出） |
| `session.diff` | `{ sessionID, diff: [...] }` | 工具操作引起的文件变更摘要 |
| `session.error` | `{ sessionID, error }` | LLM 或工具调用异常 |
| `server.instance.disposed` | `{}` | 实例被销毁，SSE 流结束 |

#### 4.2.3 事件时序（实际测试结果）

一次完整的「发消息 → AI 回复」事件序列：

```
1. server.connected                          ← SSE 连接建立
2. message.updated   { role: "user" }        ← 用户消息创建
3. message.part.updated { part: { type: "text", text: "..." } }
4. session.updated                           ← session 元数据更新
5. session.status    { status: { type: "busy" } }  ← AI 开始处理
6. message.updated   { role: "assistant" }   ← assistant 消息创建
  ┌ message.part.updated { part: { type: "reasoning", text: "..." } }  ← AI 思考（可选）
  ├ message.part.updated { part: { type: "text", text: "部分文字..." } }  ← 流式输出
  ├ message.part.updated { part: { type: "text", text: "更多文字..." } }
  ├ message.part.updated { part: { type: "tool", tool: "bash", state: {...} } }  ← 工具调用
  └ message.part.updated { part: { type: "text", text: "最终回答" } }
7. session.diff      { diff: [...] }         ← 文件变更（有写操作时）
8. session.status    { status: { type: "idle" } }  ← AI 处理完成
9. session.idle                              ← 空闲确认
10. message.updated  { finish: "stop" }      ← assistant 消息完成
```

#### 4.2.4 同步对话 + SSE 监听

`POST /session/{sid}/message` 是同步接口（等 AI 回复完才返回），但你可以**同时**订阅 SSE 来获取流式进度：

```typescript
// 1. 先建立 SSE 连接
const sse = new EventSource(`/event?sessionID=${sid}`)

sse.onmessage = (e) => {
  const ev = JSON.parse(e.data)

  switch (ev.type) {
    case "server.connected":
      console.log("SSE 已连接")
      break

    case "message.part.updated": {
      const { part } = ev.properties
      switch (part.type) {
        case "reasoning":
          // AI 思考过程（部分模型支持）
          process.stdout.write(`[思考] ${part.text}`)
          break
        case "text":
          // AI 文本输出（流式，可能多次触发）
          process.stdout.write(part.text)
          break
        case "tool":
          // 工具调用状态更新
          console.log(`[工具] ${part.tool} → ${part.state?.status}`)
          if (part.state?.output) {
            console.log(`  输出: ${part.state.output.slice(0, 200)}`)
          }
          break
      }
      break
    }

    case "session.status":
      console.log(`状态: ${ev.properties.status.type}`)  // busy / idle
      if (ev.properties.status.type === "idle") {
        sse.close()  // AI 处理完成，关闭连接
      }
      break

    case "session.error":
      console.error("出错:", ev.properties.error.data?.message)
      sse.close()
      break

    case "server.heartbeat":
      // 10s 心跳，忽略即可
      break
  }
}

sse.onerror = () => {
  console.log("SSE 连接断开")
  sse.close()
}

// 2. 发送同步消息（HTTP 请求会等到 AI 回复完才返回）
//    SSE 在后台同时接收流式事件
const res = await fetch(`/session/${sid}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "介绍下你自己" }],
    model: { providerID: "zhipuai", modelID: "glm-5.1" }
  })
})
const msg = await res.json()
sse.close()

console.log("完整回复:", msg.parts.find(p => p.type === "text")?.text)
```

#### 4.2.5 异步对话 + SSE 监听（长任务推荐）

`POST /session/{sid}/prompt_async` 立即返回 204，AI 在后台运行。**必须**搭配 SSE 获取结果：

```typescript
// 1. 先订阅 SSE
const sse = new EventSource(`/event?sessionID=${sid}`)

sse.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  switch (ev.type) {
    case "message.part.updated": {
      const { part } = ev.properties
      if (part.type === "text") process.stdout.write(part.text)
      if (part.type === "tool") console.log(`\n[工具] ${part.tool}`)
      break
    }
    case "session.status":
      if (ev.properties.status.type === "idle") {
        console.log("\n=== 任务完成 ===")
        sse.close()
      }
      break
    case "session.error":
      console.error("错误:", ev.properties.error.data?.message)
      sse.close()
      break
  }
}

// 2. 发起异步任务（立即返回 204）
await fetch(`/session/${sid}/prompt_async`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "分析 /workspace 下的代码结构" }],
    model: { providerID: "zhipuai", modelID: "glm-5.1" }
  })
})
// 函数返回了，但 SSE 还在接收事件
```

#### 4.2.6 错误事件结构

当 LLM API 出错时，`session.error` 的 `properties.error` 结构：

```json
{
  "name": "APIError",
  "data": {
    "message": "令牌已过期或验证不正确",
    "statusCode": 401,
    "isRetryable": false,
    "metadata": {
      "url": "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    },
    "responseBody": "{\"error\":{\"code\":\"401\",\"message\":\"...\"}}"
  }
}
```

常见错误码：
- `401`：API key 无效或过期 → 需要重新 `PUT /auth/:providerID`
- `429`：限流 → `isRetryable: true`，稍后重试
- `500`：上游服务异常 → 稍后重试

#### 4.2.7 curl 测试 SSE

```bash
# 实时查看某个 session 的所有事件
curl -sN "https://test-opencode.shadow-rpa.net/event?sessionID=ses_xxx"

# 输出示例：
# data: {"type":"server.connected","properties":{}}
# data: {"type":"session.status","properties":{"sessionID":"ses_xxx","status":{"type":"busy"}}}
# data: {"type":"message.part.updated","properties":{"sessionID":"ses_xxx","part":{"type":"text","text":"你好"}}}
```

`-N` 参数禁用缓冲，确保实时输出。

#### 4.2.8 全局事件流

监控所有 session（运维、多用户大盘）：

```typescript
const sse = new EventSource(`/global/event`)
sse.onmessage = (e) => {
  const ev = JSON.parse(e.data)
  // 所有事件都带 properties.sessionID，用来区分不同会话
  console.log(`[${ev.properties.sessionID}] ${ev.type}`)
}
```

#### 4.2.9 轮询 fallback（不支持 SSE 的场景）

```typescript
// 定时拉消息历史
const msgs = await fetch(`/session/${sid}/message`).then(r => r.json())
const last = msgs[msgs.length - 1]
if (last.info.finish === "stop") {
  // 任务完成
}
```

### 4.3 Session Skills（任务能力包）

Session Skills 用于给某个 session 临时绑定专业能力。它适合以下场景：
- 给单次任务注入审查规则、编码规范或 SOP
- 给 AI 提供参考文档、脚本模板、命令片段
- 同一个 SaaS 服务里不同 session 使用不同技能，不互相影响
- 多 pod 部署时通过 PG 持久化，任意 pod 都能读到同一个 session 的 skills

#### 4.3.1 创建简单 skill

简单 skill 只需要 `name`、`description`、`content`，`resources` 可省略。

```bash
SID=$(curl -s -X POST https://test-opencode.shadow-rpa.net/session \
  -H 'Content-Type: application/json' \
  -d '{"title":"代码审查"}' | jq -r .id)

curl -X POST https://test-opencode.shadow-rpa.net/session/$SID/skills/create \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "reviewer",
    "description": "代码审查专家，专注发现 bug 和安全问题",
    "content": "# Reviewer\n\n审查代码时输出：严重程度、问题描述、修复建议。"
  }'
```

#### 4.3.2 创建复杂 skill bundle

复杂 skill 可以带 `resources`，用于放参考文档、脚本或模板。模型只有在请求里通过 `skills` 预加载时才会收到完整资源内容。

```bash
curl -X POST https://test-opencode.shadow-rpa.net/session/$SID/skills/create \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "complex-reviewer",
    "description": "使用 checklist 和模板审查 Python 数据库代码",
    "content": "# Complex Reviewer\n\n你必须根据 resources 中的 checklist 和模板审查代码。",
    "resources": [
      {
        "path": "references/security-checklist.md",
        "type": "doc",
        "content": "Checklist:\n- SQL injection: direct string interpolation into SQL is HIGH severity.\n- Resource leak: DB connection without context manager or close is HIGH severity.\n- Return concrete rows, not raw cursors."
      },
      {
        "path": "templates/safe-query.py",
        "type": "template",
        "content": "query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"
      }
    ]
  }'
```

#### 4.3.3 触发 skill 执行

发消息时传 `skills` 数组。服务会把指定 skill 的 `content` 和 `resources` 注入 system prompt。

```bash
curl -X POST https://test-opencode.shadow-rpa.net/session/$SID/message \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{
      "type": "text",
      "text": "请使用 complex-reviewer skill 审查这段代码：\n```python\ndef get_user(user_id):\n    query = f\"SELECT * FROM users WHERE id = {user_id}\"\n    conn = db.connect()\n    result = conn.execute(query)\n    return result\n```"
    }],
    "skills": ["complex-reviewer"],
    "model": {"providerID":"zhipuai","modelID":"glm-5.1"}
  }'
```

预期模型会引用 `references/security-checklist.md` 和 `templates/safe-query.py`，并按 skill 规则输出审查结果。

#### 4.3.4 查看和删除 skills

```bash
# 列出 session skills
curl https://test-opencode.shadow-rpa.net/session/$SID/skills

# 删除单个 skill
curl -X DELETE https://test-opencode.shadow-rpa.net/session/$SID/skills/complex-reviewer

# 清空 session skills
curl -X DELETE https://test-opencode.shadow-rpa.net/session/$SID/skills
```

#### 4.3.5 从目录加载 skill bundle

`POST /session/:sessionID/skills/load` 会扫描服务端可访问目录下的 `SKILL.md`。每个 `SKILL.md` 所在目录会被当作一个 bundle 根目录，除 `SKILL.md` 外的文件会作为 resources 读取。

目录示例：

```text
skills/complex-reviewer/
├── SKILL.md
├── references/security-checklist.md
└── templates/safe-query.py
```

`SKILL.md`：

```markdown
---
name: complex-reviewer
description: 使用 checklist 和模板审查 Python 数据库代码
---

# Complex Reviewer

你必须根据 resources 中的 checklist 和模板审查代码。
```

加载：

```bash
curl -X POST https://test-opencode.shadow-rpa.net/session/$SID/skills/load \
  -H 'Content-Type: application/json' \
  -d '{"path":"/workspace/skills"}'
```

资源类型推断规则：
- `references/` 下文件默认是 `doc`
- `templates/` 下文件默认是 `template`
- `.md`、`.mdx`、`.txt` 是 `doc`
- `.sh`、`.bash`、`.zsh`、`.py`、`.js`、`.ts` 是 `script`
- 其他是 `asset`

#### 4.3.6 使用注意

- `resources` 不会出现在普通可用 skill 列表的 prompt 内容中，只有通过 `skills` 预加载时才注入。
- `resources[].path` 必须是相对路径，禁止绝对路径和 `..`。
- 单个 resource 最大 256KB，单个 bundle 最大 1MB，单个 skill 最多 64 个 resources。
- 同名 session skill 会覆盖更新，不会创建重复项。
- 删除 session 时，对应 session skills 会一起清理。

### 4.4 工具调用（含沙箱）

让 AI 操作沙箱里的文件 / 执行命令：

```typescript
// 写文件
await sendMessage(sid, "使用 write 工具在 /workspace 创建 app.py，内容是 print('hi')")

// 读文件
await sendMessage(sid, "使用 bash cat /workspace/app.py")

// 执行
await sendMessage(sid, "使用 bash 运行 python /workspace/app.py")
```

**最佳实践**：prompt 里**明确指定工具名**（`使用 bash 工具`、`使用 write 工具`），避免模型幻觉。

### 4.5 多轮对话

```typescript
// 第一轮
await sendMessage(sid, "记住我叫张三")

// 第二轮（自动带上下文）
await sendMessage(sid, "我叫什么？")
// → "张三"
```

session 内消息历史自动注入，无需手动管理。

### 4.6 沙箱生命周期

```typescript
// 1. 首次发消息会自动创建沙箱 Pod（~2-3 秒延迟）
await sendMessage(sid, "ls /workspace")

// 2. 沙箱空闲 3600 秒（1 小时）后自动回收（OPENCODE_SANDBOX_IDLE_KILL_SEC=3600，可在部署时调小）
//    也可手动立即销毁
await fetch("/instance/dispose", { method: "POST" })

// 3. 再次发消息会重新创建沙箱，挂载同一 PVC，文件仍在
await sendMessage(sid, "cat /workspace/app.py")
// → 文件仍可读
```

**默认回收策略（部署时已配置）**：

| 配置项 | 默认值 | 含义 |
|---|---|---|
| `OPENCODE_SANDBOX_IDLE_KILL_SEC` | `3600` 秒 | 空闲超过 N 秒后回收 |
| `OPENCODE_SANDBOX_MAX_TTL_SEC` | `3600` 秒 | 沙箱最长存活时间（K8s 层强制） |
| 内部轮询间隔 | `30` 秒（硬编码） | 检查频率，最坏额外等待 30s |

**实际回收延迟**：30~60 秒（空闲阈值 + 轮询窗口）。

### 4.6b Session Plugins 生命周期（重要）

> **插件在沙箱内执行**：会话插件（`POST /session/:id/plugins/create`）的代码不在主服务进程运行，而是由**会话沙箱内**的 plugin-agent（`:9200`）加载执行，主服务通过沙箱代理 HTTP 调用 hook。因此**插件的存活与沙箱生命周期严格绑定**。

```typescript
// 1. 注册插件后首次发消息/触发 hook 时，主服务在沙箱内启动 plugin-agent（首次约 5~10 秒）
await createPlugin(sid, { name: "my-hook", code: "export default async () => ({...})" })
await sendMessage(sid, "hello")   // 本次请求若在 agent 就绪前到达，hook 静默跳过（不报错）

// 2. 非 keepAlive 会话：沙箱空闲回收后，插件 agent 随沙箱销毁
//    （默认 IDLE_KILL_SEC 后回收；message 结束到回收窗口内 agent 仍在）
// 3. 下次请求沙箱重建 → plugin-agent 重新启动并重新加载插件（有插件列表的会话自动完成）
```

**产品语义**：

| 场景 | 行为 |
|---|---|
| keepAlive 会话 | 沙箱常驻 → agent 常驻，hook 稳定生效（**推荐开启**：`POST /session/:id/keep-alive {"enabled":true}`） |
| 非 keepAlive 会话 | agent 随沙箱回收销毁；下次请求重建沙箱+agent，hook 重新可用，但每次重建有 ~5-10s 启动窗口 |
| agent 启动窗口内到达的请求 | hook 静默跳过（返回未修改的 output，**不报错不阻塞**） |
| 插件 hook 代码抛异常 | 降级返回未修改 output + 服务端 logError（`session plugin hook failed`），**不会 500 请求** |
| 插件更新（同名 upsert） | agent 自动 reload 新版本（约 1s TTL 检测），无需重启会话 |
| 快照模式会话 | agent 不入快照（沙箱重建后按 PG 中的插件记录重新启动加载） |


### 4.6a 快照模式（沙箱本地盘持久化）

> **会话级可选**：创建会话时 `sandbox.persistMode: "snapshot" | "pvc"` 按会话选择持久化方式，创建时固化（fork/子会话继承）；缺省回退部署默认 `OPENCODE_SANDBOX_VOLUME_TYPE`。快照能力总开关 `OPENCODE_SANDBOX_SNAPSHOT_ENABLED=true`（未开时会话选 snapshot 返回 400；全局默认为 snapshot 时也必须开，否则服务拒绝启动）。详见 `docs/sandbox-snapshot-design.md`。

```bash
# 会话级指定快照模式（全局默认 pvc 时）
curl -X POST $BASE/session -d '{"sandbox":{"cpu":"1","memory":"2Gi","persistMode":"snapshot"}}'
# 会话级指定 PVC 模式（全局默认 snapshot 时）
curl -X POST $BASE/session -d '{"sandbox":{"cpu":"1","memory":"2Gi","persistMode":"pvc"}}'
```

**行为变化**：

- workspace 在沙箱本地盘（rootfs），不再挂 NFS PVC——小文件/元数据性能大幅提升
- 空闲回收前**自动快照**：**快照 Ready 才销毁沙箱**（失败保留沙箱重试，代码不丢），下次发消息**从快照秒级恢复**（数据 + 依赖缓存完整）
- 快照 Ready 后快照 id 自动写入 `metadata.sandboxSnapshot`（`GET /session` 可见）
- 会话删除自动清理全部快照（含用户数据不留存）；同会话只保留最新快照（TTL 默认 7 天）

**业务侧用法**：

```bash
# 1. 关键节点手动快照（AI 完成重要任务后；沙箱继续运行不销毁）
curl -X POST $BASE/session/$SID/snapshot
# → {"snapshotId":"9629…","state":"creating"}，GET 同路径轮询到 ready

# 2. 从快照派生新会话（环境复用/时间点回滚）
curl -X POST $BASE/session -d '{"sandbox":{"cpu":"1","memory":"2Gi","snapshotId":"<id>"}}'
```

**沙箱启动优先级**：`sandbox.snapshotId`（显式）→ 会话自动快照 → `sandbox.image`（会话级镜像）→ 部署默认镜像；任一级失败自动降级到下一级。

**注意**：快照不保留进程/内存（dev server 需重启，但 node_modules 在，秒级）；`pvcMode` 是 PVC 模式内部的维度（session/app 卷粒度），快照会话传 `pvcMode`/`appId` 不生效也不报错。

---

### 4.6.1 主动 dispose 最佳实践

依赖空闲回收会有 30~60 秒的资源浪费窗口。**高并发或对资源敏感**的场景，强烈推荐**任务结束后主动 dispose**。

#### 模式 1：单次任务，用完即销

```typescript
async function oneShot(prompt: string) {
  const { id: sid } = await client.createSession()
  try {
    const result = await client.chat(sid, prompt)
    return result
  } finally {
    // 不管成功失败都释放（按 session 精确销毁）
    await fetch(`${baseURL}/session/${sid}/kill-sandbox`, { method: "POST" })
  }
}
```

适用：API 接口、批处理任务、定时作业。

#### 模式 1b：批量清理旧会话沙箱

```typescript
// 查询所有会话，关闭今天之前创建的沙箱
const sessions = await fetch(`${baseURL}/session`).then(r => r.json())
const cutoff = new Date()
cutoff.setHours(0, 0, 0, 0)

for (const s of sessions) {
  if (new Date(s.time.created) < cutoff) {
    await fetch(`${baseURL}/session/${s.id}/kill-sandbox`, { method: "POST" })
  }
}
```

#### 模式 2：会话上下文管理器

```typescript
class ManagedSession {
  constructor(private client: OpenCodeClient, public sid: string) {}

  static async create(client: OpenCodeClient, title?: string) {
    const { id } = await client.createSession(title)
    return new ManagedSession(client, id)
  }

  async chat(text: string) {
    return this.client.chat(this.sid, text)
  }

  /** 任务结束调用，释放沙箱（保留 session 历史） */
  async release() {
    await fetch(`${this.client.baseURL}/session/${this.sid}/kill-sandbox`, { method: "POST" })
  }

  /** 彻底删除 session + PVC 文件 */
  async destroy() {
    await this.client.deleteSession(this.sid)
  }
}

// 用法
const s = await ManagedSession.create(client, "代码评审")
try {
  await s.chat("评审 /workspace/src 的代码质量")
  await s.chat("生成评审报告到 /workspace/report.md")
} finally {
  await s.release()  // ← 立即释放沙箱
}
// session 历史保留，下次还能续作
```

#### 模式 3：用户离开页面时释放

前端 SPA 场景：

```typescript
// 监听页面卸载
window.addEventListener("beforeunload", () => {
  // 用 sendBeacon 保证请求发出
  navigator.sendBeacon(
    "https://test-opencode.shadow-rpa.net/instance/dispose",
    new Blob([], { type: "application/json" })
  )
})

// 或更激进：tab 不可见就释放
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    fetch("/instance/dispose", { method: "POST", keepalive: true })
  }
})
```

#### 模式 4：批量任务并发控制

```typescript
async function processBatch(tasks: string[]) {
  // 串行处理，每个任务后立即释放
  for (const task of tasks) {
    const { id: sid } = await client.createSession()
    await client.chat(sid, task)
    await client.disposeSandbox()  // ← 关键
  }
}
```

不释放的话，并发任务会让 K8s 节点资源紧张。

#### dispose API 对比

| API | 范围 | 用途 |
|---|---|---|
| `POST /session/:id/kill-sandbox` | 指定 session 的沙箱 | 按 session 精确销毁（推荐） |
| `POST /instance/dispose` | 当前 instance 的所有 session 沙箱 | 单个用户结束工作 |
| `POST /global/dispose` | 所有 instance 全部销毁 | 运维清理、紧急回收 |
| `DELETE /session/:id` | 删 session + 清 PVC subPath | 彻底删除（不可恢复） |

#### 注意事项

- **dispose ≠ delete**：dispose / kill-sandbox 只销毁沙箱 Pod，**session 历史和 PVC 文件都保留**
- **推荐使用 `kill-sandbox`**：按 session 精确销毁，不影响其他 session；`instance/dispose` 会销毁当前实例的所有沙箱
- **dispose 后续作**：再次发消息会自动创建新沙箱挂回同一 PVC，**冷启动延迟 2-3 秒**
- **频繁 dispose 会增加冷启动**：如果一个 session 高频对话，**不要每条消息都 dispose**
- **idle 兜底**：即使忘记 dispose，30~60 秒后也会自动回收，**不会无限占用资源**

### 4.7 文件上传到沙箱

**场景**：把客户端本地文件传到沙箱 `/workspace`，让 AI 处理。

#### 方法 A：文件上传 API（推荐，支持大文件流式上传）

```typescript
// body 直接传 File/Blob，不经过 AI 消息，无模型消耗
await fetch(`${baseURL}/session/${sid}/files/upload?path=/workspace&filename=data.csv`, {
  method: "POST",
  body: file,
})
// → {"sessionID":"ses_xxx","path":"/workspace/data.csv","filename":"data.csv","size":12345}
```

目录不存在自动创建，单文件上限 512MB。详见 [3.7 沙箱文件管理](#37-沙箱文件管理)。

#### 方法 B：base64 内联写入（小文件 < 1MB，不想直接调文件 API 时）

```typescript
import { readFileSync } from "fs"

const b64 = readFileSync("./data.csv").toString("base64")
await chat(sid, `
使用 bash 工具执行：
echo '${b64}' | base64 -d > /workspace/data.csv
`)
```

#### 方法 C：从外部 URL 下载（大文件 / 已托管）

```typescript
await chat(sid, `
使用 bash 工具从 https://example.com/data.csv 下载到 /workspace/data.csv：
wget -O /workspace/data.csv 'https://example.com/data.csv'
`)
```

适合：从 S3、CDN、对象存储下载。

#### 方法 D：FilePart 多模态附件（图片/PDF）

把图片或 PDF 通过 `FilePart` 直接传给 AI 分析（不写入沙箱文件系统）：

```typescript
import { readFileSync } from "fs"

const b64 = readFileSync("./screenshot.png").toString("base64")

await fetch(`/session/${sid}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [
      { type: "text", text: "分析这张图里的内容" },
      {
        type: "file",
        mime: "image/png",
        filename: "screenshot.png",
        url: `data:image/png;base64,${b64}`
      }
    ],
    model: { providerID: "moonshotai-cn", modelID: "kimi-k2.6" }
  })
})
```

支持的 mime：
- 图片：`image/png`、`image/jpeg`、`image/webp` 等（需模型支持视觉）
- PDF：`application/pdf`（需模型支持 PDF 输入，如 GLM-4.6V）
- 检查模型能力：`GET /provider` 看 `capabilities.input.image/pdf`

`url` 可以是：
- `data:` URI（内联 base64）
- `https://` URL（远程图片）

---

### 4.8 文件从沙箱下载

#### 方法 A：文件下载 API（推荐，二进制安全、目录可打包）

```typescript
// 单文件：返回原始字节，直接保存
const res = await fetch(`${baseURL}/session/${sid}/files/download?path=/workspace/report.md`)
fs.writeFileSync("./report.md", Buffer.from(await res.arrayBuffer()))

// 目录：自动打包 zip（或 tar.gz）下载
const res2 = await fetch(`${baseURL}/session/${sid}/files/download?path=/workspace/project`)
fs.writeFileSync("./project.zip", Buffer.from(await res2.arrayBuffer()))
```

详见 [3.7 沙箱文件管理](#37-沙箱文件管理)。

#### 方法 B：让 AI 读出文件内容（文本小文件）

```typescript
const result = await chat(sid, "使用 bash 工具执行 cat /workspace/report.txt")
// result.tools 里包含 bash 工具的 output，就是文件内容
const fileContent = result.tools[0]?.state?.output
```

适合：文本文件、小数据。

#### 方法 C：上传到外部存储（大文件、批量）

```typescript
await chat(sid, `
使用 bash 工具：
curl -X PUT --data-binary @/workspace/output.zip \
  'https://your-s3-bucket/output.zip'
`)
```

适合：大文件、批量下载。

---

### 4.9 会话恢复（UI 重新加载历史）

刷新页面、用户重新登录后，恢复对话上下文：

```typescript
// 1. 拉所有 session 列表（用于显示侧边栏）
const sessions = await fetch("/session").then(r => r.json())
// 按 time.updated 排序，标题、ID

// 2. 用户点开某个 session，加载完整对话
const messages = await fetch(`/session/${sid}/message`).then(r => r.json())
// messages 是数组，按时间序

// 3. 渲染到 UI
for (const m of messages) {
  console.log(m.info.role, "===")  // user / assistant
  for (const p of (m.parts || [])) {
    switch (p.type) {
      case "text":      renderText(p.text); break
      case "reasoning": renderReasoning(p.text); break
      case "tool":      renderToolCall(p.tool, p.state); break
      case "file":      renderAttachment(p.url, p.mime); break
    }
  }
}

// 4. 继续对话（自动带历史上下文）
await chat(sid, "继续刚才的话题")
```

**搭配 SSE**：恢复后立刻订阅 `/event?sessionID=${sid}`，如果 session 正在 busy，能看到当前进度。

---

### 4.10 会话 Fork（分支对话）

从某个会话的某个时间点分叉一个新会话——常用于"基于这个上下文换个方向试试"：

```typescript
// 在 messageID 处 fork
const newSession = await fetch(`/session/${sid}/fork`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    messageID: "msg_xxx"  // 可选；不传则 fork 整个 session
  })
}).then(r => r.json())

// newSession.id 是新 session 的 ID
// 新 session 继承到 messageID 为止的所有历史

await chat(newSession.id, "换个思路：用 Python 重写")
// 不影响原 session
```

**用途**：
- A/B 测试不同的 prompt 策略
- 用户「取消最后操作」时回退
- 多方案对比

---

### 4.11 会话分享（生成只读链接）

```typescript
const session = await fetch(`/session/${sid}/share`, {
  method: "POST"
}).then(r => r.json())

// session.share.url 是分享 URL（接入 opencode 官方 share 服务）
console.log("分享链接:", session.share?.url)
```

**配置说明**：
- `share` 全局配置：`"manual"` / `"auto"` / `"disabled"`（PATCH /global/config）
- `auto` 模式下创建 session 自动分享
- `disabled` 关闭分享功能（生产推荐）

**安全注意**：分享链接是公开的，包含完整对话；敏感场景关闭。

---

### 4.12 Agent 切换（build / plan / 子 agent）

opencode 内置多个 agent，控制 AI 的能力边界：

| Agent | 模式 | 能力 | 适用 |
|---|---|---|---|
| `build` | primary | 完整（写文件、bash、所有工具） | 默认，开发任务 |
| `plan` | primary | 只读（禁用写、bash 需要授权） | 代码分析、方案设计 |
| `general` | subagent | 同 build，独立上下文 | 复杂搜索、多步任务 |
| `explore` | subagent | 同 plan，独立上下文 | 代码探索 |
| `title` | specialized | 生成会话标题 | 内部使用 |
| `summary` | specialized | 总结对话 | 内部使用 |

#### 切换 primary agent

```typescript
// 用 plan 模式（只读，安全）
await fetch(`/session/${sid}/message`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    parts: [{ type: "text", text: "分析 /workspace 下的代码结构" }],
    agent: "plan",        // ← 关键
    model: { providerID: "moonshotai-cn", modelID: "kimi-k2.6" }
  })
})
```

#### 调用 subagent（@general / @explore）

在 prompt 里 `@` 提及，AI 会启动子任务（独立上下文，不污染主会话）：

```typescript
await chat(sid, "@general 帮我搜索整个项目里所有 TODO 注释，并整理成清单")
// 主对话 AI 会调用 general 子 agent，搜索结果以工具调用形式返回
```

#### 自定义 agent

通过 PATCH /global/config 配置：

```json
{
  "agent": {
    "build": {
      "model": "moonshotai-cn/kimi-k2.6",
      "temperature": 1,
      "permission": {
        "edit": "allow",
        "bash": "allow",
        "webfetch": "deny"
      }
    },
    "plan": {
      "permission": {
        "edit": "deny",
        "bash": "ask"
      }
    },
    "my-reviewer": {
      "mode": "subagent",
      "prompt": "你是代码评审专家，专注发现 bug",
      "model": "moonshotai-cn/kimi-k2.6",
      "description": "代码评审"
    }
  }
}
```

然后 `@my-reviewer 评审 /workspace/src` 即可调用。

---

### 4.13 PVC 持久化机制（重要）

#### 4.13.1 工作原理

每个 session 在 PVC 上有**独立的子路径**（subPath），通过 K8s `subPath` 字段隔离：

```
PVC: sandbox-test
├── sessions/
│   ├── ses_aaaa.../
│   │   ├── workspace/      → 挂载到沙箱 /workspace
│   │   ├── home/           → /home/sandbox
│   │   ├── cache/          → /home/sandbox/.cache
│   │   ├── config/         → /home/sandbox/.config
│   │   ├── local/          → /home/sandbox/.local
│   │   └── tmp/            → /home/sandbox/tmp
│   └── ses_bbbb.../
│       └── workspace/      ← session B 看不到 session A 的文件
```

**关键特性**：
- ✅ **session 间默认隔离**（不同 subPath，互相不可见）
- ✅ **沙箱销毁不影响文件**（dispose 只删 Pod，PVC subPath 保留）
- ✅ **跨实例持久化**（pod 重启、版本升级，文件仍在）
- ⚠️ **共享同一物理 PVC**（容量是共享的，需要监控总占用）
- ⚠️ **删除 session 时**会同步清理对应 subPath（`cleanup-root` 任务）

#### 4.13.2 持久化的目录

| 沙箱内路径 | 用途 |
|---|---|
| `/workspace` | 主工作目录，AI 写文件默认位置 |
| `/home/sandbox` | 用户 home |
| `/home/sandbox/.cache` | npm/pip 等下载缓存（**重要：复用避免重装**） |
| `/home/sandbox/.config` | 工具配置 |
| `/home/sandbox/.local` | 用户级安装的二进制（pip install --user 等） |
| `/home/sandbox/tmp` | 临时文件 |

#### 4.13.3 典型场景

**场景 1：长任务跨 dispose 续作**
```typescript
// Day 1: 写代码
await chat(sid, "在 /workspace 创建 Python 项目")
// 沙箱自动释放或手动 dispose

// Day 2: 直接续作
await chat(sid, "继续完善之前的项目，添加 tests/")
// 新沙箱挂载同一 PVC subPath，所有文件、依赖缓存都在
```

**场景 2：依赖预装复用**
```typescript
// 第一次：装依赖（慢，3 分钟）
await chat(sid, "pip install pandas numpy")

// dispose 后再次进来
await chat(sid, "用 pandas 处理 /workspace/data.csv")
// → .cache 已有 wheel，直接复用
```

**场景 3：清理 session 释放空间**
```typescript
// 完全删除 session 及其 PVC 文件
await fetch(`/session/${sid}`, { method: "DELETE" })
// → 触发 sandbox-cleanup，subPath 物理删除
```

#### 4.13.4 容量管理建议

- **PVC 容量**：按预估 session 数 × 平均占用规划
  - 轻量对话：< 100MB/session
  - 含依赖缓存：500MB - 2GB/session
  - 大数据/模型：可能 GB 级
- **回收策略**：定期 DELETE 长期不活跃的 session
- **监控**：通过 K8s `kubectl exec` 进 sandbox Pod 看 `df -h /workspace`

#### 4.13.5 多租户隔离场景

**目前限制**：所有 session 共享一个 PVC。如果需要**多租户级别**隔离：

| 方案 | 适用场景 |
|---|---|
| 每租户一个 PVC | 强隔离，容量独立计费 |
| 每租户一个 OpenCode 实例 | 完全隔离，含 PG 数据库 |
| 当前共享 PVC + subPath | 单租户多用户（团队内部） |

切换隔离方案需要修改 `OPENCODE_SANDBOX_PVC_CLAIM` 配置或部署多套实例。

---

## 五、配置参考

### 5.1 全局配置（PATCH /global/config）

```json
{
  "model": "moonshotai-cn/kimi-k2.6",
  "default_agent": "build",
  "autoupdate": false,
  "agent": {
    "build": {
      "temperature": 1,
      "model": "moonshotai-cn/kimi-k2.6"
    },
    "title": { "temperature": 1 }
  }
}
```

**注意**：kimi-k2.6 等部分模型只允许 `temperature: 1`，必须显式配置否则报 400。

### 5.2 Provider 自定义

```json
{
  "provider": {
    "moonshotai-cn": {
      "options": { "baseURL": "https://api.moonshot.cn/v1" }
    }
  }
}
```

### 5.3 服务端环境变量（部署相关）

| 变量 | 说明 | 默认 |
|---|---|---|
| `OPENCODE_DATABASE_URL` | PG 连接串（必填） | - |
| `OPENCODE_AUTH_PROVIDER` | auth 后端：auto/pg/file | auto |
| `OPENCODE_DEFAULT_DIRECTORY` | 默认工作目录 | /workspace |
| `OPENCODE_SERVER_HOSTNAME` | 监听地址 | 0.0.0.0 |
| `OPENCODE_SERVER_PORT` | 监听端口 | 4096 |
| `OPENCODE_SANDBOX_ENABLED` | 启用沙箱 | false |
| `OPENCODE_SANDBOX_DOMAIN` | OpenSandbox 服务地址 | - |
| `OPENCODE_SANDBOX_API_KEY` | OpenSandbox API key | - |
| `OPENCODE_SANDBOX_VOLUME_TYPE` | pvc / empty | empty |
| `OPENCODE_SANDBOX_PVC_CLAIM` | PVC 名称 | - |
| `OPENCODE_SANDBOX_MAX_TTL_SEC` | 沙箱最大存活秒数 | 3600 |

完整列表见 `docs/deployment.md`。

---

## 六、客户端封装示例

```typescript
class OpenCodeClient {
  constructor(public baseURL: string) {}

  async createSession(title?: string) {
    const r = await fetch(`${this.baseURL}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(title ? { title } : {})
    })
    return r.json()
  }

  async deleteSession(sid: string) {
    await fetch(`${this.baseURL}/session/${sid}`, { method: "DELETE" })
  }

  async setAuth(providerID: string, key: string) {
    await fetch(`${this.baseURL}/auth/${providerID}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api", key })
    })
  }

  async chat(sid: string, text: string, modelID = "kimi-k2.6", providerID = "moonshotai-cn") {
    // 前置防御
    if (!sid || !text) throw new Error("sid and text required")

    const r = await fetch(`${this.baseURL}/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        model: { providerID, modelID }
      })
    })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const msg = await r.json()
    if (!msg.parts) throw new Error("empty response")

    return {
      text: msg.parts.find((p: any) => p.type === "text")?.text,
      tools: msg.parts.filter((p: any) => p.type === "tool"),
      reasoning: msg.parts.find((p: any) => p.type === "reasoning")?.text,
      cost: msg.info.cost,
      tokens: msg.info.tokens
    }
  }

  async chatAsync(sid: string, text: string, modelID = "kimi-k2.6", providerID = "moonshotai-cn") {
    await fetch(`${this.baseURL}/session/${sid}/prompt_async`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parts: [{ type: "text", text }],
        model: { providerID, modelID }
      })
    })
  }

  async abort(sid: string) {
    await fetch(`${this.baseURL}/session/${sid}/abort`, { method: "POST" })
  }

  async getMessages(sid: string) {
    const r = await fetch(`${this.baseURL}/session/${sid}/message`)
    return r.json()
  }

  /** 销毁指定 session 的沙箱（推荐） */
  async killSandbox(sid: string) {
    await fetch(`${this.baseURL}/session/${sid}/kill-sandbox`, { method: "POST" })
  }

  /** 销毁当前 instance 的所有沙箱 */
  async disposeAllSandboxes() {
    await fetch(`${this.baseURL}/instance/dispose`, { method: "POST" })
  }

  /** 订阅某个 session 的事件（推荐） */
  subscribeSession(sid: string, onEvent: (ev: any) => void) {
    const sse = new EventSource(`${this.baseURL}/event?sessionID=${sid}`)
    sse.onmessage = e => onEvent(JSON.parse(e.data))
    return () => sse.close()
  }

  /** 订阅全局事件（所有 session） */
  subscribeAll(onEvent: (ev: any) => void) {
    const sse = new EventSource(`${this.baseURL}/global/event`)
    sse.onmessage = e => onEvent(JSON.parse(e.data))
    return () => sse.close()
  }

  /** 异步对话 + SSE 实时进度，返回 Promise 等任务完成 */
  async chatStream(
    sid: string,
    text: string,
    onPart: (part: any) => void,
    modelID = "kimi-k2.6",
    providerID = "moonshotai-cn"
  ) {
    return new Promise<void>(async (resolve, reject) => {
      const close = this.subscribeSession(sid, ev => {
        switch (ev.type) {
          case "message.part.updated":
            onPart(ev.properties.part)
            break
          case "session.status":
            if (ev.properties.status.type === "idle") {
              close()
              resolve()
            }
            break
          case "session.error":
            close()
            reject(new Error(ev.properties.error.data?.message || JSON.stringify(ev.properties.error)))
            break
        }
      })
      try {
        await this.chatAsync(sid, text, modelID, providerID)
      } catch (e) {
        close()
        reject(e)
      }
    })
  }
}

// 用法
const client = new OpenCodeClient("https://test-opencode.shadow-rpa.net")
await client.setAuth("moonshotai-cn", "sk-xxx")
const { id: sid } = await client.createSession("我的项目")

// 模式 1: 同步对话（短任务）
const result = await client.chat(sid, "使用 bash 创建 /workspace/hello.txt 内容是 hi")
console.log(result.text, result.tools)

// 模式 2: 流式实时显示（长任务推荐）
await client.chatStream(sid, "分析一下 /workspace 下的所有文件", part => {
  if (part.type === "reasoning") process.stdout.write(`[思考] ${part.text}`)
  if (part.type === "text") process.stdout.write(part.text)
  if (part.type === "tool") console.log(`\n[工具] ${part.tool} → ${part.state?.status}`)
})
```

---

## 七、已知限制与最佳实践

### 7.1 已知限制

| 现象 | 影响 | 规避 |
|---|---|---|
| 往不存在的 session 发消息返回 200 空 body | 客户端无法区分 | 调用前先 `GET /session/:id` 校验 |
| 不存在的 provider 返回 200 空 body | 同上 | 调用前先 `GET /provider` 校验 |
| 空 parts 数组返回 200 空 body | 同上 | 客户端校验非空 |
| 部分模型（kimi-k2.6）要求 temperature=1 | 默认 0.5 会被 API 拒绝 | PATCH `/global/config` 配 agent.temperature=1 |
| 沙箱冷启动 ~2-3 秒延迟 | 首次发消息变慢 | 业务层 loading 提示 |
| Session 插件 agent 随沙箱回收销毁 | 非 keepAlive 会话插件时有时无（重建窗口 ~5-10s 内 hook 跳过） | 用插件的会话开启 keepAlive（见 4.6b） |
| LLM 工具幻觉 | 模型可能假装调用工具但实际没调 | prompt 明确指定工具名 |
| 所有 session 共享一个 PVC | 容量共享 / 单租户场景下够用 | 多租户需按租户拆 PVC 或拆实例（见 4.13.5） |

### 7.2 最佳实践

**Prompt 设计**：
- ✅ 明确指令："使用 bash 工具执行 X"
- ✅ 提供路径：使用绝对路径 `/workspace/...`
- ❌ 模糊任务："帮我处理一下"

**会话管理**：
- 长任务用 `prompt_async` + SSE 订阅
- **任务结束调 `/instance/dispose`** 立即释放沙箱资源（推荐，见 4.6.1）
- 一次性任务用 `try/finally` 模式保证 dispose
- 不需要的 session 调 DELETE 清理（避免列表变大、释放 PVC 空间）
- **不要每条消息都 dispose** —— 会增加冷启动开销
- **使用 Session 插件的会话开 keepAlive** —— 插件 agent 随沙箱存活，dispose/回收后需等重建（见 4.6b）

**错误处理**：
- 客户端做前置校验（session 存在、provider 连通、parts 非空）
- 同步 message 接口可能因 LLM 错误返回空 body，需要 catch
- 关键操作加重试（沙箱冷启动可能首次失败）

**性能**：
- 复用 session（多轮上下文）比每次新建 session 省 token
- 异步 + 流式更新优于轮询
- 短任务用同步，长任务（>30s）用异步

---

## 八、常见问题

**Q：怎么知道模型是否真调了工具？**
查 `msg.parts` 里是否有 `type === "tool"` 的元素；reasoning 里说"已调用"不算数。

**Q：dispose 后 session 还在吗？**
在的。dispose 只销毁**沙箱 Pod**，session/消息历史/PVC 文件都保留。

**Q：PVC 文件什么时候真正删除？**
DELETE session 时会触发 `sandbox-cleanup` 清掉该 session 在 PVC 上的目录。

**Q：能否本地调试？**
能。运行：
```bash
OPENCODE_DATABASE_URL=... OPENCODE_SANDBOX_DOMAIN=... bun run src/index.ts serve
```
然后 `curl http://127.0.0.1:4096/global/health`。

**Q：每个 session 占用多少 PG 空间？**
取决于消息条数。空 session ~1KB；正常对话 10 条消息 ~30KB。

**Q：能调多模型对比吗？**
能。同 session 不同消息可以指定不同 model：
```json
{ "model": { "providerID": "anthropic", "modelID": "claude-sonnet-4" } }
{ "model": { "providerID": "moonshotai-cn", "modelID": "kimi-k2.6" } }
```

---

## 九、参考资料

- 部署指南：`docs/deployment.md`
- 架构设计：`docs/saas-architecture.md`
- PVC 方案：`docs/sandbox-pvc-plan.md`
- 测试用例：`docs/saas-test-cases.md`
- OpenAPI 规范：`GET /doc`
