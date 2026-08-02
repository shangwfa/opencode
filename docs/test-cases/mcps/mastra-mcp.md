# Mastra MCP 端到端验证

> 验证 `@mastra/mcp-docs-server` 在 SaaS 沙箱内完整工作：创建 → PG 持久化 → AI 感知工具 → AI 查询文档 → AI 生成代码。
>
> MCP 文档：https://mastra.ai/docs/getting-started/build-with-ai

## MCP Server 信息

| 字段 | 值 |
|------|-----|
| 名称 | `@mastra/mcp-docs-server` |
| 命令 | `npx -y @mastra/mcp-docs-server@latest` |
| 类型 | local（sandbox 内启动 stdio 进程） |
| 功能 | Mastra 框架文档查询、API 参考、代码示例、迁移工具 |
| OpenCode 配置 | https://mastra.ai/docs/getting-started/build-with-ai#opencode |

---

## 通用变量

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL`，不重复定义。

---

### T41.1 创建 local MCP

```bash
SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"mastra","type":"local","command":["npx","-y","@mastra/mcp-docs-server@latest"]}'

# PG 验证
psql "$PG_URL" -t -A -c "SELECT name, type FROM session_mcps WHERE session_id='$SID' AND name='mastra'"
```

**期望**：`name=mastra`，`type=local`，PG 持久化正确

---

### T41.2 AI 感知 MCP 工具

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请列出你所有以 mastra 开头的 MCP 工具名称和功能\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print(p['text'][:300])
"
```

**期望**：AI 列出 mastra MCP 工具表（如 `mastra_mastraDocs`、`mastra_getMastraExportDetails`、`mastra_getMastraCourseStatus` 等）

---

### T41.3 AI 调用 MCP 工具查询文档

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 mastra MCP 工具查询如何创建一个 agent，给我一个简单的示例\"}],\"model\":$MODEL}" \
  > /dev/null

# PG 验证工具调用
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool' LIKE 'mastra_%'"
```

**期望**：PG 出现 `mastra_mastraDocs(completed)`，AI 返回 agent 创建示例代码

---

### T41.4 AI 基于 MCP 文档生成代码

```bash
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 mastra MCP 工具查看文档后，帮我创建一个简单的 Mastra agent 到 /workspace/my-agent.ts，功能是回答天气问题\"}],\"model\":$MODEL}" \
  > /dev/null

# 验证文件生成
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"wc -c /workspace/my-agent.ts && head -5 /workspace/my-agent.ts"}'
```

**期望**：
- AI 调用多个 mastra MCP 工具（`mastra_mastraDocs` 等）查询最新 API
- AI 用 `write` 工具生成 `/workspace/my-agent.ts`
- 文件含 Mastra Agent 定义（`new Agent({...})`）

---

## 验收汇总

| 用例 | 结果 | 验证详情 |
|------|------|---------|
| T41.1 创建 MCP | ✅ | PG `mastra\|local` |
| T41.2 AI 感知工具 | ✅ | AI 列出 13 个 mastra 工具（listMastraPackages/getMastraExports/getMastraExportDetails/mastraDocs/searchMastraDocs 等） |
| T41.3 AI 查询文档 | ✅ | `mastraDocs`×2 + `searchMastraDocs`×1 全部 completed，返回 agent 创建示例（`new Agent({...})`） |
| T41.4 AI 生成代码 | ✅ | `mastraDocs`（docs/agents/using-tools）+ write → my-agent.ts（35 行，weatherAgent + weatherTool） |

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| CRUD | 创建/PG 持久化 | ✅ |
| AI 感知 | AI 列出 MCP 工具 | ✅ |
| AI 调用 | AI 实际调用 mastra MCP 工具 | ✅ mastraDocs/completed |
| AI 生成 | AI 基于 MCP 文档生成代码 | ✅ my-agent.ts |

---

## 测试命令汇总

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
export NO_PROXY=localhost,127.0.0.1

# 1. 创建 session + keepAlive
SID=$(new_sid -k)

# 2. 创建 mastra MCP
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"mastra","type":"local","command":["npx","-y","@mastra/mcp-docs-server@latest"]}'

# 3. AI 列出 MCP 工具
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"列出你所有 mastra 开头的 MCP 工具\"}],\"model\":$MODEL}"

# 4. AI 调用 MCP 查文档
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 mastra MCP 工具查如何创建 agent\"}],\"model\":$MODEL}"

# 5. PG 验证工具调用
psql "$PG_URL" -t -c "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool' LIKE 'mastra_%'"
```
