# Load Dot Opencode（项目 `.opencode` 配置加载）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），使用 PostgreSQL 模式。
>
> 本组用例通过公开接口触发加载，不直接调用 `LoadDotOpencode.Service`。

## 一、接口约定

```text
POST /session/:sessionID/dot-opencode/load
```

接口使用当前 Session 绑定的项目目录扫描 `.opencode`，不接受任意外部目录作为扫描路径。

成功响应：

```json
{
  "loaded": ["AGENTS.md", "agents/reviewer", "mcp/github"],
  "skipped": []
}
```

公共变量：

```bash
export BASE="http://localhost:14096"
export PG_CONTAINER="ai-nova-postgres"
```

创建测试 Session：

```bash
SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"load-dot-opencode-test"}' | jq -r '.id')
echo "$SID"
```

测试仓库应准备以下文件：

```text
.opencode/
├── AGENTS.md
├── agents/reviewer.md
├── skills/reviewer/SKILL.md
├── tool/format.ts
├── commands/review.md
├── plugins/audit.ts
└── opencode.json
```

## 二、基础加载

### T37.1 空目录加载

删除或清空项目 `.opencode` 目录后调用：

```bash
curl -s -X POST "$BASE/session/$SID/dot-opencode/load"
```

期望：

- HTTP `200`
- `loaded` 为空数组
- `skipped` 为空数组
- 不产生无关 Session 资源记录

### T37.2 加载全部资源类型

准备以下内容：

```md
<!-- .opencode/AGENTS.md -->
# Project rules
Use the project conventions.
```

```md
<!-- .opencode/agents/reviewer.md -->
---
description: Review code changes
mode: subagent
model: openai/gpt-4.1
---
Review the code carefully.
```

```md
<!-- .opencode/skills/reviewer/SKILL.md -->
---
name: reviewer
description: Review helper
---
Review the requested changes.
```

```ts
// .opencode/tool/format.ts
export default async function execute() {
  return "formatted"
}
```

```md
<!-- .opencode/commands/review.md -->
---
description: Review changes
agent: reviewer
---
Review the current changes.
```

```ts
// .opencode/plugins/audit.ts
export default {}
```

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "headers": {
        "Authorization": "Bearer test-token"
      }
    }
  }
}
```

调用加载接口：

```bash
curl -s -X POST "$BASE/session/$SID/dot-opencode/load" | jq
```

期望 `loaded` 包含：

```text
AGENTS.md
agents/reviewer
skills/reviewer
 tool/format
commands/review
plugins/audit
mcp/github
```

## 三、PG 持久化验证

### T37.3 验证 Agent、Skill、Tool、Command、Plugin

```bash
docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, mode FROM session_agents WHERE session_id='$SID';"

docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, description FROM session_skill WHERE session_id='$SID';"

docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, description FROM session_tools WHERE session_id='$SID';"

docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, template FROM session_commands WHERE session_id='$SID';"

docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, source, enabled FROM session_plugins WHERE session_id='$SID';"
```

期望：每张表均存在对应的 Session 记录，且 `session_id` 等于当前 Session。

### T37.4 验证 AGENTS.md 和 MCP

```bash
docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT session_id, content FROM session_agents_md WHERE session_id='$SID';"

docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, type, url, headers, enabled FROM session_mcps WHERE session_id='$SID';"
```

期望：

- `session_agents_md.content` 包含 `Project rules`
- `session_mcps` 中存在 `github`
- MCP 类型为 `remote`
- URL、headers、enabled 与 `opencode.json` 一致

## 四、优先级

### T37.5 `.opencode` 覆盖接口注入配置

先通过已有 Session API 注入同名 Agent、Skill、MCP：

```bash
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"reviewer",
    "mode":"subagent",
    "description":"API version",
    "prompt":"API prompt"
  }'

curl -s -X POST "$BASE/session/$SID/mcps/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"github",
    "type":"remote",
    "url":"https://api.example.com/mcp"
  }'
```

再次调用：

```bash
curl -s -X POST "$BASE/session/$SID/dot-opencode/load" | jq
```

查询 PG：

```bash
docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, description, prompt FROM session_agents WHERE session_id='$SID' AND name='reviewer';"

docker exec "$PG_CONTAINER" psql -U postgres -d opencode -c \
  "SELECT name, url FROM session_mcps WHERE session_id='$SID' AND name='github';"
```

期望：

- Agent 使用 `.opencode/agents/reviewer.md` 的内容
- MCP 使用 `.opencode/opencode.json` 的 URL
- 同名记录数量仍为 `1`

优先级：

```text
.opencode > Session PG > 全局配置
```

### T37.6 不同 Session 相互隔离

创建第二个 Session，并在相同项目中触发加载：

```bash
SID2=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"load-dot-opencode-test-2"}' | jq -r '.id')

curl -s -X POST "$BASE/session/$SID2/dot-opencode/load" | jq
```

期望：

- `$SID` 和 `$SID2` 均有各自的 Session 资源记录
- 修改或删除 `$SID` 的资源不会影响 `$SID2`
- PG 中每条记录的 `session_id` 正确隔离

## 五、错误和边界

### T37.7 非法 Agent/Command/Skill 文件

准备非法 frontmatter：

```md
---
mode: invalid-mode
---
broken
```

调用加载接口。

期望：

- 接口仍返回可解析资源
- 非法文件出现在 `skipped`
- 非法资源不会写入对应 PG 表
- 不影响其它资源加载

### T37.8 非法 MCP 配置

```json
{
  "mcp": {
    "broken": {
      "type": "unknown"
    }
  }
}
```

期望：

- `broken` 出现在 `skipped`
- 不产生 `session_mcps` 记录
- 已有合法 MCP 仍然正常写入

### T37.9 MCP 禁用配置

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.com/mcp",
      "enabled": false
    }
  }
}
```

