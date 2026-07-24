# Code-Mode（execute 工具）端到端验证

> 验证 SaaS 环境下 Code-Mode 功能完整链路：MCP 工具发现 → `execute` 工具注册 → 受限 JS 解释器编排 → 子工具调用 → 权限/并发/错误/附件 → PG 元数据持久化。
>
> 设计文档：`packages/codemode/codemode.md`；工具实现：`packages/opencode/src/tool/code-mode.ts`

## 前置条件

| 条件 | 说明 |
|------|------|
| SaaS 容器 | `opencode-saas-sandbox-test`，`OPENCODE_SANDBOX_ENABLED=true` |
| 沙箱转发器 | `0.0.0.0:30040` → `172.18.32.15:30040` 运行中 |
| PG | `postgresql://local@127.0.0.1:15432/opencode` |
| MCP Server | 需要至少一个 MCP server（本测试用 echo / calculate 类工具） |

---

## 一、准备 session + MCP 工具

### T50.1 创建 session

```bash
SID=$(new_sid -kb)
echo "SID: $SID"
```

**期望**：返回 `ses_xxx`；沙箱就绪。

### T50.2 注册测试用 local MCP

注册一个返回结构化数据的 echo MCP，用于后续 code-mode 编排：

```bash
curl -s -X POST "$BASE/session/$SID/mcps/create" -H 'Content-Type: application/json' \
  -d '{
    "name":"echo",
    "type":"local",
    "command":["npx","-y","@anthropic/mcp-echo@latest"]
  }'

# PG 验证
psql "$PG_URL" -t -A -c "SELECT name, type FROM session_mcps WHERE session_id='$SID' AND name='echo'"
```

**期望**：`echo|local`，PG 持久化正确。

### T50.3 等待 MCP 连接

```bash
sleep 5
curl -s "$BASE/session/$SID/mcps/status" | jq '.[] | select(.name=="echo") | .status'
```

**期望**：`connected`。

---

## 二、execute 工具发现与注册

### T50.4 AI 感知 execute 工具

当 session 有已连接的 MCP 工具时，模型应看到唯一的 `execute` 工具（而非逐个暴露的 MCP 工具）：

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"列出你当前可用的所有工具名称\"}],\"model\":$MODEL}"
```

**期望**：AI 回复中包含 `execute` 工具；不直接暴露 `echo_echo` 等原始 MCP 工具名。

### T50.5 describeCatalog 生成指令包含工具树

验证 `execute` 工具的 description 包含 Code-Mode 工作流指令和工具目录（`## Workflow`、`## Available tools`、`tools.echo.echo` 路径）：

```bash
# 检查 execute 工具的 description 中是否包含工具树路径
curl -s "$BASE/session/$SID" | jq -r '.data.session_tools' 2>/dev/null || true

# PG 验证 execute 工具的注册
psql "$PG_URL" -t -A -c "SELECT data->>'tool' FROM part WHERE session_id='$SID' AND data->>'tool'='execute' LIMIT 1"
```

**期望**：execute 工具注册存在；description 含 `tools.echo` 命名空间。

---

## 三、基础编排：单工具调用

### T50.6 execute 调用单个 MCP 工具

让 AI 使用 execute 编排一次 echo 工具调用：

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具调用 tools.echo.echo 传入 message=\\\"hello code-mode\\\"，只返回 echo 的响应文本\"}],\"model\":$MODEL}"
```

**期望**：
- AI 调用 `execute` 工具，code 参数为类似 `return await tools.echo.echo({message: "hello code-mode"})` 的脚本
- 执行成功，AI 返回包含 `hello code-mode` 的文本

### T50.7 PG 验证 toolCalls 元数据

```bash
psql "$PG_URL" -t -A -c "
  SELECT data->'state'->'metadata'->'toolCalls'
  FROM part
  WHERE session_id='$SID' AND data->>'tool'='execute'
  ORDER BY time_created DESC LIMIT 1
" | jq .
```

**期望**：`toolCalls` 数组包含一条 `{tool: "echo_echo", status: "completed"}` 记录。

---

## 四、顺序依赖编排

### T50.8 多步顺序调用

让 AI 在一个 execute 脚本内完成有依赖的多步调用：

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 完成：1) 调用 tools.echo.echo 传 message=\\\"step1\\\" 2) 用上一步的结果作为 message 再调一次 tools.echo.echo 3) 返回最终结果\"}],\"model\":$MODEL}"
```

**期望**：
- execute 执行成功
- toolCalls 有 2 条记录（均为 completed）
- AI 返回包含 `step1` 的结果

### T50.9 PG 验证子工具调用顺序

