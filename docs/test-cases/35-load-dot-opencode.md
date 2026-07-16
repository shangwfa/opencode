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

> 以下用例在 Docker SaaS 容器 + 本地 PG + 远程 Sandbox 环境下实际执行通过。
>
> 环境：`opencode-saas-test` 容器，API `http://127.0.0.1:14096`，PG `postgresql://local@127.0.0.1:5432/opencode`。

### T37.15 环境准备与项目创建

```bash
# 宿主机本地 PG 转发（Docker 容器通过 host.docker.internal:15432 访问）
kill $(lsof -ti :15432) 2>/dev/null || true
nohup node -e "const net=require('net');net.createServer(c=>{const r=net.connect(5432,'127.0.0.1');c.pipe(r);r.pipe(c);c.on('error',()=>r.destroy());r.on('error',()=>c.destroy())}).listen(15432,'0.0.0.0')" &
sleep 2 && lsof -i :15432 | grep LISTEN

# 启动 SaaS 容器（本地 PG + 远程 Sandbox）
docker rm -f opencode-saas-test 2>/dev/null
docker run -d --name opencode-saas-test \
  -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://local@host.docker.internal:15432/opencode \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:30040 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e ZHIPU_API_KEY \
  opencode-saas-sandbox-test:v2fix serve --hostname 0.0.0.0 --port 4096 --print-logs

sleep 12 && docker inspect --format '{{.State.Health.Status}}' opencode-saas-test
# 期望: healthy
```

在容器内创建测试项目和 `.opencode` 配置：

```bash
# 创建项目目录
docker exec -u 0 opencode-saas-test mkdir -p /workspace/dot-opencode-vite/.opencode/{agents,skills/reviewer,tool,commands,plugins}

# 逐个写入配置文件（用 printf + docker exec -i 避免 shell 变量展开）
printf '%s' '---
description: Review agent
mode: subagent
permission:
  "*": allow
---
Include DOT_OPENCODE_AGENT_ACTIVE.' | docker exec -i -u 0 opencode-saas-test sh -c 'cat > /workspace/dot-opencode-vite/.opencode/agents/reviewer.md'

printf '%s' '---
name: reviewer
description: Review skill
---
Include DOT_OPENCODE_SKILL_ACTIVE.' | docker exec -i -u 0 opencode-saas-test sh -c 'cat > /workspace/dot-opencode-vite/.opencode/skills/reviewer/SKILL.md'

printf '%s' 'export default {
  description: "Return marker",
  args: {},
  async execute() { return "DOT_OPENCODE_TOOL_ACTIVE" },
}' | docker exec -i -u 0 opencode-saas-test sh -c 'cat > /workspace/dot-opencode-vite/.opencode/tool/marker.ts'

printf '%s' '---
description: Review command
agent: reviewer
---
Include DOT_OPENCODE_COMMAND_ACTIVE.' | docker exec -i -u 0 opencode-saas-test sh -c 'cat > /workspace/dot-opencode-vite/.opencode/commands/review.md'

printf '%s' 'export default { name: "marker-plugin" }' | docker exec -i -u 0 opencode-saas-test sh -c 'cat > /workspace/dot-opencode-vite/.opencode/plugins/marker.ts'

# AGENTS.md 和 opencode.json（注意 $schema 需要 printf 转义）
echo 'Always mention DOT_OPENCODE_AGENTS_ACTIVE.' | docker exec -i -u 0 opencode-saas-test sh -c 'cat > /workspace/dot-opencode-vite/.opencode/AGENTS.md'

printf '%s' '{"$schema":"https://opencode.ai/config.json","mcp":{"disabled-mcp":{"type":"remote","url":"https://example.invalid/mcp","enabled":false}}}' | docker exec -i -u 0 opencode-saas-test sh -c 'cat > /workspace/dot-opencode-vite/.opencode/opencode.json'

# 修正文件权限
docker exec -u 0 opencode-saas-test chown -R opencode:opencode /workspace/dot-opencode-vite

# 验证文件数量（期望 7）
docker exec opencode-saas-test find /workspace/dot-opencode-vite/.opencode -type f | wc -l
```

### T37.16 创建 Session 并加载全部配置

```bash
BASE="http://127.0.0.1:14096"
DIR="/workspace/dot-opencode-vite"

# 创建 Session
SID=$(curl -s -X POST "$BASE/session?directory=$DIR" \
  -H 'Content-Type: application/json' \
  -d '{"title":"dot-opencode-e2e"}' | jq -r '.id')
echo "SID: $SID"

# 调用加载接口
curl -s -X POST "$BASE/session/$SID/dot-opencode/load?directory=$DIR" | jq
```