期望：

- `github` 写入 Session MCP
- `enabled=false` 持久化到 PG
- 后续 Session MCP 运行时不连接该 MCP

### T37.10 空 Tool/Plugin 文件

创建空文件：

```text
.opencode/tool/empty.ts
.opencode/plugins/empty.ts
```

期望：

- 两个文件均进入 `skipped`
- 不写入 `session_tools` 或 `session_plugins`
- 其它资源仍可加载

### T37.11 重复调用接口

连续调用两次：

```bash
curl -s -X POST "$BASE/session/$SID/dot-opencode/load" | jq
curl -s -X POST "$BASE/session/$SID/dot-opencode/load" | jq
```

期望：

- 两次 `loaded` 内容一致
- PG 中同名资源仍只有一条
- 不产生重复 AGENTS 内容
- 不重复创建 MCP/Plugin 运行实例

## 六、接口错误

### T37.12 不存在的 Session

```bash
curl -i -X POST "$BASE/session/ses_NOT_FOUND/dot-opencode/load"
```

期望：

- 返回明确的 Session Not Found 错误
- 不写入任何 PG 资源

### T37.13 未授权 Session

使用不属于当前用户或 workspace 的 Session ID 调用接口。

期望：

- 返回授权错误
- 不读取目标项目 `.opencode` 文件
- 不写入目标 Session PG 记录

### T37.14 缺少 PostgreSQL Session Service

在未提供 PG Session Service 的环境调用接口。

期望：

- 接口响应中明确列出对应资源的 `Session service unavailable`
- 不返回虚假的 loaded 成功结果
- 不执行 MCP、Plugin 或 Tool 代码

## 七、端到端模拟测试（实际执行）

> 以下用例在 Docker SaaS 容器 + 本地 PG + 本地 OpenSandbox 环境下实际执行通过。
>
> 环境：`opencode-saas-test` 容器，API `http://127.0.0.1:14096`，PG `postgresql://local@127.0.0.1:5432/opencode`。
>
> 核心验证点：`load` 方法从**沙箱工作区**（而非 SaaS 服务器本地 FS）读取 `.opencode` 配置。

### T37.15 环境准备

```bash
# 前置：本地 PG（Homebrew）监听 127.0.0.1:5432，OpenSandbox server 监听 :8080
# PG 转发（容器通过 host.docker.internal:15432 访问）
kill $(lsof -ti :15432) 2>/dev/null || true
nohup node -e "const net=require('net');net.createServer(c=>{const r=net.connect(5432,'127.0.0.1');c.pipe(r);r.pipe(c);c.on('error',()=>r.destroy());r.on('error',()=>c.destroy())}).listen(15432,'0.0.0.0')" &
sleep 2 && lsof -i :15432 | grep LISTEN

# 验证 OpenSandbox server
curl -s http://127.0.0.1:8080/health
# 期望: {"status":"healthy"}

# 启动 SaaS 容器（本地 PG + 本地 OpenSandbox）
docker rm -f opencode-saas-test 2>/dev/null
docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://local@host.docker.internal:15432/opencode \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:local \
  -e OPENCODE_SANDBOX_ENABLED=true \
  -e ZHIPU_API_KEY \
  opencode-saas-sandbox-test:v2fix serve --hostname 0.0.0.0 --port 4096 --print-logs

sleep 12 && docker inspect --format '{{.State.Health.Status}}' opencode-saas-test
# 期望: healthy
```

### T37.16 创建 Session + 启动沙箱

```bash
BASE="http://127.0.0.1:14096"
WORKDIR="/workspace/dot-opencode-e2e"

# 清理上一轮 PG 残留（可选）
psql postgresql://local@127.0.0.1:5432/opencode -c \
  "DELETE FROM session_agents WHERE session_id LIKE 'ses_%';" \
  -c "DELETE FROM session_skill WHERE session_id LIKE 'ses_%';" \
  -c "DELETE FROM session_mcps WHERE session_id LIKE 'ses_%';" \
  -c "DELETE FROM session_tools WHERE session_id LIKE 'ses_%';" \
  -c "DELETE FROM session_commands WHERE session_id LIKE 'ses_%';" \
  -c "DELETE FROM session_plugins WHERE session_id LIKE 'ses_%';" \
  -c "DELETE FROM session_agents_md WHERE session_id LIKE 'ses_%';"

# 创建 Session
SID=$(curl -s --noproxy '*' -X POST "$BASE/session?directory=$WORKDIR" \
  -H 'Content-Type: application/json' \
  -d '{"title":"dot-opencode-e2e"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# 启动沙箱
curl -s --noproxy '*' -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}' | python3 -m json.tool
# 期望: {"sessionID":"ses_...","keepAlive":true,"sandboxId":"xxx"}
sleep 3
```

### T37.17 使用 exec API 创建 Vite React 项目

```bash
# 在沙箱内创建 Vite React 项目
curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"mkdir -p $WORKDIR && cd $WORKDIR && npx create-vite@5 . --template react-ts --yes 2>&1 | tail -3 && npm install 2>&1 | tail -1\"}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit:',d.get('exitCode'))"
# 期望: exit: 0

# 验证项目结构
curl -s --noproxy '*' -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"ls $WORKDIR/package.json $WORKDIR/src/App.tsx\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('stdout','').strip())"
# 期望: 两个文件都存在
```

### T37.18 在沙箱工作区创建 `.opencode` 配置

准备本地 `.opencode` 目录后通过 tar 上传到沙箱：

