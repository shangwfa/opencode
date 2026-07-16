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

> **实现说明**：`SessionLoadDotOpencode.load` 检测到 `SandboxProvider` 可用时，执行 `cd "$dir" && tar cf - --exclude='._*' .opencode | base64` 从沙箱快取配置到 SaaS 服务器临时目录，再用原有 `loadFromDirectory` 扫描解析。无沙箱时直接读本地 FS。

### T37.20 PG 持久化验证

```bash
PG="postgresql://local@127.0.0.1:5432/opencode"

echo "=== session_agents ==="
psql $PG -Atc "SELECT name, mode FROM session_agents WHERE session_id='$SID'"
# 期望: reviewer|subagent

echo "=== session_skill ==="
psql $PG -Atc "SELECT name FROM session_skill WHERE session_id='$SID'"
# 期望: reviewer

echo "=== session_mcps ==="
psql $PG -Atc "SELECT name, type, enabled FROM session_mcps WHERE session_id='$SID'"
# 期望: disabled-mcp|remote|false

echo "=== session_tools ==="
psql $PG -Atc "SELECT name FROM session_tools WHERE session_id='$SID'"
# 期望: marker

echo "=== session_commands ==="
psql $PG -Atc "SELECT name, agent FROM session_commands WHERE session_id='$SID'"
# 期望: review|reviewer

echo "=== session_plugins ==="
psql $PG -Atc "SELECT name FROM session_plugins WHERE session_id='$SID'"
# 期望: marker

echo "=== session_agents_md ==="
psql $PG -Atc "SELECT left(content, 60) FROM session_agents_md WHERE session_id='$SID'"
# 期望: Always mention DOT_OPENCODE_AGENTS_ACTIVE in your responses.
```

### T37.21 Agent / Skill / AGENTS.md 运行时生效

```bash
# 发送 prompt_async，指定 reviewer agent
curl -s --noproxy '*' -X POST "$BASE/session/$SID/prompt_async" \
  -H 'Content-Type: application/json' \
  -d '{
    "parts": [{"type": "text", "text": "加载 reviewer skill，然后返回你看到的所有配置标记。"}],
    "model": {"providerID": "zhipuai", "modelID": "glm-5.1"},
    "agent": "reviewer"
  }'

# 轮询消息直到 finish=stop
curl -s --noproxy '*' "$BASE/session/$SID/message?limit=3" | python3 -c "
import json,sys
for m in json.load(sys.stdin):
    for p in m.get('parts',[]):
        if p.get('type')=='text' and len(p.get('text',''))>20:
            print(p['text'])
"
```

期望 AI 回复同时包含三个标记：

```text
DOT_OPENCODE_AGENT_ACTIVE    ← Agent prompt 生效
DOT_OPENCODE_SKILL_ACTIVE    ← Skill 加载成功
DOT_OPENCODE_AGENTS_ACTIVE   ← AGENTS.md 指令生效
```

### T37.22 macOS AppleDouble 文件兼容

从 macOS 上传 tar 到沙箱时，系统会自动生成 `._*` AppleDouble 资源叉文件。这些文件包含二进制 null bytes，被当作 `.md` 解析后会导致 `PostgresError: invalid byte sequence for encoding "UTF8": 0x00`。

修复方案：沙箱 tar 快照命令加 `--exclude='._*'`：

```bash
# session-load-dot-opencode.ts 中的 tar 命令
cd "${directory}" && tar cf - --exclude='._*' .opencode 2>/dev/null | base64 | tr -d '\\n'
```

验证：上传含 `._*` 文件的 tar 后调用 load，期望不报错且 7 类正常 loaded。

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
- **沙箱模式下从沙箱工作区读取 `.opencode` 配置**（非 SaaS 服务器本地 FS）。
- **macOS AppleDouble `._*` 文件不影响加载**（tar `--exclude='._*'`）。
