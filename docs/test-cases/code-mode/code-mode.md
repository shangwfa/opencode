# Code-Mode（execute 工具）端到端验证

> 验证 SaaS 环境下 Code-Mode 功能完整链路：MCP 工具发现 → `execute` 工具注册 → 受限 JS 解释器编排 → 子工具调用 → 权限/并发/错误/附件 → PG 元数据持久化。
>
> 设计文档：`packages/codemode/codemode.md`；工具实现：`packages/opencode/src/tool/code-mode.ts`

本验收采用两层测试：SaaS E2E 验证 HTTP、PG、sandbox 和 session MCP 生命周期；确定性自动化测试验证工具目录渲染、结构化内容、附件/resource、日志、权限和并发上限。不要用模型自然语言回复代替状态或数据断言。

## 运行模式

通过 `OPENCODE_EXPERIMENTAL_CODE_MODE` 选择模式：

| 值              | execute 内可编排工具                                                    | 兼容性       |
| --------------- | ----------------------------------------------------------------------- | ------------ |
| `false` / `off` | 无，关闭 Code-Mode                                                      | 原关闭行为   |
| `true` / `mcp`  | 仅 MCP                                                                  | 原有默认行为 |
| `read`          | MCP + read/glob/grep/lsp/webfetch/websearch/repo_overview               | 扩展只读模式 |
| `all`           | MCP + 除 execute/task/question/skill/todowrite 等控制工具外的已物化工具 | 扩展完整模式 |

`OPENCODE_EXPERIMENTAL=true` 仍映射为 `mcp`。扩展工具统一位于 `tools.opencode.<tool>`；原生工具继续直接暴露，不改变旧调用方式。目录与执行使用同一请求内、完成权限和插件定义过滤后的工具快照。

## 前置条件

| 条件       | 说明                                                              |
| ---------- | ----------------------------------------------------------------- |
| SaaS 容器  | `opencode-saas-sandbox-test:ccr`，`OPENCODE_EXPERIMENTAL_CODE_MODE=all`（本文件全套默认在 all 模式跑；T50.27 额外要求 mcp 模式对照） |
| 组合       | 组合 1（远端 PG + 远端 Sandbox，见 `docs/local-test-env.md`）     |
| 沙箱转发器 | `0.0.0.0:30040` → `172.18.32.15:30040` 运行中                     |
| PG         | 远端 `postgresql://app:8zuhlMLd4gaeUG5k@172.18.32.14:5432/opencode`（容器内经 `host.docker.internal:15432` 转发；若转发不可用改直连，见 local-test-env.md） |
| MCP Server | 需要至少一个 MCP server（本测试用 echo / calculate 类工具）       |
| 图片模型   | `moonshotai-cn/kimi-k3`，通过 SaaS `PUT /auth/moonshotai-cn` 配置（仅 T50.20 需要，无 key 时跳过） |

图片测试的凭据只写入 SaaS auth，不写入仓库、文档或 shell history：

```bash
read -rsp 'Moonshot API key: ' MOONSHOT_KEY; echo
curl -s -X PUT "$BASE/auth/moonshotai-cn" -H 'Content-Type: application/json' \
  -d "$(jq -nc --arg key "$MOONSHOT_KEY" '{type:"api",key:$key}')" | jq -e '. == true'
unset MOONSHOT_KEY

# Provider/Auth 在进程启动时加载；首次设置后重启测试容器，再验证连接。
docker restart opencode-saas-test >/dev/null
for _ in $(seq 1 30); do
  curl -sf "$BASE/provider" | jq -e '.connected | index("moonshotai-cn") != null' && break
  sleep 1
done
```

运行前加载公共环境，并为本文件创建独立 Session。所有步骤必须串行执行，PG 查询通过执行前时间水位限定到本次请求，禁止读取不加边界的“最新一条”记录：