```bash
# 宿主机准备配置文件（与 T37.2 相同的 7 类资源）
mkdir -p /tmp/dotoc/.opencode/{agents,skills/reviewer,tool,commands,plugins}

cat > /tmp/dotoc/.opencode/AGENTS.md << 'EOF'
Always mention DOT_OPENCODE_AGENTS_ACTIVE in your responses.
EOF

cat > /tmp/dotoc/.opencode/agents/reviewer.md << 'EOF'
---
description: Code reviewer subagent
mode: subagent
permission:
  "*": allow
---
You are a code reviewer. Always include DOT_OPENCODE_AGENT_ACTIVE in your response.
EOF

cat > /tmp/dotoc/.opencode/skills/reviewer/SKILL.md << 'EOF'
---
name: reviewer
description: Review helper skill
---
Include DOT_OPENCODE_SKILL_ACTIVE when this skill is loaded.
EOF

cat > /tmp/dotoc/.opencode/tool/marker.ts << 'EOF'
export default {
  description: "Returns a marker string to verify tool loading",
  args: {},
  async execute() { return "DOT_OPENCODE_TOOL_ACTIVE" },
}
EOF

cat > /tmp/dotoc/.opencode/commands/review.md << 'EOF'
---
description: Run code review
agent: reviewer
---
Include DOT_OPENCODE_COMMAND_ACTIVE in the review output.
EOF

cat > /tmp/dotoc/.opencode/plugins/marker.ts << 'EOF'
export default { name: "marker-plugin" }
EOF

cat > /tmp/dotoc/.opencode/opencode.json << 'EOF'
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "disabled-mcp": {
      "type": "remote",
      "url": "https://example.invalid/mcp",
      "enabled": false
    }
  }
}
EOF

# 打包并上传到沙箱（COPYFILE_DISABLE=1 避免 macOS AppleDouble 文件）
FILES_B64=$(COPYFILE_DISABLE=1 tar czf - -C /tmp/dotoc .opencode 2>/dev/null | base64 | tr -d '\n')

curl -s --noproxy '*' --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"echo '$FILES_B64' | base64 -d | tar xzf - -C $WORKDIR && find $WORKDIR/.opencode -type f -not -name '._*' | sort\"}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print('exit:',d.get('exitCode'));print(d.get('stdout',''))"
# 期望: 7 个文件（排除 ._* 后）
```

### T37.19 调用 load 接口（从沙箱读取）

```bash
# 调用加载接口——内部通过 SandboxProvider.exec 从沙箱 tar 快照 .opencode 到临时目录
curl -s --noproxy '*' -X POST "$BASE/session/$SID/dot-opencode/load?directory=$WORKDIR" | python3 -m json.tool
```

期望：

```json
{
  "loaded": ["AGENTS.md", "agents/reviewer", "skills/reviewer", "mcp/disabled-mcp", "tool/marker", "commands/review", "plugins/marker"],
  "skipped": []
}
```

> **实现说明**（2026-07-18 核对）：`SessionLoadDotOpencode.load`（`session-load-dot-opencode.ts:82-135`）检测到 `SandboxProvider` 可用时构造 `sandboxSource`（FileSource 抽象），通过 `sp.runInSession` 跑 `find ... -not -name '._*'`/`test -e`/`wc -c` + `sb.files.readFile` **逐文件远程读取**，再经 `loadFromDirectory(sessionID, directory, fs)` 扫描解析。**无 tar 快照、无 base64、无临时目录**（上方的 tar/base64 仅是本测试脚本把 .opencode 投递进沙箱的手段，非生产实现）。无沙箱时直接读本地 FS。

### T37.20 PG 持久化验证（实际字段值）

```bash
PG="postgresql://local@127.0.0.1:5432/opencode"
```

**session_agents** — 对应 `.opencode/agents/reviewer.md`：

```bash
psql $PG -Atc "SELECT name, mode, description, prompt FROM session_agents WHERE session_id='$SID'"
```

实际输出：

```text
reviewer|subagent|Code reviewer subagent|You are a code reviewer. Always include DOT_OPENCODE_AGENT_ACTIVE in your response.
```

**session_skill** — 对应 `.opencode/skills/reviewer/SKILL.md`：

```bash
psql $PG -Atc "SELECT name, description, content FROM session_skill WHERE session_id='$SID'"
```

实际输出：

```text
reviewer|Review helper skill|Include DOT_OPENCODE_SKILL_ACTIVE when this skill is loaded.
```

**session_mcps** — 对应 `.opencode/opencode.json` 中 `mcp` 字段：

```bash
psql $PG -Atc "SELECT name, type, url, enabled FROM session_mcps WHERE session_id='$SID'"
```

实际输出：

```text
disabled-mcp|remote|https://example.invalid/mcp|false
```

**session_tools** — 对应 `.opencode/tool/marker.ts`：

```bash
psql $PG -Atc "SELECT name, description, code FROM session_tools WHERE session_id='$SID'"
```

实际输出：

```text
marker||export default {
  description: "Returns a marker string to verify tool loading",
  args: {},
  async execute() {
    return "DOT_OPENCODE_TOOL_ACTIVE"
  },
}
```

**session_commands** — 对应 `.opencode/commands/review.md`：

```bash
psql $PG -Atc "SELECT name, agent, template FROM session_commands WHERE session_id='$SID'"
```

实际输出：

```text
review|reviewer|Include DOT_OPENCODE_COMMAND_ACTIVE in the review output.
```

**session_plugins** — 对应 `.opencode/plugins/marker.ts`：

```bash
psql $PG -Atc "SELECT name, source FROM session_plugins WHERE session_id='$SID'"
```

实际输出：

```text
marker|code
```