```bash
psql "$PG_URL" -t -A -c "
  SELECT data->'state'->'metadata'->'toolCalls'::text
  FROM part WHERE session_id='$SID' AND data->>'tool'='execute'
  ORDER BY time_created DESC LIMIT 1
" | jq '. | length'
```

**期望**：2（两次子工具调用）。

---

## 五、并发编排

### T50.10 Promise.all 并发调用

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 并发调用 tools.echo.echo 3 次，分别传 message=\\\"a\\\"、\\\"b\\\"、\\\"c\\\"，用 Promise.all，返回所有结果拼接\"}],\"model\":$MODEL}"
```

**期望**：
- execute 执行成功
- toolCalls 有 3 条记录
- AI 返回包含 a、b、c 的结果

### T50.11 验证并发执行（时间戳接近）

```bash
psql "$PG_URL" -t -A -c "
  SELECT jsonb_array_length(data->'state'->'metadata'->'toolCalls')
  FROM part WHERE session_id='$SID' AND data->>'tool'='execute'
  ORDER BY time_created DESC LIMIT 1
"
```

**期望**：3。

---

## 六、错误处理

### T50.12 子工具错误捕获

让 execute 脚本调用一个会失败的 MCP 工具或传入非法参数：

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用 tools.echo.echo 传入一个不存在的参数名 invalid_param=true，用 try/catch 捕获错误并返回错误消息\"}],\"model\":$MODEL}"
```

**期望**：
- execute 执行成功（脚本本身不崩溃）
- toolCalls 中对应调用 status 为 `error`
- AI 返回错误描述文本