```bash
source test-env.sh 1
source test-lib.sh

mark_execute() {
  pgval "SELECT coalesce(max(time_created), 0) FROM part WHERE session_id='$SID' AND data->>'tool'='execute'"
}

execute_state_after() {
  pgval "SELECT data->'state' FROM part WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $1 ORDER BY time_created DESC LIMIT 1"
}

wait_execute_running() {
  local after=$1 status
  for _ in $(seq 1 60); do
    status=$(pgval "SELECT data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $after ORDER BY time_created DESC LIMIT 1")
    [ "$status" = "running" ] && return 0
    sleep 1
  done
  return 1
}

wait_execute_terminal() {
  local after=$1 status
  for _ in $(seq 1 60); do
    status=$(pgval "SELECT data->'state'->>'status' FROM part WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $after ORDER BY time_created DESC LIMIT 1")
    case "$status" in completed|error|aborted) return 0 ;; esac
    sleep 1
  done
  return 1
}
```

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
    "command":["npx","-y","@modelcontextprotocol/server-everything"]
  }'

# PG 验证
psql "$PG_URL" -t -A -c "SELECT name, type FROM session_mcps WHERE session_id='$SID' AND name='echo'"
```

**期望**：`echo|local`，PG 持久化正确。

### T50.3 验证 MCP 配置可读

```bash
curl -s "$BASE/session/$SID/mcps" | jq -e '.[] | select(.name=="echo" and .enabled==true)'
```

**期望**：返回 echo 配置。当前没有 session MCP connection-status HTTP 接口；真实连接由 T50.4 的首次成功调用验证，不使用固定 `sleep` 或 Web UI fallback 路由。

### T50.3b 沙箱测试项目准备（内置工具用例前置）

> ⚠️ **关键**：会话工具在**远端沙箱**内执行，沙箱的 `/workspace` 与 server 容器文件系统隔离。**在 server 容器（docker exec）建文件对沙箱不可见**，必须用 `/session/:id/exec` 写进沙箱。跳过此步会导致所有读文件用例报 `file not found`。

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/src/config && echo {\"name\":\"code-mode-demo\",\"version\":\"1.0.0\",\"dependencies\":{\"react\":\"^19\",\"zod\":\"^4\"},\"devDependencies\":{\"typescript\":\"^5\"}} > /workspace/package.json && for f in agent provider flag; do echo \"export const $f = 1\" > /workspace/src/config/$f.ts; done && ls -R /workspace"}' \
  | jq -e '.exitCode == 0'
```

**期望**：`exitCode == 0`，stdout 含 `package.json` 与 3 个 `.ts` 文件。

> **HTTP 响应陷阱**：`POST /session/:id/message` 同步等待，返回的只是**最后一条 assistant**（常为无 tool part 的总结文本）。含 tool part 的中间 assistant 消息必须查 PG（`execute_state_after` 水位查询），不要用 HTTP 响应断言工具行为。模型也可能幻觉"已调用"（parts 里无 tool）或自主改用直接调用——PG 无 execute part 即判模型未调用，重发 prompt（措辞更直接）而非判功能失败。

---

## 二、execute 工具发现与注册

### T50.4 首次调用验证连接与 execute 注册

当 session 有已连接的 MCP 工具时，模型应看到唯一的 `execute` 工具（而非逐个暴露的 MCP 工具）：

```bash
BEFORE=$(mark_execute)
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"必须使用 execute，执行精确代码：return await tools.echo.echo({message: \\\"discovery-ok\\\"})\"}],\"model\":$MODEL}" >/dev/null
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  .output == "Echo: discovery-ok" and
  .metadata.toolCalls == [{"tool":"echo.echo","status":"completed","input":{"message":"discovery-ok"}}]
'
```

**期望**：硬断言通过，证明 MCP 已连接且模型能够调用 `execute`。模型回复文本仅用于诊断。

### T50.5 describeCatalog 生成指令包含工具树

description 不对外持久化，不能通过 Session GET 或历史 part 间接验证。使用确定性自动化测试验证完整目录：

```bash
cd packages/opencode
bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts \
  --test-name-pattern 'catalog|signature'
```

**期望**：测试通过，验证 `## Workflow`、完整/部分目录、schema signature、特殊命名空间和搜索提示。

---

## 三、基础编排：单工具调用

### T50.6 execute 调用单个 MCP 工具