期望：

```json
{
  "loaded": ["AGENTS.md", "agents/reviewer", "skills/reviewer", "mcp/disabled-mcp", "tool/marker", "commands/review", "plugins/marker"],
  "skipped": []
}
```

### T37.17 PG 持久化验证

```bash
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT count(*) FROM session_agents WHERE session_id='$SID'"
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT count(*) FROM session_skill WHERE session_id='$SID'"
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT count(*) FROM session_mcps WHERE session_id='$SID'"
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT count(*) FROM session_tools WHERE session_id='$SID'"
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT count(*) FROM session_commands WHERE session_id='$SID'"
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT count(*) FROM session_plugins WHERE session_id='$SID'"
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT count(*) FROM session_agents_md WHERE session_id='$SID'"
```

期望：每张表各返回 `1`。MCP 验证 `enabled=false`：

```bash
psql postgresql://local@127.0.0.1:5432/opencode -Atc "SELECT name,enabled FROM session_mcps WHERE session_id='$SID'"
# 期望: disabled-mcp|false
```

### T37.18 Agent / Skill / AGENTS.md 运行时生效

```bash
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type": "text", "text": "加载 reviewer skill，返回你看到的配置标记。"}],
    "model": {"providerID": "zhipuai", "modelID": "glm-5.1"},
    "agent": "reviewer"
  }'
```

轮询消息直到 `finish: "stop"`，检查 AI 回复是否包含：

```text
DOT_OPENCODE_AGENT_ACTIVE    ← Agent prompt 生效
DOT_OPENCODE_SKILL_ACTIVE    ← Skill 加载成功
DOT_OPENCODE_AGENTS_ACTIVE   ← AGENTS.md 指令生效
```

### T37.19 Command 运行时生效

```bash
curl -s -X POST "$BASE/session/$SID/command" \
  -H 'Content-Type: application/json' \
  -d '{
    "command": "review",
    "arguments": "",
    "agent": "reviewer",
    "model": "zhipuai/glm-5.1"
  }' | jq '.parts[] | select(.type=="text") | .text'
```

期望：命令以 `reviewer` agent 执行，返回包含 `DOT_OPENCODE_COMMAND_ACTIVE`。

### T37.20 Tool 运行时生效

```bash
curl -s -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type": "text", "text": "请调用 marker 工具并返回结果。"}],
    "model": {"providerID": "zhipuai", "modelID": "glm-5.1"},
    "agent": "reviewer"
  }'
```

轮询消息直到完成，期望 AI 成功调用 `marker` 工具，返回 `DOT_OPENCODE_TOOL_ACTIVE`。

> **容器环境修复**：`importToolCode` 在容器内写入临时文件时，`import.meta.dir`（`/app/packages/opencode/src/tool/`）对 `opencode` 用户只读。代码已修复为优先尝试 `import.meta.dir`，失败后 fallback 到 `os.tmpdir()`。无 bare import 的简单工具（如 `marker.ts`）可通过 fallback 正常加载。

### T37.21 `.opencode` 覆盖接口注入

```bash
# 先通过接口注入同名 Agent
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"reviewer","mode":"subagent","description":"API_OVERRIDE","prompt":"API_OVERRIDE_PROMPT"}'

# 再次加载 .opencode
curl -s -X POST "$BASE/session/$SID/dot-opencode/load?directory=$DIR" | jq

# 验证 PG 中 reviewer 被覆盖回 .opencode 的内容
psql postgresql://local@127.0.0.1:5432/opencode -Atc \
  "SELECT prompt FROM session_agents WHERE session_id='$SID' AND name='reviewer'"
# 期望: 包含 .opencode/agents/reviewer.md 的内容，不是 API_OVERRIDE_PROMPT
```

## 八、验收标准

- 用户可以通过公开接口主动触发 `.opencode` 加载。
- Agent、Skill、MCP、Tool、Command、Plugin、AGENTS.md 均可加载。
- MCP 使用官方 `opencode.json(c)` 的 `mcp` 配置格式。
- 加载结果持久化到当前 Session 的 PostgreSQL 表。
- 同名配置满足 `.opencode > Session PG > 全局配置`。
- 非法资源不会阻断其它合法资源加载。
- 重复调用具备幂等性。
- 不同 Session 之间相互隔离。
- 加载阶段不执行 Plugin、Tool，不连接 MCP。
