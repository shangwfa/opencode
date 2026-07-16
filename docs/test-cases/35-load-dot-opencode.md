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

## 七、验收标准

- 用户可以通过公开接口主动触发 `.opencode` 加载。
- Agent、Skill、MCP、Tool、Command、Plugin、AGENTS.md 均可加载。
- MCP 使用官方 `opencode.json(c)` 的 `mcp` 配置格式。
- 加载结果持久化到当前 Session 的 PostgreSQL 表。
- 同名配置满足 `.opencode > Session PG > 全局配置`。
- 非法资源不会阻断其它合法资源加载。
- 重复调用具备幂等性。
- 不同 Session 之间相互隔离。
- 加载阶段不执行 Plugin、Tool，不连接 MCP。