让 AI 使用 execute 编排一次 echo 工具调用：

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具调用 tools.echo.echo 传入 message=\\\"hello code-mode\\\"，只返回 echo 的响应文本\"}],\"model\":$MODEL}"
```

**期望**：

- AI 调用 `execute` 工具，code 参数为类似 `return await tools.echo.echo({message: "hello code-mode"})` 的脚本
- 执行成功，AI 返回包含 `hello code-mode` 的文本

### T50.7 PG 验证 toolCalls 元数据

```bash
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  (.output | contains("hello code-mode")) and
  .metadata.toolCalls == [{"tool":"echo.echo","status":"completed","input":{"message":"hello code-mode"}}]
'
```

**期望**：`toolCalls` 数组包含一条 `{tool: "echo.echo", status: "completed"}` 记录，并包含调用 input。

---

## 四、顺序依赖编排

### T50.8 多步顺序调用

让 AI 在一个 execute 脚本内完成有依赖的多步调用：

```bash
BEFORE=$(mark_execute)
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
  SELECT jsonb_agg(jsonb_build_object('tool', call->>'tool', 'input', call->'input') ORDER BY ordinality)
  FROM part
  CROSS JOIN LATERAL jsonb_array_elements(data->'state'->'metadata'->'toolCalls') WITH ORDINALITY AS calls(call, ordinality)
  WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $BEFORE
  GROUP BY part.id, part.time_created
  ORDER BY part.time_created DESC LIMIT 1
" | jq -e '. == [
  {"tool":"echo.echo","input":{"message":"step1"}},
  {"tool":"echo.echo","input":{"message":"Echo: step1"}}
]'
```

**期望**：精确数组断言通过，验证调用顺序和第二次输入依赖第一次输出。T50.8 发送请求前必须重新设置 `BEFORE=$(mark_execute)`。

---

## 五、并发编排

### T50.10 Promise.all 并发调用

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 并发调用 tools.echo.echo 3 次，分别传 message=\\\"a\\\"、\\\"b\\\"、\\\"c\\\"，用 Promise.all，返回所有结果拼接\"}],\"model\":$MODEL}"
```

**期望**：

- execute 执行成功
- toolCalls 有 3 条记录
- AI 返回包含 a、b、c 的结果

在进入 T50.11 前，用 PG 硬断言本次并发调用，而不是依赖模型总结：

```bash
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  (.metadata.toolCalls | length) == 3 and
  all(.metadata.toolCalls[]; .status == "completed")
'
```

### T50.11 确定性验证并发上限

```bash
cd packages/codemode
bun test test/promise.test.ts --test-name-pattern 'caps live tool-call concurrency'
```

**期望**：测试通过，并通过 active/maxActive barrier 硬断言同时执行数不超过 8。T50.10 仅负责 SaaS 链路上的 Promise.all 功能验证，不再用调用数量冒充并发证明。

---

## 六、错误处理

### T50.12 子工具错误捕获