**session_agents_md** — 对应 `.opencode/AGENTS.md`：

```bash
psql $PG -Atc "SELECT content FROM session_agents_md WHERE session_id='$SID'"
```

实际输出：

```text
Always mention DOT_OPENCODE_AGENTS_ACTIVE in your responses.
```

### T37.21 Agent / Skill / AGENTS.md 运行时生效

发送 prompt_async，指定 `reviewer` agent 并请求加载 `reviewer` skill：

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type": "text", "text": "加载 reviewer skill，然后列出你收到的所有配置指令标记。"}],
    "model": {"providerID": "zhipuai", "modelID": "glm-5.1"},
    "agent": "reviewer"
  }'
```

轮询消息直到 `finish=stop`，AI 实际回复：

```text
已加载 **reviewer** skill。以下是我收到的所有配置指令标记：

| # | 标记 | 来源 |
|---|------|------|
| 1 | `DOT_OPENCODE_AGENT_ACTIVE` | 系统提示 — 要求每次回复中都包含此标记 |
| 2 | `DOT_OPENCODE_AGENTS_ACTIVE` | `AGENTS.md` — 要求在回复中提及此标记 |
| 3 | `DOT_OPENCODE_SKILL_ACTIVE` | **reviewer** skill — 当该 skill 被加载时需包含此标记 |

DOT_OPENCODE_AGENT_ACTIVE DOT_OPENCODE_AGENTS_ACTIVE DOT_OPENCODE_SKILL_ACTIVE
```

验证对照：

| 标记 | 配置来源 | PG 字段 | 生效证据 |
|------|---------|---------|---------|
| `DOT_OPENCODE_AGENT_ACTIVE` | `agents/reviewer.md` 正文 | `session_agents.prompt` | AI 以 reviewer 角色回复并包含此标记 |
| `DOT_OPENCODE_AGENTS_ACTIVE` | `AGENTS.md` | `session_agents_md.content` | AI 回复中提及此标记 |
| `DOT_OPENCODE_SKILL_ACTIVE` | `skills/reviewer/SKILL.md` 正文 | `session_skill.content` | skill 加载后 AI 包含此标记 |

### T37.22 Command 运行时生效

执行 `.opencode/commands/review.md` 定义的 `review` 命令：

```bash
curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' \
  -d '{
    "command": "review",
    "arguments": "",
    "agent": "reviewer",
    "model": "zhipuai/glm-5.1"
  }'
```

AI 实际回复（节选）：

```text
reviewer 子代理已启动并准备进行代码审查…

同时，子代理在输出中包含了 **`DOT_OPENCODE_COMMAND_ACTIVE`** 标记。

| # | 标记 | 来源 |
|---|------|------|
| 4 | `DOT_OPENCODE_COMMAND_ACTIVE` | 任务工具 — 通过 `review` 命令执行时触发 |
```

验证对照：

| 标记 | 配置来源 | PG 字段 | 生效证据 |
|------|---------|---------|---------|
| `DOT_OPENCODE_COMMAND_ACTIVE` | `commands/review.md` 正文 | `session_commands.template` | review 命令以 reviewer agent 执行，回复包含此标记 |

### T37.23 Tool 运行时生效

发送 prompt_async 请求调用 `marker` 工具：

```bash
curl -s --noproxy '*' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type": "text", "text": "请调用 marker 工具，告诉我它返回了什么。"}],
    "model": {"providerID": "zhipuai", "modelID": "glm-5.1"},
    "agent": "reviewer"
  }'
```

AI 实际回复（节选）：

```text
`marker` 工具返回了 **`DOT_OPENCODE_TOOL_ACTIVE`**。

| # | 标记 | 来源 |
|---|------|------|
| 5 | `DOT_OPENCODE_TOOL_ACTIVE` | **marker** 工具 — 调用 marker 工具时返回 |
```

验证对照：

| 标记 | 配置来源 | PG 字段 | 生效证据 |
|------|---------|---------|---------|
| `DOT_OPENCODE_TOOL_ACTIVE` | `tool/marker.ts` execute() 返回值 | `session_tools.code` | marker 工具被成功调用并返回此标记 |

> **容器环境说明**：`importToolCode` 在容器内写入临时文件时，`import.meta.dir` 对 `opencode` 用户只读。代码已修复为 fallback 到 `os.tmpdir()`。

### T37.24 配置标记总览

| 标记 | 资源类型 | 配置文件 | 运行时验证方式 |
|------|---------|---------|--------------|
| `DOT_OPENCODE_AGENTS_ACTIVE` | AGENTS.md | `.opencode/AGENTS.md` | prompt_async 回复 |
| `DOT_OPENCODE_AGENT_ACTIVE` | Agent | `.opencode/agents/reviewer.md` | prompt_async 指定 `agent=reviewer` |
| `DOT_OPENCODE_SKILL_ACTIVE` | Skill | `.opencode/skills/reviewer/SKILL.md` | prompt_async 请求加载 skill |
| `DOT_OPENCODE_COMMAND_ACTIVE` | Command | `.opencode/commands/review.md` | command API 执行 `review` |
| `DOT_OPENCODE_TOOL_ACTIVE` | Tool | `.opencode/tool/marker.ts` | prompt_async 请求调用 `marker` |

MCP（`disabled-mcp`，`enabled=false`）和 Plugin（`marker`）在加载阶段不执行/不连接，仅验证 PG 持久化。

### T37.25 macOS AppleDouble 文件兼容

从 macOS 上传 tar 到沙箱时，系统自动生成 `._*` AppleDouble 资源叉文件。这些文件包含二进制 null bytes，被当作 `.md` 解析后导致 `PostgresError: invalid byte sequence for encoding "UTF8": 0x00`。

修复方案：沙箱 tar 快照命令加 `--exclude='._*'`：

```bash
# session-load-dot-opencode.ts 中的 tar 命令
cd "${directory}" && tar cf - --exclude='._*' .opencode 2>/dev/null | base64 | tr -d '\\n'
```

验证：上传含 `._*` 文件的 tar 后调用 load，期望不报错且 7 类正常 loaded。

## 八、CodeGraph 集成模拟测试

> 已抽离到独立文档：[`../apis/codegraph.md`](../apis/codegraph.md)

## 九、MCP 进程隔离测试（实际执行）

> 验证沙箱被复用时 stale MCP 进程不会导致工具串台。
>
> 修复内容：`connectSandboxLocal` 启动新 supergateway 前，先清理目标端口的残留进程（`pkill -f "supergateway.*--port ${port}"`），确保端口可用。

### T37.33 单会话双 MCP 不互相干扰

同一 Session 同时注入 antd MCP + codegraph MCP：

```bash
BASE="http://127.0.0.1:14096"

