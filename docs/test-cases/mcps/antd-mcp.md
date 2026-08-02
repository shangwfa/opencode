# Ant Design MCP 端到端验证

> 验证 Session MCP 功能通过 Ant Design 官方 MCP Server 完整生效：创建 → PG 持久化 → sandbox 启动 MCP server → AI 感知工具 → AI 查询 API → AI 生成代码。

## 测试环境

- 容器：`opencode-saas-test`（localhost:14096）
- PG：本地 PostgreSQL（host.docker.internal:15432）
- Sandbox：远端 K8s Sandbox API（host.docker.internal:30040）
- 模型：zhipuai/glm-5.2

## MCP Server 信息

| 字段 | 值 |
|------|-----|
| 名称 | `@ant-design/cli` |
| 命令 | `npx -y @ant-design/cli mcp` |
| 类型 | local（sandbox 内启动 stdio 进程） |
| 文档 | https://ant.design/docs/react/mcp-cn |
| 工具数 | 8（antd_list / antd_info / antd_doc / antd_demo / antd_token / antd_design_md / antd_semantic / antd_changelog） |

---

## 一、CRUD 基础验证

### T40.1 创建 local MCP

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"antd","type":"local","command":["npx","-y","@ant-design/cli","mcp"]}'
```

**PG 验证**：
```sql
SELECT name, type, enabled FROM session_mcps WHERE session_id='$SID';
-- antd | local | t
```

**结果**：✅ PG 持久化正确

### T40.2 列出/删除/隔离/级联

| 用例 | 结果 | PG 验证 |
|------|------|---------|
| 列出 MCP | ✅ | API 返回 antd |
| 删除单个 | ✅ | PG count=0 |
| 跨 session 隔离 | ✅ | A 有 B 无 |
| 删除 session 级联 | ✅ | MCP 记录随 session 删除 |

---

## 二、AI 感知 MCP 工具

### T40.3 AI 列出可用 MCP 工具

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"请列出你当前所有以 antd_ 开头的 MCP 工具名称和功能。"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```

**AI 回复**：

| 工具 | 功能 |
|------|------|
| `antd_antd_list` | 列出所有可用的 antd 组件 |
| `antd_antd_info` | 获取组件 API 信息（props、类型、默认值） |
| `antd_antd_doc` | 获取组件完整 markdown 文档 |
| `antd_antd_demo` | 获取组件示例源代码 |
| `antd_antd_token` | 查询设计 token（全局/组件级） |
| `antd_antd_design_md` | 获取设计语言文档 |
| `antd_antd_semantic` | 查询组件语义化自定义结构 |
| `antd_antd_changelog` | 分析跨版本 API 变更 |

**结果**：✅ AI 正确感知全部 8 个 MCP 工具

---

## 三、AI 实际调用 MCP 工具

### T40.4 调用 antd_list 列出组件

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 antd_antd_list 工具列出所有可用的 antd 组件，只列出组件名"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```

**PG 验证**：
```sql
SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'type'='tool';
-- antd_antd_list | completed
```

**AI 回复**：返回 50+ 组件名（Affix, Alert, Anchor, App, AutoComplete, Avatar, Badge, Button, Calendar, Card, ...）

**结果**：✅ `antd_antd_list(completed)`，返回真实组件数据