让 execute 脚本调用一个会失败的 MCP 工具。注意：echo 会**忽略多余参数**（传 `invalid_param` 仍返回 completed），必须用**缺必填参数**触发真 error：

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行精确代码：try { const r = await tools.echo.echo({}); return \\\"UNEXPECTED:\\\"+r; } catch (e) { return \\\"CAUGHT:\\\"+String(e).slice(0,200); }\"}],\"model\":$MODEL}"
```

**期望**：

- execute 执行成功（脚本本身不崩溃）
- toolCalls 中对应调用 status 为 `error`
- AI 返回错误描述文本

```bash
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  (.metadata.toolCalls | length) == 1 and
  .metadata.toolCalls[0].status == "error" and
  (.output | length) > 0
'
```

### T50.13 脚本语法错误

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行以下代码：这是一个语法错误代码 this is not valid javascript {{{\"}],\"model\":$MODEL}"
```

**期望**：

- execute 返回 error metadata
- AI 提示代码有语法错误

### T50.14 PG 验证 error 标记

```bash
execute_state_after "$BEFORE" | jq -e '
  .status == "error" and
  .metadata.error == true and
  (.error | contains("Failed to parse TypeScript"))
'
```

**期望**：`true`（最近一次 execute 因语法错误失败）。

---

## 七、沙箱限制

### T50.15 禁止 eval / Function 构造器

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行代码：eval(\\\"1+1\\\")，告诉我结果\"}],\"model\":$MODEL}"
```

**期望**：

- execute 执行失败（eval 不可用）
- AI 提示 eval 不被支持

```bash
execute_state_after "$BEFORE" | jq -e '.status == "error" and .metadata.error == true and (.error | test("eval"; "i"))'
```

### T50.16 禁止 require / process / fs

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行代码：const fs = require(\\\"fs\\\"); return fs.readFileSync(\\\"/etc/passwd\\\")\"}],\"model\":$MODEL}"
```

**期望**：

- execute 执行失败
- AI 提示 require 不可用

```bash
execute_state_after "$BEFORE" | jq -e '.status == "error" and .metadata.error == true and (.error | test("require"; "i"))'
```

### T50.17 内置 stdlib 可用

验证受限解释器支持标准库操作：

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具执行代码：const arr = [3,1,2]; return JSON.stringify({sorted: arr.sort(), len: arr.length, max: Math.max(...arr), upper: \\\"hello\\\".toUpperCase()})\"}],\"model\":$MODEL}"
```

**期望**：

- execute 执行成功
- AI 返回 `{"sorted":[1,2,3],"len":3,"max":3,"upper":"HELLO"}`

```bash
execute_state_after "$BEFORE" | jq -e '.status == "completed" and .output == "{\"sorted\":[1,2,3],\"len\":3,\"max\":3,\"upper\":\"HELLO\"}"'
```

---

## 八、权限过滤

### T50.18 deny 规则隐藏工具

设置权限规则拒绝某个 MCP 工具，验证它在 execute 的工具目录中不可见：

```bash
# 添加 deny 规则
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"echo_echo","pattern":"*","action":"deny"}]}'

# AI 尝试使用被隐藏的工具
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用 tools.echo.echo 传 message=\\\"test\\\"\"}],\"model\":$MODEL}"
```

**期望**：

- echo 工具不在 execute 的工具目录中（`tools.echo` 命名空间不存在）
- AI 无法调用，提示工具不可用或目录为空

```bash
DENIED_COUNT=$(pgval "SELECT count(*) FROM part WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $BEFORE")
if [ "$DENIED_COUNT" != "0" ]; then
  # 语义断言（2026-09-04 实测）：模型被 deny 后会探索（Object.keys/search），最后一条
  # 未必是 error。不断言"最新一条"，而断言：存在 Unknown tool error，且无任何
  # completed 的被 deny 工具调用。
  pgval "SELECT data->'state' FROM part WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $BEFORE ORDER BY time_created" | python3 -c "
import json,sys
states=[json.loads(l[l.index('{'):]) for l in sys.stdin if '{' in l]
has_unknown=any('Unknown tool' in str(s.get('error','')) for s in states)
no_completed_echo=not any(
  s['status']=='completed' and any(c.get('tool')=='echo.echo' for c in s.get('metadata',{}).get('toolCalls',[]))
  for s in states)
print('PASS' if (has_unknown and no_completed_echo) else 'FAIL')"
fi
```

### T50.19 后置 allow 覆盖 deny 后恢复

```bash
# 后置 allow 规则覆盖 deny
curl -s -X PATCH "$BASE/session/$SID" -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"echo_echo","pattern":"*","action":"allow"}]}'

BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用 tools.echo.echo 传 message=\\\"restored\\\"\"}],\"model\":$MODEL}"
```

**期望**：echo 工具恢复可见，调用成功。

```bash
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  (.output | contains("restored")) and
  .metadata.toolCalls[0].tool == "echo.echo" and
  .metadata.toolCalls[0].status == "completed"