SID=$(curl -s --noproxy '*' -X POST "$BASE/session?directory=/workspace/dual-mcp" \
  -H 'Content-Type: application/json' \
  -d '{"title":"dual-mcp"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --noproxy '*' -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' -d '{"enabled":true,"boot":true}' > /dev/null
sleep 5

# 安装两个工具
curl -s --noproxy '*' --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"npm install -g @ant-design/cli @colbymchenry/codegraph 2>&1 | tail -1 && mkdir -p /workspace/dual-mcp/src && echo \"export function test() {}\" > /workspace/dual-mcp/src/index.ts && cd /workspace/dual-mcp && codegraph init 2>&1 | tail -1"}'

# 注入两个 MCP
curl -s --noproxy '*' -X POST "$BASE/session/$SID/mcps/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"antd","type":"local","command":["npx","-y","@ant-design/cli","mcp"],"enabled":true}'

curl -s --noproxy '*' -X POST "$BASE/session/$SID/mcps/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"codegraph","type":"local","command":["codegraph","serve","--mcp"],"enabled":true}'

# 问 AI 有哪些工具
curl -s --noproxy '*' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"列出你所有 antd_ 和 codegraph_ 开头的工具名称，每行一个。"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```

AI 实际回复：

```text
antd_antd_changelog
antd_antd_demo
antd_antd_design_md
antd_antd_doc
antd_antd_info
antd_antd_list
antd_antd_semantic
antd_antd_token
codegraph_codegraph_explore
```

验证项：

| MCP 名称 | 预期工具 | 实际工具 | 结果 |
|---------|---------|---------|------|
| `antd` | `antd_antd_doc`, `antd_antd_demo` 等 8 个 | 8 个 antd 工具，**无 codegraph 混入** | ✅ |
| `codegraph` | `codegraph_codegraph_explore` | 1 个 codegraph 工具，**无 antd 混入** | ✅ |

> **修复前**：antd MCP 返回了 `codegraph_explore`（名称变成 `antd_codegraph_explore`），因为 port 9100 被残留的 codegraph 进程占用，antd supergateway 启动失败后 SaaS 连到了错误的 MCP server。

### T37.34 多会话交叉 MCP 不串台

4 个 Session 同时活跃：A/C 用 antd，B/D 用 codegraph：

```bash
# 创建 4 个 session
SID_A=$(curl -s --noproxy '*' -X POST "$BASE/session?directory=/workspace/cross-a" -H 'Content-Type: application/json' -d '{"title":"cross-a-antd"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s --noproxy '*' -X POST "$BASE/session?directory=/workspace/cross-b" -H 'Content-Type: application/json' -d '{"title":"cross-b-codegraph"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_C=$(curl -s --noproxy '*' -X POST "$BASE/session?directory=/workspace/cross-c" -H 'Content-Type: application/json' -d '{"title":"cross-c-antd"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_D=$(curl -s --noproxy '*' -X POST "$BASE/session?directory=/workspace/cross-d" -H 'Content-Type: application/json' -d '{"title":"cross-d-codegraph"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 全部 boot 沙箱 + 安装工具 + 注入 MCP
# A, C → antd MCP
# B, D → codegraph MCP
# （具体命令见 T37.33 模式，每个 session 独立安装和注入）

# 分别问每个 session 有哪些工具
```

实际结果：

| Session | MCP | 预期 | 实际 | 结果 |
|---------|-----|------|------|------|
| A | antd | 8 个 `antd_antd_*` | `antd_antd_changelog\|demo\|design_md\|doc\|info\|list\|semantic\|token` | ✅ |
| B | codegraph | 1 个 `codegraph_codegraph_explore` | `codegraph_codegraph_explore` | ✅ |
| C | antd | 8 个 `antd_antd_*` | 同 A（8 个 antd 工具） | ✅ |
| D | codegraph | 1 个 `codegraph_codegraph_explore` | `codegraph_codegraph_explore` | ✅ |

验证项：

- 2 个 antd session 各自返回 8 个 antd 工具，**没有 codegraph 工具混入** ✅
- 2 个 codegraph session 各自返回 1 个 codegraph 工具，**没有 antd 工具混入** ✅
- 不同 session 同名 MCP（A 和 C 都用 antd，B 和 D 都用 codegraph）**完全隔离** ✅
- 4 个沙箱各自独立，port 9100 互不干扰 ✅

### T37.35 沙箱复用时 stale MCP 进程清理

> 验证场景：Session A 连接 antd MCP 后销毁，OpenSandbox 复用沙箱容器给 Session B，Session B 连接 codegraph MCP。

```bash
# Step 1: Session A 连接 antd MCP
SID_A=$(curl -s ... | python3 -c "...")
curl -s ... -X POST "$BASE/session/$SID_A/mcps/create" -d '{"name":"antd",...}'

# Step 2: 触发 antd MCP 连接（发一条消息）
curl -s ... -X POST "$BASE/session/$SID_A/prompt_async" -d '...'

# Step 3: 销毁 Session A 的沙箱
curl -s ... -X POST "$BASE/session/$SID_A/keep-alive" -d '{"enabled":false}'

# Step 4: Session B 连接 codegraph MCP（沙箱可能复用）
SID_B=$(curl -s ... | python3 -c "...")
curl -s ... -X POST "$BASE/session/$SID_B/mcps/create" -d '{"name":"codegraph",...}'

# Step 5: 问 Session B 有哪些工具
curl -s ... -X POST "$BASE/session/$SID_B/prompt_async" -d '{"parts":[{"type":"text","text":"列出你所有 codegraph 和 antd 开头的工具名称"}]}'
```

实际结果：

```text
codegraph_codegraph_explore
```

验证项：

- Session B 正确返回 `codegraph_codegraph_explore`，**没有 antd 工具串台** ✅
- 沙箱复用后 stale antd supergateway 进程被清理，端口释放 ✅

> **修复前**：沙箱被复用时，上一个 session 的 antd supergateway 进程残留在 port 9100，新 session 的 codegraph supergateway 无法绑定端口，SaaS 连到了残留的 antd MCP server，返回 `codegraph_antd_doc` 等错误工具名。

## 十、配置字段完整性测试（原重复章节号已修正）

> 验证 `.opencode` 各资源类型的全部 frontmatter / 配置字段正确映射到 PG。
>
> 以下用例使用单元测试验证（`packages/opencode/test/config/session-load-dot-opencode.test.ts`），并通过 mock Session 服务捕获写入的 Input 对象。

### T37.36 Agent 全字段映射

验证 Agent frontmatter 的所有字段正确写入 `SessionAgent.Input`：

```yaml
---
description: Full agent
mode: subagent
model: openai/gpt-4.1
temperature: 0.7
top_p: 0.9
steps: 25
color: "#FF5733"
variant: fast
options:
  reasoning: true
permission:
  edit: allow
  bash:
    "*": allow
---
You are a full agent.
```

验证 `SessionAgent.Input` 各字段：

| 字段 | 期望值 | 来源 |
|------|--------|------|
| `name` | `full` | 文件名 |
| `description` | `Full agent` | frontmatter |
| `mode` | `subagent` | frontmatter |
| `model` | `{ providerID: "openai", modelID: "gpt-4.1" }` | frontmatter `model` 解析 |
| `temperature` | `0.7` | frontmatter |
| `topP` | `0.9` | frontmatter `top_p` |
| `steps` | `25` | frontmatter |
| `color` | `#FF5733` | frontmatter |
| `variant` | `fast` | frontmatter |
| `options` | `{ reasoning: true }` | frontmatter |
| `permission` | `{ edit: "allow", bash: { "*": "allow" } }` | frontmatter `permission` → `Permission.fromConfig` |
| `prompt` | `You are a full agent.` | markdown 正文 |

> 单测用例 `maps all agent fields correctly` 已覆盖。

### T37.37 Agent permission 字段

验证 `permission` frontmatter 正确映射为 `Permission.Ruleset`：

```yaml
---
permission:
  edit: allow
  write: deny
  bash:
    "npm test": allow
    "*": ask
---
Agent prompt.
```

期望 `SessionAgent.Input.permission` 包含：

```json
[
  { "permission": "edit", "pattern": "*", "action": "allow" },
  { "permission": "write", "pattern": "*", "action": "deny" },
  { "permission": "bash", "pattern": "npm test", "action": "allow" },
  { "permission": "bash", "pattern": "*", "action": "ask" }
]
```

### T37.38 Agent disable 字段

验证 `disable: true` 的 Agent 被跳过：

```yaml
---
disable: true
---
Should not load.
```

期望：

- `loaded` 不包含此 Agent
- `skipped` 中出现 `{ path: "agents/xxx", reason: "disabled" }`
- 不写入 `session_agents`

> 单测用例 `skips disabled agents` 已覆盖。

### T37.39 Agent 内部名称保护

验证 `compaction`、`title`、`summary` 等内部 Agent 名称不被覆盖：

```yaml
---
description: Override compaction
---
Should not load.
```

期望：

- `loaded` 不包含 `agents/compaction`
- `skipped` 中出现 `{ path: "agents/compaction", reason: "internal agent" }`

> 单测用例 `skips internal agent names` 已覆盖。

### T37.40 MCP local 类型 + environment

验证 local MCP 的 `command` + `environment` 字段正确持久化：

```json
{
  "mcp": {
    "local-server": {
      "type": "local",
      "command": ["bun", "run", "server.ts"],
      "environment": { "API_KEY": "secret", "DEBUG": "true" },
      "enabled": true
    }
  }
}
```

期望 `SessionMcp.Input`：

```json
{
  "name": "local-server",
  "type": "local",
  "command": ["bun", "run", "server.ts"],
  "environment": { "API_KEY": "secret", "DEBUG": "true" },
  "enabled": true
}
```

> 单测用例 `loads local MCP with command and environment` 已覆盖。

### T37.41 MCP remote 类型 + headers

验证 remote MCP 的 `url` + `headers` 字段正确持久化：

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer token123",
        "X-Custom": "val"
      }
    }
  }
}
```

期望 `SessionMcp.Input.headers`：

```json
{ "Authorization": "Bearer token123", "X-Custom": "val" }
```

> 单测用例 `loads remote MCP with headers` 已覆盖。

### T37.42 MCP 多条目

验证一个 `opencode.json` 中多个 MCP 同时加载：

```json
{
  "mcp": {
    "remote-server": { "type": "remote", "url": "https://a.com/mcp" },
    "local-server": { "type": "local", "command": ["node", "srv.js"] },
    "disabled-server": { "type": "remote", "url": "https://b.com/mcp", "enabled": false }
  }
}
```

期望 `loaded` 包含全部 3 个：

```text
mcp/remote-server
mcp/local-server
mcp/disabled-server
```

### T37.43 opencode.jsonc 注释和尾逗号

验证 JSONC 格式（注释 + 尾逗号）正确解析：

```jsonc
{
  // MCP 服务器配置
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://example.com/mcp", // 生产环境
    }, // 尾逗号
  },
}
```

期望：`loaded` 包含 `mcp/github`，JSONC 注释和尾逗号不影响解析。

> 单测用例 `loads MCP from opencode.jsonc` 已覆盖。

### T37.44 单数 vs 复数目录名

验证 opencode 同时支持单数和复数目录名：

```text
.opencode/
├── agent/reviewer.md      ← 单数
├── agents/tester.md       ← 复数
├── skill/helper/SKILL.md  ← 单数
├── skills/reviewer/SKILL.md ← 复数
├── command/deploy.md      ← 单数
├── commands/review.md     ← 复数
├── plugin/audit.ts        ← 单数
├── plugins/marker.ts      ← 复数
└── tool/format.ts         ← 官方单数
```

期望：全部 9 个文件被加载（`agent/` 和 `agents/` 的文件都出现在 `loaded` 中）。

> 单测用例 `loads agents from plural agents/ directory` 等已覆盖。

### T37.45 嵌套目录路径

验证 Agent 和 Command 支持嵌套子目录：

```text
.opencode/
├── agents/category/deploy.md     ← 嵌套路径
├── commands/category/review.md   ← 嵌套路径
```

期望：

- `agents/category/deploy`（名称包含路径前缀）
- `commands/category/deploy`（名称包含路径前缀）

> 单测用例 `extracts command name from nested directory path` 已覆盖。

### T37.46 Command model 和 subtask 字段

验证 Command 的 `model` 和 `subtask` 字段：

```yaml
---
description: Deploy command
agent: build
model: anthropic/claude-sonnet-4
subtask: true
---
Deploy the application.
```

期望 `SessionCommand.Input`：

```json
{
  "name": "deploy",
  "description": "Deploy command",
  "agent": "build",
  "model": "anthropic/claude-sonnet-4",
  "subtask": true
}
```

### T37.47 Plugin enabled/disabled

验证 Plugin 可以通过 Session API 启用/禁用：

```bash
# 加载 Plugin（默认启用）
curl -s -X POST "$BASE/session/$SID/dot-opencode/load"