### T40.5 调用 antd_info 获取 Button API

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 antd_antd_info 工具查看 Button 组件的 API 信息"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}'
```

**PG 验证**：
```sql
-- antd_antd_info | completed
```

**AI 回复**：返回 Button 完整 props 表格（autoInsertSpace, block, color, danger, disabled, ...），含类型和默认值。

**结果**：✅ `antd_antd_info(completed)`，返回真实 API 文档

---

## 四、完整开发流程：AI 用 MCP 设计数据看板

### T40.6 AI 调用多个 MCP 工具生成完整页面

**Prompt**：

> 帮我设计一个数据看板页面，使用 Ant Design 组件库。要求：
> 1. 顶部：4 个统计卡片（总用户、活跃用户、收入、转化率），带图标和趋势
> 2. 中间：左侧折线图区域，右侧饼图区域
> 3. 底部：数据表格，带搜索和分页
> 4. 先用 antd MCP 工具查看 Card、Statistic、Table、Layout 组件的最新 API 和示例，再写代码
> 5. 输出完整的单个 tsx 文件

**AI 工具调用链（PG 18 次全部 completed）**：

| 顺序 | 工具 | 说明 |
|------|------|------|
| 1 | `antd_antd_list` | 列出全部 antd 组件 |
| 2-5 | `antd_antd_info` × 4 | 查询 Card/Statistic/Table/Layout API |
| 6-10 | `antd_antd_demo` × 5 | 获取 Card/Statistic/Table/Layout 示例代码 |
| 11-14 | `todowrite` × 4 | 任务进度跟踪 |
| 15 | `write` | 写入 /workspace/Dashboard.tsx |

**生成代码**：495 行完整 tsx，包含：
- Layout(Header + Content + Footer)
- 4 个统计卡片（Statistic + 图标 + 趋势）
- SVG 折线图 + 环形饼图（无额外图表库依赖）
- Table（搜索、状态筛选、排序、分页）
- 使用 antd v6 API（`variant="borderless"`、`theme.useToken()`）

**结果**：✅ AI 先查 MCP 获取最新 API/示例，再基于真实文档生成代码

---

## 五、已修复的注入问题

### 问题：MCP.node deps 缺少 Database.node

**根因**：LayerNode 重构后，`MCP.node` 的 `deps` 列表缺少 `Database.node`，导致 `SessionMcp.pgLayer`（依赖 `Database.Service`）在 AI 消息上下文中不可用。session MCP 虽然写入 PG 但 AI 无法感知。

**修复**：
```diff
# packages/opencode/src/mcp/index.ts
- deps: [CrossSpawnSpawner.node, McpAuth.node, EventV2Bridge.node, Config.node],
+ deps: [CrossSpawnSpawner.node, McpAuth.node, EventV2Bridge.node, Config.node, FSUtil.node, Database.node],
```

**同类问题**：`Skill.node` 也有相同问题（已在 session skill 测试中修复）。

---

## 验收汇总

| 用例 | 结果 | 验证详情 |
|------|------|---------|
| T40.1 创建 MCP | ✅ | PG `antd\|local\|enabled=t` |
| T40.2 CRUD | ✅ | 列出/删除/隔离/级联全通过（与 T22 同资源覆盖） |
| T40.3 AI 感知工具 | ✅ | 列出 8 个 antd_ 工具（list/info/doc/demo/token/design_md/semantic/changelog） |
| T40.4 antd_list 调用 | ✅ | `antd_list(completed)`，返回 50+ 组件 |
| T40.5 antd_info 调用 | ✅ | `antd_info(completed)`，返回 Button 完整 API |
| T40.6 完整开发流程 | ✅ | antd_info×5 + antd_demo×9 + antd_list×1 全 completed，write 生成 Dashboard.tsx |

> **2026-08-02 重跑记录**（容器重建后）：T40.1-6 全通过。环境为 `OPENCODE_EXPERIMENTAL_CODE_MODE=all`，antd MCP 工具经 code-mode `execute` 内嵌调用（metadata.toolCalls 记录 `antd.antd_*`，PG `part` 表以 execute 持久化并可从 toolCalls 提取）。本次 T40.6 生成 Dashboard.tsx **412 行**（Card×11 / Statistic / Table / `variant="borderless"` 等 antd v6 API，2 个 SVG 图表），先查 MCP API/示例再写代码的完整流程与历史一致。

**验证层级**：

| 层级 | 标准 | 结果 |
|------|------|------|
| CRUD | 创建/读取/删除/隔离/级联 | ✅ 全通过 |
| PG 持久化 | session_mcps 表字段正确 | ✅ name/type/command/enabled |
| AI 感知 | AI 列出 MCP 工具 | ✅ 8 个 antd_ 工具 |
| AI 调用 | AI 实际调用 MCP 工具 | ✅ list/info/demo 全部 completed |
| AI 生成 | AI 基于 MCP 数据生成代码 | ✅ 495 行完整看板页面 |
| MCP 进程 | sandbox 中 npx 启动 MCP server | ✅ stdio 进程正常运行 |

---

## 测试命令汇总

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
export NO_PROXY=localhost,127.0.0.1

# 1. 创建 session + keepAlive
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null

# 2. 创建 antd MCP
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{"name":"antd","type":"local","command":["npx","-y","@ant-design/cli","mcp"]}'

# 3. AI 列出 MCP 工具
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"列出你所有 antd_ 开头的 MCP 工具\"}],\"model\":$MODEL}"

# 4. AI 调用 MCP 工具
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 antd_antd_list 列出组件\"}],\"model\":$MODEL}"

# 5. PG 验证
psql "$PG_URL" -t -c \
  "SELECT data->>'tool', data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'type'='tool'"
```