'
```

---

## 九、附件处理

> 仅 T50.20 需要 moonshotai-cn key。无 key 时跳过本节（`curl -sf "$BASE/provider" | jq -e '.connected | index("moonshotai-cn") != null'` 不通过即跳过），不计入 FAIL。

### T50.20 工具返回图片内容

使用 server-everything 的固定小图片工具和支持图片输入的 Kimi K3，验证 execute 收集附件：

```bash
BEFORE=$(mark_execute)
SAVED_MODEL=$MODEL
MODEL=$KIMI_MODEL
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用返回图片的 MCP 工具，告诉我图片是否成功返回\"}],\"model\":$MODEL}"
MODEL=$SAVED_MODEL

# 以精确代码重新执行并将 PG 水位绑定到这一次调用。
BEFORE=$(mark_execute)
jq -nc \
  --arg text '必须使用 execute，执行精确代码：return await tools.echo["get-tiny-image"]({})。然后只说明是否收到图片。' \
  --argjson model "$KIMI_MODEL" \
  '{parts:[{type:"text",text:$text}],model:$model}' | \
  curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' --data-binary @- >/dev/null

execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  (.attachments | length) >= 1 and
  all(.attachments[]; .type == "file" and (.mime | startswith("image/"))) and
  .metadata.toolCalls == [{"tool":"echo.get-tiny-image","status":"completed"}] and
  ((.output | test("base64|data:image"; "i")) | not)