# 禁用 Plugin
curl -s -X DELETE "$BASE/session/$SID/plugins/marker"

# 验证已从 session_plugins 删除
psql $PG -Atc "SELECT count(*) FROM session_plugins WHERE session_id='$SID' AND name='marker'"
# 期望: 0
```

### T37.48 Skill resources 内容验证

验证 Skill 的 `resources` 字段正确收集附加文件内容：

```text
.opencode/
└── skills/my-skill/
    ├── SKILL.md          ← 主文件
    ├── references/guide.md   ← 资源文件
    └── templates/todo.md     ← 资源文件
```

期望 `SessionSkill.Input.resources` 包含 2 个资源条目：

```json
[
  { "path": "references/guide.md", "type": "doc", "content": "# Guide\n..." },
  { "path": "templates/todo.md", "type": "template", "content": "..." }
]
```

资源限制：

- 单个资源文件 > 256KB → 跳过
- 总资源 > 1MB → 截断
- 资源数量 > 64 → 截断

> 单测用例 `skips skill resources exceeding size limit`、`limits skill resource count` 已覆盖。

### T37.49 opencode.json 无 mcp 字段

验证 `opencode.json` 中没有 `mcp` 字段时不报错：

```json
{
  "command": { "greet": { "template": "hello" } }
}
```

期望：

- 不加载任何 MCP
- 不在 `skipped` 中出现 MCP 相关条目
- 其他资源（AGENTS.md 等）正常加载

> 单测用例 `handles opencode.json without mcp field gracefully` 已覆盖。

### T37.50 空 frontmatter Agent

验证空 frontmatter 的 Agent 使用默认值：

```markdown
---
---
Just a prompt.
```

期望 `SessionAgent.Input`：

```json
{
  "name": "minimal",
  "mode": "all",
  "prompt": "Just a prompt."
}
```

> 单测用例 `loads agent with empty frontmatter` 已覆盖。

### T37.51 同名资源路径冲突

验证同名 Agent 从不同路径加载（后加载覆盖先加载）：

```text
.opencode/
├── agents/reviewer.md         ← 文件
├── agents/reviewer/index.md   ← 目录形式同名
```

期望：`loaded` 中至少出现一个 `agents/reviewer`，不报错。

> 单测用例 `handles same-name agent from different paths (last wins)` 已覆盖。

### T37.52 并发 load 调用

验证同一 Session 并发调用 load 不会产生重复或冲突：

```bash
# 并发发起 3 次 load
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/dot-opencode/load" &
done
wait
```

期望：

- 3 次调用都返回 `200`
- PG 中同名资源仍只有 1 条（upsert 幂等）
- 不产生重复 AGENTS.md 内容

> 当前单元测试只验证 loader 并发执行不会失败；PG 唯一约束和真实请求竞态必须通过下面的数据库 e2e 用例验证。

### T37.53 源文件删除后的陈旧 PG 记录

验证加载后的源文件被删除，再次 load 时的同步语义。此用例必须先明确以下产品约定：

- **完全同步**：`.opencode` 中已不存在的资源由本次 load 删除；或
- **增量覆盖**：load 只 upsert 当前存在的资源，历史 PG 记录保留，删除由 Session API 完成。

推荐测试步骤：

```bash
# 首次加载 agents/a.md、skills/a/SKILL.md、tool/a.ts、commands/a.md、plugins/a.ts 和 mcp/a
curl -s -X POST "$BASE/session/$SID/dot-opencode/load"