### T50.13 脚本语法错误

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行以下代码：这是一个语法错误代码 this is not valid javascript {{{\"}],\"model\":$MODEL}"
```

**期望**：
- execute 返回 error metadata
- AI 提示代码有语法错误

### T50.14 PG 验证 error 标记

```bash
psql "$PG_URL" -t -A -c "
  SELECT data->'state'->'metadata'->>'error'
  FROM part WHERE session_id='$SID' AND data->>'tool'='execute'
  ORDER BY time_created DESC LIMIT 1
"
```

**期望**：`true`（最近一次 execute 因语法错误失败）。

---

## 七、沙箱限制

### T50.15 禁止 eval / Function 构造器

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行代码：eval(\\\"1+1\\\")，告诉我结果\"}],\"model\":$MODEL}"
```

**期望**：
- execute 执行失败（eval 不可用）
- AI 提示 eval 不被支持

### T50.16 禁止 require / process / fs

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行代码：const fs = require(\\\"fs\\\"); return fs.readFileSync(\\\"/etc/passwd\\\")\"}],\"model\":$MODEL}"
```

**期望**：
- execute 执行失败
- AI 提示 require 不可用

### T50.17 内置 stdlib 可用

验证受限解释器支持标准库操作：

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行代码：const arr = [3,1,2]; return JSON.stringify({sorted: arr.sort(), len: arr.length, max: Math.max(...arr), upper: \\\"hello\\\".toUpperCase()})\"}],\"model\":$MODEL}"
```

**期望**：
- execute 执行成功
- AI 返回 `{"sorted":[1,2,3],"len":3,"max":3,"upper":"HELLO"}`

---

## 八、权限过滤

### T50.18 deny 规则隐藏工具

设置权限规则拒绝某个 MCP 工具，验证它在 execute 的工具目录中不可见：

```bash
# 添加 deny 规则
curl -s -X POST "$BASE/session/$SID/permission" -H 'Content-Type: application/json' \
  -d '{"rules":[{"tool":"echo_echo","permission":"deny"}]}'

# AI 尝试使用被隐藏的工具
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用 tools.echo.echo 传 message=\\\"test\\\"\"}],\"model\":$MODEL}"
```

**期望**：
- echo 工具不在 execute 的工具目录中（`tools.echo` 命名空间不存在）
- AI 无法调用，提示工具不可用或目录为空

### T50.19 清除 deny 后恢复

```bash
# 清除权限规则
curl -s -X PUT "$BASE/session/$SID/permission" -H 'Content-Type: application/json' \
  -d '{"rules":[]}'

curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用 tools.echo.echo 传 message=\\\"restored\\\"\"}],\"model\":$MODEL}"
```

**期望**：echo 工具恢复可见，调用成功。

---

## 九、附件处理

### T50.20 工具返回图片内容

注册一个返回图片的 MCP 工具（或用 echo 工具返回 image content），验证 execute 收集附件：

```bash
# 注册一个返回 base64 图片的 MCP（或用现有 server）
# 如果没有合适的 server，此用例标记为 SKIP

curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用返回图片的 MCP 工具，告诉我图片是否成功返回\"}],\"model\":$MODEL}"
```

**期望**：execute 收集 image/resource 内容为 file 附件；AI 确认收到。

---

## 十、中止与超时

### T50.21 用户中止

```bash
# 发起 execute（脚本内做多次调用以延长执行时间）
MSG_ID=$(curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 循环调用 tools.echo.echo 10 次，每次 message 不同\"}],\"model\":$MODEL}" | jq -r '.data.message_id')

sleep 2

# 中止
curl -s -X POST "$BASE/session/$SID/message/$MSG_ID/cancel"
```

**期望**：execute 返回 `error: true`；AI 提示被中止。

### T50.22 中止后状态验证

```bash
psql "$PG_URL" -t -A -c "
  SELECT data->'state'->>'status'
  FROM part WHERE session_id='$SID' AND data->>'tool'='execute'
  ORDER BY time_created DESC LIMIT 1
"
```

**期望**：`error` 或 `aborted`。

---

## 十一、工具目录搜索

### T50.23 $codemode.search 搜索工具

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行代码：const result = await tools.\\$codemode.search(\\\"echo\\\"); return JSON.stringify(result)\"}],\"model\":$MODEL}"
```

**期望**：返回包含 `echo.echo` 工具的搜索结果。

### T50.24 $codemode.search 空查询列举全部

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行代码：const result = await tools.\\$codemode.search(\\\"\\\"); return JSON.stringify(Object.keys(result))\"}],\"model\":$MODEL}"
```

**期望**：返回所有命名空间（至少包含 `echo`）。

---

## 十二、输出大小限制

### T50.25 大输出截断

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行代码：return \\\"x\\\".repeat(100000)，告诉我返回了多少字符\"}],\"model\":$MODEL}"
```

**期望**：输出被截断至 maxOutputBytes 限制；AI 提示输出被截断。

---

## 十三、并发限制

### T50.26 超过 8 并发工具调用

```bash
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 并发调用 tools.echo.echo 12 次（Promise.all），每次传不同 message，返回成功的数量\"}],\"model\":$MODEL}"
```

**期望**：
- execute 执行成功（最多 8 并发，其余排队）
- toolCalls 有 12 条记录
- 所有调用最终完成

---

## 十四、清理

### T50.27 删除 MCP 并验证 execute 消失

```bash
curl -s -X DELETE "$BASE/session/$SID/mcps/echo"

sleep 3

# 验证 execute 不再出现（无 MCP 工具时不应注册）
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"列出你当前可用的所有工具\"}],\"model\":$MODEL}"
```

**期望**：AI 工具列表中不再包含 `execute`（因无 MCP 工具可编排）。

---

## 测试矩阵

| 编号 | 分类 | 场景 | 关键验证点 |
|------|------|------|-----------|
| T50.1 | 准备 | 创建 session | 沙箱就绪 |
| T50.2 | 准备 | 注册 MCP | PG 持久化 |
| T50.3 | 准备 | MCP 连接 | status=connected |
| T50.4 | 发现 | AI 感知 execute | 工具列表含 execute |
| T50.5 | 发现 | 目录生成 | description 含工具树 |
| T50.6 | 基础 | 单工具调用 | echo 返回正确 |
| T50.7 | 基础 | toolCalls 元数据 | PG 有调用记录 |
| T50.8 | 顺序 | 多步依赖调用 | 2 次顺序调用 |
| T50.9 | 顺序 | 调用顺序验证 | toolCalls.length=2 |
| T50.10 | 并发 | Promise.all | 3 并发调用 |
| T50.11 | 并发 | 并发数验证 | toolCalls=3 |
| T50.12 | 错误 | 子工具错误捕获 | status=error |
| T50.13 | 错误 | 语法错误 | error=true |
| T50.14 | 错误 | PG error 标记 | metadata.error=true |
| T50.15 | 沙箱 | 禁止 eval | 执行失败 |
| T50.16 | 沙箱 | 禁止 require | 执行失败 |
| T50.17 | 沙箱 | stdlib 可用 | sort/Math/JSON 正常 |
| T50.18 | 权限 | deny 隐藏工具 | 工具不可见 |
| T50.19 | 权限 | 恢复后可见 | 调用成功 |
| T50.20 | 附件 | 图片内容 | SKIP（需图片 MCP） |
| T50.21 | 中止 | 用户取消 | error=true |
| T50.22 | 中止 | 状态验证 | status=error |
| T50.23 | 搜索 | $codemode.search | 返回搜索结果 |
| T50.24 | 搜索 | 空查询列举 | 返回所有命名空间 |
| T50.25 | 限制 | 大输出截断 | 输出被截断 |
| T50.26 | 限制 | 超并发排队 | 12 调用全部完成 |
| T50.27 | 清理 | 删除 MCP | execute 消失 |