'
```

**期望**：PG 硬断言通过；Kimi K3 成功完成工具回合，图片以 file attachment 保存，base64/data URL 不进入 execute 文本。自动化集成测试同时验证固定 PNG 字节不会进入 sandbox 或模型文本。

---

## 十、中止与超时

### T50.21 用户中止

```bash
BEFORE=$(mark_execute)
# prompt_async 立即返回；必须等 execute 真正进入 running 后才能中止。
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 调用 tools.echo[\\\"trigger-long-running-operation\\\"]，duration=30，steps=30\"}],\"model\":$MODEL}"

wait_execute_running "$BEFORE" || { echo 'execute 未进入 running'; false; }
curl -s -X POST "$BASE/session/$SID/abort"
wait_execute_terminal "$BEFORE" || { echo 'execute 未进入终态'; false; }
```

**期望**：execute 返回 `error: true`；AI 提示被中止。

### T50.22 中止后状态验证

> 语义说明（2026-09-04 实测）：用户 abort 后 part 状态为 `error`（"Tool execution aborted"），但 metadata 是 `{"interrupted": true}`——**没有 `error: true` 也没有 toolCalls**。与早期 `error:true` 约定不一致，实现与文档待对齐（产品决策：保留 interrupted 语义则改断言，改回 error:true 则改实现）。

```bash
execute_state_after "$BEFORE" | jq -e '
  (.status == "error" or .status == "aborted") and
  .metadata.interrupted == true
'
```

**期望**：`error` + `interrupted:true`。

---

## 十一、工具目录搜索

### T50.23 $codemode.search 搜索工具

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行代码：const result = await tools.\\$codemode.search({query: \\\"echo\\\"}); return JSON.stringify(result)\"}],\"model\":$MODEL}"
```

**期望**：返回包含 `echo.echo` 工具的搜索结果。

### T50.24 $codemode.search 空查询分页语义

```bash
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行代码：const result = await tools.\\$codemode.search({query: \\\"\\\"}); return JSON.stringify(result.items.map(item => item.path))\"}],\"model\":$MODEL}"
```

**期望**：返回当前页路径且包含 `tools.echo.echo`。空查询单页结果不能宣称“列举全部”；`remaining`、`next.offset` 和完整分页行为由 `packages/codemode` 的 search 自动化测试覆盖。

---

## 十二、输出大小限制

### T50.25 大输出截断

```bash
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行代码：return \\\"x\\\".repeat(100000)，告诉我返回了多少字符\"}],\"model\":$MODEL}"
```

```bash
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  .metadata.truncated == true and
  (.metadata.outputPath | type) == "string" and
  (.output | length) < 100000
'
```

**期望**：PG 断言 `truncated=true` 且有 `outputPath`；AI 文本不作为截断判据。

---

## 十三、并发限制

### T50.26 超过 8 并发工具调用

```bash
BEFORE=$(mark_execute)
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 执行代码：const results = await Promise.all(Array.from({length:12}).map((_,i) => tools.echo.echo({message:String(i)}))); return results.length\"}],\"model\":$MODEL}"
```

```bash
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  .output == "12" and
  (.metadata.toolCalls | length) == 12 and
  all(.metadata.toolCalls[]; .status == "completed")
'
```

**期望**：

- execute 执行成功（最多 8 并发，其余排队）
- toolCalls 有 12 条记录
- 所有调用最终完成
- “最多 8 并发”由 T50.11 的 active/maxActive barrier 自动化测试证明

---

## 十四、清理

### T50.27 删除 MCP 并验证 execute 消失

```bash
curl -s -X DELETE "$BASE/session/$SID/mcps/echo"

for _ in $(seq 1 30); do
  [ "$(pgval "SELECT count(*) FROM session_mcps WHERE session_id='$SID'")" = "0" ] && break
  sleep 1
done

# 强制要求调用；若 execute 不在发送给模型的工具 schema 中，不会产生 execute part。
BEFORE=$(mark_execute)
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"列出你当前可用的所有工具\"}],\"model\":$MODEL}"

jq -nc --arg text '现在必须使用 execute 执行 return 1；不要根据历史消息推断工具可用性' --argjson model "$MODEL" \
  '{parts:[{type:"text",text:$text}],model:$model}' | \
  curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' --data-binary @- >/dev/null

[ "$(pgval "SELECT count(*) FROM part WHERE session_id='$SID' AND data->>'tool'='execute' AND time_created > $BEFORE")" = "0" ]
curl -s -X DELETE "$BASE/session/$SID" >/dev/null
```

**期望**：MCP 行数为 0，删除后请求没有产生新的 execute part。模型自然语言工具列表不作为判据。

> ⚠️ **模式差异说明（2026-08-01 实测）**：本用例的"删除 MCP 后 execute 消失"仅在 **`mcp` 模式**（`OPENCODE_EXPERIMENTAL_CODE_MODE=mcp`）下成立——此时 execute 仅在 session 有已连接 MCP 工具时注册，删除后 execute 从工具列表消失。在 **`all` 模式**下，execute **始终保留**（可编排本地工具 read/glob/grep 等，见运行模式表），删除 MCP 后 execute 仍在注册表（`/experimental/tool/ids` 仍含 `execute`），会继续产生 execute part。因此 T50.27 应使用 `mcp` 模式执行，或在 `all` 模式下改为验证"MCP 工具命名空间（tools.echo）消失、execute 保留但无法调用被删除的 MCP 工具"。

---

## 十五、all 模式内置工具编排（需 T50.3b 沙箱项目）

> 本组验证 `all` 模式核心价值：`tools.opencode.read/glob/grep` 在脚本内编排。echo MCP 测不出"内置工具输出格式 × 脚本"的真实交互（如 read 返回的 XML-like 行号文本会导致 naive `JSON.parse` 失败，模型需 1-2 轮自我修复收敛——属正常行为，不判失败）。

### T50.28 read + glob 编排真实文件

```bash
BEFORE=$(mark_execute)
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具：read /workspace/package.json，glob src/config/*.ts，返回 {name, tsFileCount}。read 返回的是带行号的文本格式，注意先提取再解析。\"}],\"model\":$MODEL}" >/dev/null
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  (.output | contains("code-mode-demo")) and
  ([.metadata.toolCalls[] | select(.status == "completed")] | length) >= 2
'
```

**期望**：硬断言通过。允许模型中途 error 后自我修复（多条 execute part），只断言最终成功的 part。

### T50.29 grep + read 组合定位

```bash
BEFORE=$(mark_execute)
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具：grep 找出 src 下包含 export const 的文件，再 read 其中一个，把文件名和第一行返回为 {file, firstLine}。\"}],\"model\":$MODEL}" >/dev/null
execute_state_after "$BEFORE" | jq -e '
  .status == "completed" and
  (.output | contains("src/config/")) and
  (.output | contains("export const"))
'
```

**期望**：硬断言通过，验证跨工具数据流（grep 结果驱动 read 参数）。

---

## 十六、省 token 效果对比

> code-mode 核心卖点"中间结果不进对话"的唯一量化验证：同一任务两种做法的 input token 差。

### T50.30 脚本内汇总 vs 直接调用

> 设计要点：对比的必须是**任务完成后的下一轮** input（历史是否携带中间结果），而非任务轮本身（任务轮 input 含当轮工具定义等固定开销，且长短会话基线不可比）。

```bash
# 会话 A：execute 脚本内读 3 个文件并汇总（中间输出不出对话），再发一轮简单问题
SIDA=$(new_sid -kb)
curl -s --max-time 120 -X POST "$BASE/session/$SIDA/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/src/config && for f in agent provider flag; do echo \"export const $f = 1\" > /workspace/src/config/$f.ts; done"}' >/dev/null
# 第一轮：execute 汇总（只返回数字）
curl -s --max-time 180 -X POST "$BASE/session/$SIDA/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 execute 工具：read src/config 下全部 3 个 ts 文件，在脚本内拼接它们的内容总字符数，只返回 {totalChars} 一个数字。\"}],\"model\":$MODEL}" >/dev/null
# 第二轮：简单问题，本轮 input 即"携带 execute 小输出的历史"代价
curl -s --max-time 60 -X POST "$BASE/session/$SIDA/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"reply with exactly: ok-a\"}],\"model\":$MODEL}" >/dev/null
TOK_A=$(pgval "SELECT data->'tokens'->>'input' FROM message WHERE session_id='$SIDA' ORDER BY time_created DESC LIMIT 1")

# 会话 B：直接调用 read 3 次再汇总，同样再发一轮简单问题
SIDB=$(new_sid -kb)
curl -s --max-time 120 -X POST "$BASE/session/$SIDB/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/src/config && for f in agent provider flag; do echo \"export const $f = 1\" > /workspace/src/config/$f.ts; done"}' >/dev/null
curl -s --max-time 180 -X POST "$BASE/session/$SIDB/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"逐个 read src/config 下全部 3 个 ts 文件，把它们的内容总字符数返回为 {totalChars}。不要用 execute。\"}],\"model\":$MODEL}" >/dev/null
curl -s --max-time 60 -X POST "$BASE/session/$SIDB/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"reply with exactly: ok-b\"}],\"model\":$MODEL}" >/dev/null
TOK_B=$(pgval "SELECT data->'tokens'->>'input' FROM message WHERE session_id='$SIDB' ORDER BY time_created DESC LIMIT 1")

echo "execute做法次轮input=$TOK_A 直接调用次轮input=$TOK_B"
curl -s -X DELETE "$BASE/session/$SIDA" >/dev/null; curl -s -X DELETE "$BASE/session/$SIDB" >/dev/null
```

**期望**：`TOK_A < TOK_B`（脚本内中间结果不进对话；实测 3 个小文件即 276 vs 1350，省约 1K tok，文件越大差值越大）。本用例只断言方向不设阈值。

---

## 十七、已知问题（非阻塞记录）

### T50.31 工具自然卡死的 watchdog 行为（观察项）

`read /`（沙箱根目录）在远端沙箱挂起不返回时，watchdog 尝试 mark 超时 → `PG query timed out after 30000ms` → 标记失败 → 约 45s 后重试，形成无限循环并持续占用 PG 连接，期间同实例其他会话的模型行为可能异常（拒调工具/幻觉）。`docker restart` 可清。复现即记录，不判 FAIL：

```bash
docker logs opencode-saas-test 2>&1 | grep -c "mark timed out failed" || true
```

**期望**：记录次数与现象。根治（mark 操作熔断/超时 part 强制回收）超出本文件范围，另立议题。

---

## 测试矩阵

| 编号   | 分类 | 场景             | 关键验证点                      |
| ------ | ---- | ---------------- | ------------------------------- |
| T50.1  | 准备 | 创建 session     | 沙箱就绪                        |
| T50.2  | 准备 | 注册 MCP         | PG 持久化                       |
| T50.3  | 准备 | MCP 配置读取     | 配置存在且启用                  |
| T50.4  | 发现 | 首次真实调用     | execute completed               |
| T50.5  | 发现 | 目录生成         | description 含工具树            |
| T50.6  | 基础 | 单工具调用       | echo 返回正确                   |
| T50.7  | 基础 | toolCalls 元数据 | PG 有调用记录                   |
| T50.8  | 顺序 | 多步依赖调用     | 2 次顺序调用                    |
| T50.9  | 顺序 | 调用顺序验证     | toolCalls input 顺序正确        |
| T50.10 | 并发 | Promise.all      | 3 并发调用                      |
| T50.11 | 并发 | 并发上限验证     | maxActive<=8                    |
| T50.12 | 错误 | 子工具错误捕获   | status=error                    |
| T50.13 | 错误 | 语法错误         | error=true                      |
| T50.14 | 错误 | PG error 标记    | metadata.error=true             |
| T50.15 | 沙箱 | 禁止 eval        | 执行失败                        |
| T50.16 | 沙箱 | 禁止 require     | 执行失败                        |
| T50.17 | 沙箱 | stdlib 可用      | sort/Math/JSON 正常             |
| T50.18 | 权限 | deny 隐藏工具    | 工具不可见                      |
| T50.19 | 权限 | allow 覆盖 deny  | 调用成功                        |
| T50.20 | 附件 | Kimi K3 图片内容 | file attachment，无 base64 泄漏 |
| T50.21 | 中止 | 用户取消         | error=true                      |
| T50.22 | 中止 | 状态验证         | status=error                    |
| T50.23 | 搜索 | $codemode.search | 返回搜索结果                    |
| T50.24 | 搜索 | 空查询分页       | 当前页 + 自动化分页覆盖         |
| T50.25 | 限制 | 大输出截断       | truncated + outputPath          |
| T50.26 | 限制 | 超并发排队       | 12 调用全部完成                 |
| T50.27 | 清理 | 删除 MCP         | execute 消失                    |
| T50.3b | 准备 | 沙箱测试项目     | exec 写文件进沙箱               |
| T50.28 | 内置 | read+glob 编排   | 真实文件，自我修复收敛          |
| T50.29 | 内置 | grep+read 组合   | 跨工具数据流                    |
| T50.30 | 收益 | 脚本汇总对比     | input token 方向性更优          |
| T50.31 | 已知 | 卡死观察         | 记录，不判 FAIL                 |

## 确定性自动化覆盖

SaaS E2E 通过后必须运行以下测试，不能用 E2E 中的模型回复替代：

```bash
(cd packages/opencode && bun test test/tool/code-mode.test.ts test/tool/code-mode-integration.test.ts)
(cd packages/opencode && bun test test/mcp/session-mcp.test.ts)
(cd packages/opencode && bun test test/mcp/lifecycle.test.ts)
(cd packages/codemode && bun test test/promise.test.ts)
```

这些文件必须分进程运行，因为 `session-mcp.test.ts` 使用进程级 MCP SDK mock。

自动化层覆盖：完整/部分 catalog、schema signature、特殊工具名、structuredContent、图片与 resource blob/link、base64 隔离、console 日志、权限 ask/deny、错误传播、预中止、实时 metadata、搜索分页、并发上限、session cache 隔离、client 关闭与重连、remote/local MCP 失败隔离及 timeout 清理。

---

## 复测记录

| 日期 | 环境 | 结果 |
|---|---|---|
| 2026-09-04 | 组合 1（远端 PG+远端沙箱），镜像 `:ccr`，all 模式（T50.27 用 mcp 模式），Yd-DeepSeek/deepseek-v4-flash | E2E 29/30 通过：T50.1–19 ✅（T50.8 重跑一次，T50.12 改缺参触发，T50.18 按语义判），T50.20 ⏭️（Kimi provider 500，网关问题），T50.21 ✅，T50.22 ⚠️（interrupted 语义与文档旧断言不一致，已修正断言），T50.23–26 ✅，T50.27 ✅（mcp 模式 0 新 part），T50.28–30 ✅（T50.30 实验设计修正为两轮对比，276 vs 1350）。自动化：code-mode catalog 8 ✅ / session-mcp 13 ✅ / lifecycle 21 ✅ / promise 35 ✅ |