# 删除所有对应源文件，只保留 .opencode 目录
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"rm -rf .opencode/agents/a.md .opencode/skills/a .opencode/tool/a.ts .opencode/commands/a.md .opencode/plugins/a.ts"}'

# 再次加载并查询六类 Session 资源表
curl -s -X POST "$BASE/session/$SID/dot-opencode/load"
```

验收要求：

- 记录实际采用的同步语义，不能只断言 `loaded`。
- 如果采用完全同步，所有由 `.opencode` 产生的陈旧记录必须删除。
- 如果采用增量覆盖，陈旧记录必须明确保留，并在 API 文档中说明不会自动删除。
- 通过 API 注入的同名资源不能被项目配置清理逻辑误删。

### T37.54 禁用资源已有 PG 记录时的清理

验证资源先成功加载，再改为禁用，避免只覆盖“首次加载禁用资源”的场景。

```bash
# 首次加载 enabled agent/plugin 和 enabled MCP
curl -s -X POST "$BASE/session/$SID/dot-opencode/load"

# 将 Agent 设置 disable: true，MCP 设置 enabled: false；Plugin 使用项目约定的禁用方式
curl -s -X POST "$BASE/session/$SID/dot-opencode/load"
```

验收要求：

- `disable: true` 的 Agent 是否删除已有 `session_agents` 记录，必须有明确约定。
- `enabled: false` 的 MCP 应保留记录并持久化 `enabled=false`，不能被误删。
- Plugin 当前 DELETE API 是删除，不是 enabled toggle；T37.47 不得称为“启用/禁用”，除非新增真正的 toggle API。
- 禁用 `.opencode` 资源不能影响其它 Session，也不能影响通过 Session API 注入的资源。

### T37.55 真实 PG 并发 load 竞态

在真实 PostgreSQL 和 HTTP 服务上验证 T37.52 的数据库部分：

```bash
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/dot-opencode/load" > "/tmp/load-$i.json" &
done
wait

for i in 1 2 3; do
  jq -e '.loaded and (.skipped | length == 0)' "/tmp/load-$i.json"
done

psql "$PG" -Atc \
  "SELECT name, count(*) FROM session_agents WHERE session_id='$SID' GROUP BY name HAVING count(*) <> 1;"
```

期望：

- 三个请求均返回 HTTP `200`。
- 每个资源名称在对应 PG 表中最多一条。
- 不出现唯一键冲突、部分 JSON 写入或重复 AGENTS.md 内容。
- 失败请求必须返回明确错误，不能返回部分 `loaded` 成功结果。

## 十一、验收标准

- 用户可以通过公开接口主动触发 `.opencode` 加载。
- Agent、Skill、MCP、Tool、Command、Plugin、AGENTS.md 均可加载。
- MCP 使用官方 `opencode.json(c)` 的 `mcp` 配置格式。
- 加载结果持久化到当前 Session 的 PostgreSQL 表。
- 同名配置满足 `.opencode > Session PG > 全局配置`。
- 非法资源不会阻断其它合法资源加载。
- 重复调用具备幂等性。
- 不同 Session 之间相互隔离。
- 加载阶段不执行 Plugin、Tool，不连接 MCP。
- **沙箱模式下从沙箱工作区读取 `.opencode` 配置**（非 SaaS 服务器本地 FS）。
- **macOS AppleDouble `._*` 文件不影响加载**（find `-not -name '._*'`）。
- **第三方工具（codegraph）生成的 MCP + AGENTS.md 放入 `.opencode/` 后可被自动发现和注入**，AI 能在运行时调用 MCP 工具分析代码。
- **同一 Session 多个 MCP 工具不互相串台**（antd 8 工具 + codegraph 1 工具各自正确）。
- **不同 Session 同名 MCP 完全隔离**（多个 antd/codegraph session 并发不串台）。
- **沙箱复用时 stale MCP 进程被清理**，不导致工具名错误（`pkill` 端口级清理）。
- **Agent 全字段正确映射**（description/mode/model/temperature/top_p/steps/color/variant/options/permission/prompt）。
- **Agent permission 字段正确解析**为 Permission.Ruleset（edit/write/bash + allow/deny/ask）。
- **Agent disable 和内部名称保护**（disable=true 跳过，compaction/title/summary 不覆盖）。
- **MCP local 类型支持 command + environment**，MCP remote 类型支持 url + headers。
- **MCP 多条目同时加载**（一个 opencode.json 中多个 MCP 全部写入）。
- **opencode.jsonc 格式兼容**（注释、尾逗号不影响解析）。
- **单数和复数目录名都支持**（agent/ 和 agents/ 均可）。
- **嵌套目录路径正确解析**（agents/category/deploy.md → name="category/deploy"）。
- **Command model 和 subtask 字段持久化**。
- **Skill resources 收集和限制**（256KB/1MB/64 个限制）。
- **opencode.json 无 mcp 字段时不报错**，其他资源正常加载。
- **空 frontmatter Agent 使用默认值**（mode=all）。
- **并发 load 调用幂等**（不产生重复记录）。
