# Code Mode（V2 `execute`）测试

> 本文使用当前 V2 HTTP、Session Message、Tool snapshot 和数据库契约编写。所有端到端场景经 SaaS HTTP API 发起，并同时验证 assistant tool state 与 PostgreSQL；自然语言回复不能单独作为通过依据。
>
> 实现位置：`packages/codemode`、`packages/core/src/codemode`、`packages/core/src/tool.ts`。Sandbox 迁移设计：[`docs/design/codemode-session-sandbox-execution.md`](../../design/codemode-session-sandbox-execution.md)。

## 0. 当前执行能力与验收边界

| 能力 | 当前状态 | 本文如何验收 |
|---|---|---|
| V2 `execute({ code })`、受限解释器、工具调用及 progress metadata | server 兼容执行器与 Sandbox Runner 路径均接入 Tool snapshot | 单测 + HTTP/PG E2E |
| step / timeout / tool-call / output 限额 | CodeMode 配置与解释器已有实现 | 配置单测 + E2E 失败状态检查 |
| Session 权限、工具定义过滤与调用 | 沿用 SaaS Tool snapshot 路径 | HTTP/PG E2E |
| Runner daemon、Sandbox 镜像 bundle、WebSocket execute/tool.call/result/progress/cancel | 已实现基础链路；容器内 smoke 覆盖解释器、工具 RPC、重叠路径、危险路径拒绝及 progress | 单测 + 容器内协议 smoke；不足以替代 SaaS HTTP/PG E2E |
| Tool snapshot execute dispatch、Session Sandbox 启动及 SaaS tool callback | 已接入代码 | 必须通过启用的 OpenSandbox + SaaS HTTP API 验证；本地 Runner 测试不替代此验收 |
| PG execution/call ledger、nonce/owner lease、多实例路由 | **尚未接入** | 不得宣称完整架构验收或可审计的 execution/call 状态已完成 |

Code Mode 当前默认选择 Sandbox executor，且默认由 Sandbox Runner 的原生 `fetch` 发起网络请求；设置 `OPENCODE_CODEMODE_EXECUTOR=server` 才会使用兼容的服务端执行器及其网络。已完成的 server executor HTTP/PG 测试属于显式 server 配置下的历史基线。**Sandbox executor 基础链路已通过本地 OpenSandbox + SaaS HTTP/PG E2E（2026-10-09 builtin-agents runtime T62.11：Runner daemon 启动、server gateway 连接、`execute` 纯代码成功、SSE/PG 正常）**；但带子工具调用的 Runner `tool.call` → SaaS Tool snapshot dispatch（TCM2.S2 完整形态）、幂等（S4）、nonce/owner 校验（S6）、PG execution/call ledger 仍未接入或未验收。

### 实现逻辑覆盖矩阵（2026-10-10 对照当前源码）

| 实现模块 | 位置 | 用例覆盖 | 评估 |
|---|---|---|---|
| 解释器/stdlib/限额/并发 | `packages/codemode/src/interpreter`、`stdlib` | TCM2.1 单测、TCM2.5–2.7/2.10 E2E | ✅ 覆盖 |
| 工具 schema/目录/搜索 | `tool-schema.ts`、`tool-runtime.ts`、`namespace.ts` | TCM2.1/2.9 单测 + E2E | ✅ 覆盖 |
| 配置（executor/network/limits 校验与互斥） | `core/codemode/config.ts` | TCM2.10 + config 单测；互斥报错有单测 | ✅ 覆盖 |
| 有界 catalog 摘要 + 指令注入 | `core/codemode/catalog.ts`、`instructions.ts` | catalog/instructions 单测 + TCM2.9a 审计 | ✅ 覆盖 |
| execute 工具注册 + sandbox/server 分支 + catalog 缓存 | `core/tool.ts` | TCM2.4 E2E（server 基线）+ T62.11（sandbox 纯代码）；缓存为性能细节，单测覆盖 | ✅ 覆盖 |
| Runner daemon（flock 幂等启动/gateway/stop） | `core/codemode/runner.ts` | `codemode-runner.test.ts` + T62.11 实测启动 | ✅ 覆盖（daemon 重启幂等并入 S1/S7 门槛） |
| WebSocket execute/tool.call/result/progress/cancel | `runner.ts` + 镜像内 Runner | 容器内协议 smoke + **sandbox executor E2E 已通（2026-10-10，`../scripts/code-mode-sandbox-s2.mjs`：Runner tool.call 经 SaaS Tool snapshot dispatch、toolCalls 审计、progress×2 含子调用、echo 哨兵回传）** | ✅ S2 完整形态已验证；S4/S6/S7 仍按门槛表待验 |
| 网络 capability（disabled/sandbox/server） | `core/codemode/web.ts`、`extension.ts` | TCM2.15 + S8 门槛 | ✅ 设计覆盖；S8 egress identity E2E 待跑 |
| CCR 互斥（`codemode:false` 工具排除） | 各 tool plugin + `mcp-codemode-exclusion.test` | Core 单测 | ✅ 覆盖 |
| **OpenAPI → CodeMode 工具适配器** | `packages/codemode/src/openapi` | 仅库导出（`index.ts`），**core/server/app 无接线点**——SDK 消费者能力，不在 SaaS 产品路径 | ℹ️ 非 E2E 缺口；由包单测承担（`OpenAPI.fromSpec` 当前 1 个已知失败，见执行记录） |
| progress 上报（子调用 → `session.tool.progress`） | `runner.ts` + tool.ts | **已验证（2026-10-10 sandbox executor E2E：progress×2 且内容含 echo.echo 子调用）** | ✅ 覆盖 |

**结论**：单测与 server executor 基线覆盖全面；Sandbox executor 的 **S2（子工具 dispatch）、progress、S7（Runner kill 恢复）与 S8（egress identity）已全部有 E2E 证据**（2026-10-10，`code-mode-sandbox-s2.mjs` + `code-mode-sandbox-s3468.mjs`，模型 deepseek-v4-flash）。**S4（幂等）与 S6（nonce/owner）经现状证实测试确认产品缺口可复现**（RISK 级，非 PASS）：Runner 无握手，沙箱内任意进程可直连 9911 执行代码；SaaS 侧对每个 tool.call 直接执行、无 (executionID, ordinal) 去重缓存——重复帧将重复触发有副作用工具。**PG execution/call ledger 仍未实现**（第 0 节声明），S4/S6 的根本修复与可审计状态依赖该接入。
> 可复现要点：① 注册 MCP 后必须做就绪门控；模型侧需 harness agent 强约束「只用 execute」并自动应答 question form（实测两模型均出现过探索/提问卡轮，失败形态 `form.cancelled + execution.interrupted`）。② S8 观测必须用**同 Docker bridge 网络的观测容器**——macOS Docker 下 `host.docker.internal` 对所有容器在宿主侧都呈现 127.0.0.1，无身份鉴别力（首版 S8 断言因此作废重做）。

完整 Sandbox 验收仍须通过 HTTP 请求验证 Runner → SaaS Tool snapshot callback，并在 PG 中检查现有 Session/Message/Tool 状态。配置值被接受、Runner 能单独启动或 WebSocket 单测通过，都不能替代 HTTP/PG 端到端验收。

### Code Mode 核心价值覆盖矩阵

| 社区所述核心价值 | 当前用例 | 覆盖结论 | 缺口 / 补充用例 |
| --- | --- | --- | --- |
| 减少大工具目录的 schema/context 占用 | TCM2.8、TCM2.9 验证 snapshot 过滤和 `search()` | **部分**：证明按需搜索正确，不证明大目录未将全部 schema 送入模型 | TCM2.9a：大目录按需发现与 model request 审计 |
| 中间结果留在执行环境、只回传聚合结果 | TCM2.4a 对 3 条 issue 做汇总 | **部分**：证明小数据聚合正确，不证明大结果未污染后续模型上下文 | TCM2.4c：大结果 Sandbox 聚合与后续 model request 哨兵检查 |
| 循环、条件、顺序依赖和并发编排 | TCM2.4a、TCM2.5、TCM2.6、TCM2.7 | **覆盖**：自然触发、依赖传值、`Promise.all`、错误捕获均有断言 | 保持 HTTP/PG 回归 |
| 在隔离环境执行代码和处理数据 | TCM2.S1–S8、TCM2.13、TCM2.15 | **定义已覆盖，E2E 未通过**：S8 要求以 fixture egress identity 证明 fetch 源于 Sandbox | TCM2.S1–S8 与 S9 必须在 OpenSandbox + HTTP/PG 环境复跑 |

## 1. 环境与安全约定

测试环境要求：

- SaaS 服务按项目约定运行在 Docker 中；测试请求发往该容器公开的 SaaS HTTP API。
- 数据库使用当前环境对应的 PostgreSQL；`BASE`、`PG_URL`、`MODEL` 由环境脚本提供，不在文档中固化密码或 API key。
- API 路径以当前 V2 `/api/...` 为准。不要使用 V1 `/session/:id/message`、`/prompt_async` 或 `/exec`。
- 每轮执行使用独立 Session，避免历史 Tool part、权限规则或 MCP 状态污染结果。
- 对每个场景先记录本 Session 的 `session_message.seq` 水位，只检查水位之后新写入的记录；不得查询“不加边界的最新一行”。
- 所有命令应检查 HTTP status 和响应 JSON；不要仅用 `curl -s` 后忽略错误。

从仓库根目录加载本地 PG（`opencode-v2-up`）测试环境与 `pgval` 帮助函数：

```bash
source docs/test-cases/test-env.sh 3
source docs/test-cases/test-lib.sh
test -n "$BASE" && test -n "$PG_URL" && test -n "$MODEL"
```

### 当前配置

```text
OPENCODE_CODEMODE_EXECUTOR=server|sandbox   # 默认 sandbox；server 是显式兼容回退
OPENCODE_CODEMODE_NETWORK=disabled|server|sandbox  # 随 executor 默认：sandbox 或 server
OPENCODE_CODEMODE_TIMEOUT_MS=<正整数>        # 未设置 = 不限
OPENCODE_CODEMODE_MAX_TOOL_CALLS=<正整数>    # 未设置 = 不限
OPENCODE_CODEMODE_MAX_STEPS=<正整数>         # 未设置 = 不限
OPENCODE_CODEMODE_MAX_OUTPUT_BYTES=<正整数>  # 未设置 = 不限
```

本地组合 3 的 Sandbox executor E2E 必须额外传入 `OPENCODE_SANDBOX_ENABLED=true` 和 `OPENCODE_SANDBOX_PROTOCOL=http`：前者未设置时 Code Mode 会明确拒绝“requires an enabled Session Sandbox”，后者若遗漏会使用默认 HTTPS，无法连接本地 HTTP OpenSandbox `:8080`。

`OPENCODE_CODEMODE_NETWORK=sandbox` 只允许与 Sandbox executor 同用，Runner 通过 Sandbox 进程的原生 `fetch` 直接发请求；请求不会经过 SaaS。`OPENCODE_CODEMODE_NETWORK=server` 只允许与显式 `executor=server` 同用。设置 `disabled` 会从脚本全局环境移除 `fetch`。

四个限额默认全部不设，与 V2 线一致：限额是部署侧可选策略，不是产品默认。显式设置但不是正整数会在启动时报配置错误，不会静默取消该预算。

默认不限额意味着 `while (true) {}` 这类同步死循环不会被 `timeoutMs`/`maxSteps` 打断：协作式 timeout 在解释器同步执行段无法抢占。生产部署应显式设置 `OPENCODE_CODEMODE_TIMEOUT_MS` 与 `OPENCODE_CODEMODE_MAX_STEPS`；测试限额相关场景时必须显式设置对应变量，否则该场景不会触发限额。

注意：当前 `server` executor 未设置 `OPENCODE_CODEMODE_NETWORK` 时默认为 `server`，因此会启用由 SaaS 进程提供的 `fetch` capability。联网测试必须明确记录该配置并使用受控 URL；`disabled` 才是关闭 fetch 的对照组。当前 web extension 使用全局 fetch，测试不要向其中放入凭据或访问非测试资源。

## 2. V2 HTTP 与 PG 观察方式

### 2.1 创建 Session 并提交 prompt

当前 API 是 `POST /api/session` 创建 Session，`POST /api/session/:sessionID/prompt` 持久接收用户输入并调度 agent loop。Prompt body 使用 `text`，不是旧版 `parts` 数组。

```bash
api_curl() {
  test -n "${OPENCODE_PASSWORD:-}" || { echo "OPENCODE_PASSWORD is required" >&2; return 2; }
  curl --fail-with-body -sS --user "opencode:$OPENCODE_PASSWORD" "$@"
}

new_session() {
  jq -nc --argjson model "$V2_MODEL" '{model:$model}' |
    api_curl -X POST "$BASE/api/session" \
      -H 'Content-Type: application/json' --data-binary @- |
    jq -er '.data.id'
}

send_prompt() {
  local sid=$1 text=$2
  jq -nc --arg text "$text" '{text:$text}' |
    api_curl -X POST "$BASE/api/session/$sid/prompt" \
      -H 'Content-Type: application/json' --data-binary @-
}
```

> `session.prompt` 是 durable admission API，通常返回接纳结果而不是整轮 assistant 最终回复。异步执行完成与否必须检查持久化消息（或订阅当前 V2 event stream）和 PG 状态。

### 2.2 水位和当前 Session Message 结构

当前存储模型为 `session_message`：消息类型与消息数据分列，assistant 数据中的 `content` 包含 `type='tool'` 的 Tool part；Tool state 使用 `streaming`、`running`、`completed` 或 `error`，终态为 `completed` / `error`（`streaming` 只表示 input 仍在流式拼接）。本地 SaaS PG 中 `data` 列为 `text`，查询前必须转换为 `jsonb`。这与 V1 的 `part` 表、`data->'state'` JSON 形状不同。

```bash
message_watermark() {
  pgval "SELECT coalesce(max(seq), 0) FROM session_message WHERE session_id='$1'"
}

assistant_tool_messages_after() {
  local sid=$1 after=$2
  pgval "SELECT jsonb_build_object(
    'message_id', id,
    'seq', seq,
    'content', (data::jsonb)->'content'
  )
  FROM session_message
  WHERE session_id='$sid'
    AND type='assistant'
    AND seq > $after
    AND jsonb_path_exists(data::jsonb, '$.content[*] ? (@.type == \"tool\")')
  ORDER BY seq"
}
```

该 PG cast 已按本地 `opencode-v2-up` 的 `session_message.data:text` 定义编写；若测试数据库 schema 不同，应先检查 `information_schema.columns` 并显式适配。消息 HTTP readback 可通过 `GET /api/session/:sessionID/message/:messageID`，响应需按当前协议的 `{ data }` envelope 解包。

### 2.3 等待执行终态

轮询水位后的 assistant Tool part，直到 `state.status` 变成 `completed` 或 `error`，并设置有界 deadline。不要用固定长 `sleep` 代替终态检查。

```bash
wait_for_execute_terminal() {
  local sid=$1 after=$2
  for _ in $(seq 1 120); do
    local rows
    rows=$(assistant_tool_messages_after "$sid" "$after")
    if printf '%s\n' "$rows" | jq -es '
      [.[]? | .content[]? | select(.type == "tool" and .name == "execute")] as $calls |
      ($calls | length) > 0 and
      all($calls[]; .state.status == "completed" or .state.status == "error")
    ' >/dev/null; then
      printf '%s\n' "$rows"
      return 0
    fi
    sleep 1
  done
  echo "execute did not reach a terminal state before deadline" >&2
  return 1
}

wait_for_assistant_completed() {
  local sid=$1 after=$2
  for _ in $(seq 1 120); do
    if [ "$(pgval "SELECT count(*) FROM session_message
      WHERE session_id='$sid' AND type='assistant' AND seq > $after
        AND data::jsonb->'time'->>'completed' IS NOT NULL")" -gt 0 ]; then
      return 0
    fi
    sleep 1
  done
  echo "assistant turn did not complete before deadline" >&2
  return 1
}

# 一条 prompt 的回合可能链式触发多次 execute（先取数再加工）。「首条 assistant
# completed」只说明某一步落库，不说明回合结束；回合结束的持久信号是 idle 消息。
# TCM2.4a 这类断言聚合整轮的场景，必须等 idle 后再取数。
wait_for_turn_idle() {
  local sid=$1 after=$2
  for _ in $(seq 1 120); do
    if [ "$(pgval "SELECT count(*) FROM session_message
      WHERE session_id='$sid' AND type='idle' AND seq > $after")" -gt 0 ]; then
      return 0
    fi
    sleep 1
  done
  echo "turn did not reach idle before deadline" >&2
  return 1
}
```

以下测试示例中的 JSON 检查都应先选取水位之后 `name == "execute"` 的 Tool part。若一轮产生多次 execute（模型自我修复等），按 seq 和 content 顺序断言，不能只断言无边界的“最新一条”。

### 2.4 E2E fixture 前置

模型 E2E 使用独立 Session MCP fixture。五个 fixture（`echo`、`workitems`、`workitems-large`、`inventory`、`delay`）位于服务端 checkout 的 `docs/test-cases/code-mode/fixtures/`，但**不能假设新 Session 的 `/workspace` 已有仓库文件**：Session Sandbox 独立于 SaaS 容器。创建每个 Session 后，必须通过该 Session 的 V2 shell API 将 fixture 内容安装进其 Sandbox，再注册本地 MCP。Sandbox 需要 Node.js 和 `supergateway`（Session MCP bridge 依赖）；无需安装 fixture 的 npm 依赖。

- `echo({message:string})` 稳定返回 `Echo: <message>`；
- `workitems.search_open({repository:string})` 返回固定的三个 open issue：`OPS-101`、`OPS-102`、`OPS-103`；
- `workitems.get_issue({key:string})` 返回固定详情：101=`critical`、102=`minor`、103=`major`；
- `workitems-large.list()` 返回 1,000 条、总正文大于 1 MiB 的唯一 sentinel 记录；
- `inventory.lookupBySKU({sku:"SKU-42"})` 与 200 个无关 schema 一同注册；
- 另为取消测试提供一个可控的长任务工具。

Fixture 不得依赖每次运行时 `npx` 下载或未固定版本的公共 MCP 服务。每个 E2E Session 都重新注册 MCP，避免连接状态和历史消息复用。

```bash
# Session sandbox 的 workspace 根目录固定为 /workspace。
export ECHO_MCP_COMMAND='["node","/workspace/docs/test-cases/code-mode/fixtures/echo-mcp.mjs"]'
export WORKITEMS_MCP_COMMAND='["node","/workspace/docs/test-cases/code-mode/fixtures/workitems-mcp.mjs"]'
export WORKITEMS_LARGE_MCP_COMMAND='["node","/workspace/docs/test-cases/code-mode/fixtures/workitems-large-mcp.mjs"]'
export INVENTORY_MCP_COMMAND='["node","/workspace/docs/test-cases/code-mode/fixtures/inventory-mcp.mjs"]'
export DELAY_MCP_COMMAND='["node","/workspace/docs/test-cases/code-mode/fixtures/delay-mcp.mjs"]'

install_session_mcp_fixture() {
  local sid=$1 fixture=$2 name marker encoded command before
  name=$(basename "$fixture")
  marker="mcp-fixture-installed-${sid}"
  encoded=$(base64 < "$fixture" | tr -d '\n')
  command="mkdir -p /workspace/docs/test-cases/code-mode/fixtures && printf '%s' '$encoded' | base64 -d > '/workspace/docs/test-cases/code-mode/fixtures/$name' && node --check '/workspace/docs/test-cases/code-mode/fixtures/$name' && command -v supergateway >/dev/null && printf '%s\\n' '$marker'"
  before=$(message_watermark "$sid")
  jq -nc --arg command "$command" '{command:$command}' |
    api_curl -X POST "$BASE/api/session/$sid/shell" \
      -H 'Content-Type: application/json' --data-binary @- >/dev/null
  for _ in $(seq 1 60); do
    if [ "$(pgval "SELECT count(*) FROM session_message
      WHERE session_id='$sid' AND type='shell' AND seq > $before
        AND data::jsonb->>'status' = 'exited'
        AND data::jsonb->>'command' LIKE '%$marker%'
        AND data::jsonb->'output'->>'output' LIKE '%$marker%'")" -gt 0 ]; then
      return 0
    fi
    sleep 1
  done
  echo "MCP fixture installation failed or timed out: session=$sid fixture=$name" >&2
  return 1
}

register_echo_mcp() {
  local sid=$1
  install_session_mcp_fixture "$sid" "$(git rev-parse --show-toplevel)/docs/test-cases/code-mode/fixtures/echo-mcp.mjs"
  jq -nc --argjson command "$ECHO_MCP_COMMAND" \
    '{name:"echo",config:{type:"local",command:$command}}' |
    api_curl -X POST "$BASE/api/session/$sid/mcps" \
      -H 'Content-Type: application/json' --data-binary @-
}

register_workitems_mcp() {
  local sid=$1
  install_session_mcp_fixture "$sid" "$(git rev-parse --show-toplevel)/docs/test-cases/code-mode/fixtures/workitems-mcp.mjs"
  jq -nc --argjson command "$WORKITEMS_MCP_COMMAND" \
    '{name:"workitems",config:{type:"local",command:$command}}' |
    api_curl -X POST "$BASE/api/session/$sid/mcps" \
      -H 'Content-Type: application/json' --data-binary @-
}

register_workitems_large_mcp() {
  local sid=$1
  install_session_mcp_fixture "$sid" "$(git rev-parse --show-toplevel)/docs/test-cases/code-mode/fixtures/workitems-large-mcp.mjs"
  jq -nc --argjson command "$WORKITEMS_LARGE_MCP_COMMAND" \
    '{name:"workitems-large",config:{type:"local",command:$command}}' |
    api_curl -X POST "$BASE/api/session/$sid/mcps" \
      -H 'Content-Type: application/json' --data-binary @-
}

register_inventory_mcp() {
  local sid=$1
  install_session_mcp_fixture "$sid" "$(git rev-parse --show-toplevel)/docs/test-cases/code-mode/fixtures/inventory-mcp.mjs"
  jq -nc --argjson command "$INVENTORY_MCP_COMMAND" \
    '{name:"inventory",config:{type:"local",command:$command}}' |
    api_curl -X POST "$BASE/api/session/$sid/mcps" \
      -H 'Content-Type: application/json' --data-binary @-
}

register_delay_mcp() {
  local sid=$1
  install_session_mcp_fixture "$sid" "$(git rev-parse --show-toplevel)/docs/test-cases/code-mode/fixtures/delay-mcp.mjs"
  jq -nc --argjson command "$DELAY_MCP_COMMAND" \
    '{name:"delay",config:{type:"local",command:$command}}' |
    api_curl -X POST "$BASE/api/session/$sid/mcps" \
      -H 'Content-Type: application/json' --data-binary @-
}

assert_echo_mcp_configured() {
  api_curl "$BASE/api/session/$1/mcps" |
    jq -e '.data | any(.[]; .name == "echo" and .config.type == "local" and .config.disabled != true)'
}
```

MCP 配置 GET 只能证明配置存在，不能证明进程已连接；必须由下方真实 `tools.echo.echo` 调用成功来证明连接和 dispatch。若部署的 GET response envelope 与示例不同，应依照当前 V2 OpenAPI 契约调整 jq，而不是跳过断言。

### 2.5 模型请求审计（TCM2.4c / 2.9a / S9 的前置条件）

「初始模型请求没有携带全部 schema」「后续请求没有重新携带大正文」这类断言，只能对**真实 provider 请求**成立。仅检查 Session 持久消息或最终回复无法排除请求本身已污染的情况。

实现：Core 在 `SessionModelRequest.prepare` 末尾（已过 CCR 与全部插件 hook、provider 即将收到请求的时刻）按行追加审计记录。开关环境变量是 `OPENCODE_MODEL_REQUEST_LOG=<目录>`（E2E 脚本里对应 `AUDIT_DIR`）。默认关闭，不设置环境变量时不创建目录、不做投影。

```bash
# 部署侧（容器启动时）
docker run -d --name opencode-saas-codemode-current -p 14096:4096 \
  -e OPENCODE_PASSWORD=codemode-e2e-local \
  -e OPENCODE_DATABASE_URL=postgresql://local@host.docker.internal:15432/opencode-v2-up \
  -e OPENCODE_SANDBOX_ENABLED=true -e OPENCODE_SANDBOX_PROTOCOL=http \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:8080 -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  -e OPENCODE_SANDBOX_IMAGE=opencode-opensandbox:codemode-local \
  -e OPENCODE_MODEL_REQUEST_LOG=/audit -v /tmp/codemode-audit:/audit \
  opencode-saas-codemode-current:local
```

每行一个 JSONL 记录，字段为 `sessionID`、`kind`、`agent`、`model`、`toolNames`、`tools`（name/description/inputSchema，namespace 递归展开）、`system`、`messages`、`toolChoice`、`truncated`。`kind` 取值为 `primary` / `generate` / `compaction` / `title`，其中 `title` 请求不携带工具目录；脚本用 `AGENT_KINDS` 只对携带目录的轮次做工具断言。

**审计边界（必须如实理解）**：

- 刻意**不**记录 `http` 与 `providerOptions`，二者承载凭据与 provider 设置；`ModelRequestLog` 单测断言密钥不出现在文件中。
- 记录的是 provider 即将收到的**模型可见请求**（post-hook）。它能证明模型看到了什么工具与什么消息内容；它不是 provider 网络层抓包，不证明 wire 上的字节完全一致。
- 单条超过 32 MiB 时降级为 `truncated: true` 并丢弃 `system`/`messages`。**截断记录不能用于"内容缺席"证明**，脚本因此强制断言全部记录 `truncated === false`。
- 该能力对所有 provider 生效（记录点在 Core，不在具体 route），因此不依赖测试 provider 是否可替换。

`docs/test-cases/code-mode/run-audit-e2e.mjs` 封装了建 Session、装 fixture、注册 MCP、逐轮等待 assistant 终态、读取审计日志与 PG 校验、最后删除 Session 的全过程。等待逻辑按轮次比较"新出现的已完成 assistant 消息"，避免上一轮尚未结束就提交下一轮。

## 3. 先决检查与确定性测试

### TCM2.1 CodeMode package 单测

```bash
bun run --cwd packages/codemode test
```

**通过条件**：解释器、工具 catalog、Schema 输入/输出、promise/并发、step 预算、超时与错误测试全部通过。若全包包含与本次改动无关的已知失败，必须逐项报告失败测试名、断言和归属；不能把整包失败简单归因于环境。

### TCM2.2 Core Code Mode / Sandbox 单测

```bash
bun run --cwd packages/core typecheck
bun run --cwd packages/core test \
  test/codemode.test.ts \
  test/codemode-config.test.ts \
  test/codemode-fixtures.test.ts \
  test/codemode-runner.test.ts \
  test/codemode/catalog.test.ts \
  test/codemode/instructions.test.ts \
  test/session-model-request-log.test.ts \
  test/tool-execute.test.ts \
  test/sandbox-config.test.ts \
  test/sandbox-volumes.test.ts \
  test/sandbox-tools-read.test.ts \
  test/sandbox-tools-write.test.ts \
  test/sandbox-tools-ripgrep.test.ts \
  test/sandbox-proxy-rewrite.test.ts \
  test/plugin/mcp-codemode-exclusion.test.ts
```

**通过条件**：命令退出码为 0，并记录通过/失败/跳过数量。该组测试验证可确定的 Core 行为，不替代 HTTP 与 PG E2E。

### TCM2.3 当前 V2 接口与消息 readback

```bash
SID=$(new_session)
api_curl "$BASE/api/session/$SID/message" | jq -e '.data | type == "array"'
```

**通过条件**：服务提供 V2 `/api` 协议；Session message list 使用当前 wire contract。不得以 V1 `/experimental/tool/ids` 或旧工具 catalog 测试代替。

## 4. 服务端 executor HTTP + PG 基线

执行前确认服务进程配置 `OPENCODE_CODEMODE_EXECUTOR=server`（这些场景是 server executor 历史基线），创建独立 Session。每个场景都执行以下准备：

```bash
SID=$(new_session)
BEFORE=$(message_watermark "$SID")
```

`prompt` 提交后从 PG 等待 `execute` Tool part；必要时用 message GET 或当前 V2 事件接口辅助定位，但最终状态和子工具输入/结果以 PG 持久化的 Session Message 为准。

### TCM2.4 execute 暴露与单工具编排

创建 Session、注册并验证 deterministic echo MCP，然后记录水位、提交 prompt 并等待所有新增 execute Tool part 进入终态：

```bash
SID=$(new_session)
register_echo_mcp "$SID"
assert_echo_mcp_configured "$SID"
BEFORE=$(message_watermark "$SID")
send_prompt "$SID" '必须调用 execute，执行：return await tools.echo.echo({message:"v2-single"})'
ROWS=$(wait_for_execute_terminal "$SID" "$BEFORE")
printf '%s\n' "$ROWS" | jq -es '
  [.[] | .content[] | select(.type == "tool" and .name == "execute")] as $calls |
  ($calls | length) == 1 and
  $calls[0].state.status == "completed" and
  ($calls[0].state.input.code | contains("v2-single")) and
  ($calls[0].state.content | tostring | contains("Echo: v2-single")) and
  $calls[0].state.metadata.toolCalls == [{"tool":"echo.echo","status":"completed","input":{"message":"v2-single"}}]
'
```

**断言**：

1. assistant tool content 中有 `name == "execute"` 的 Tool part；state 最终为 `completed`。
2. `execute` 的 input.code 包含预期脚本语义（不要求模型生成文本逐字一致）。
3. execute 输出包含 echo 的结构化结果；execute state metadata 中子工具调用记录为 completed，路径及 input 与测试值吻合。
4. child tool 的实际执行仍经过 SaaS Tool snapshot；PG 中 Session Message 有对应 progress/tool-call 记录。
5. 不以 prompt endpoint 返回值或 assistant 自然语言声称“完成”作为通过依据。

### TCM2.4a 真实业务任务：批量 triage 工单并自然触发 Code Mode

此场景刻意**不在用户 prompt 中提 `execute`、Code Mode 或脚本**，检验模型是否会在需要多工具取数、汇总和派生计算时自行选择 Code Mode。每次运行使用新 Session 和 deterministic `workitems` MCP：

```bash
SID=$(new_session)
register_workitems_mcp "$SID"
api_curl "$BASE/api/session/$SID/mcps" |
  jq -e '.data | any(.[]; .name == "workitems" and .config.disabled != true)'
BEFORE=$(message_watermark "$SID")

send_prompt "$SID" '请整理 acme/api 仓库当前所有未关闭 issue：先找出 issue，再检查每条详情；这些详情查询彼此独立，可以并行完成。将 critical 和 major 视为高优先级。只返回 JSON：repository、openCount、highPriorityCount、highPriorityIssues；highPriorityIssues 按 issue 编号升序排列；不要修改 issue。'
wait_for_execute_terminal "$SID" "$BEFORE"
wait_for_turn_idle "$SID" "$BEFORE"   # 回合可能链式多次 execute，等 idle 再聚合取数
ROWS=$(assistant_tool_messages_after "$SID" "$BEFORE")
# 最终答案在回合末尾的纯文本 assistant 消息里；剥离 ```json 围栏后解析。
FINAL_JSON=$(pgval "SELECT (data::jsonb)->'content' FROM session_message
  WHERE session_id='$SID' AND type='assistant'
    AND (data::jsonb)->'time'->>'completed' IS NOT NULL
  ORDER BY seq DESC LIMIT 1" |
  jq -c '[.[]? | select(.type == "text") | .text
    | gsub("^```(json)?\\s*|\\s*```$"; "") | try fromjson catch null]')

printf '%s\n' "$ROWS" | jq -es --argjson final "$FINAL_JSON" '
  [.[] | .content[] | select(.type == "tool" and .name == "execute")] as $execs |
  ($execs | map(select(.state.status == "completed"))) as $ok |
  ($ok | last) as $last |
  ($ok | length) >= 1 and ($last != null) and
  # 自然触发通常是两次 execute（先 search_open 再 get_issue），断言必须聚合整轮，
  # 不能只看最后一个 execute；也不能只看单条 input.code。
  (([$ok[].state.input.code] | join("\n")) | contains("search_open")) and
  (([$ok[].state.input.code] | join("\n")) | contains("get_issue")) and
  ([$ok[].state.metadata.toolCalls[]?] as $calls |
    any($calls[]; .tool == "workitems.search_open" and .status == "completed" and .input.repository == "acme/api") and
    ([$calls[] | select(.tool == "workitems.get_issue" and .status == "completed") | .input.key] | sort) == ["OPS-101","OPS-102","OPS-103"] and
    ([$calls[] | select(.status == "error")] | length) == 0 and
    all($calls[]; .tool == "search" or .tool == "workitems.search_open" or .tool == "workitems.get_issue")
  ) and
  # 最终 JSON 在回合末尾的纯文本 assistant 消息里，不在最后一个 execute 的
  # content 里（那是脚本返回值）；highPriorityIssues 条目可能是编号或对象，
  # 文本可能带 ```json 围栏，先剥离再解析。
  ($final | any(
    . != null and
    .repository == "acme/api" and
    .openCount == 3 and
    .highPriorityCount == 2 and
    ((.highPriorityIssues | map(.key // .) | sort) == ["OPS-101","OPS-103"])
  ))
'
```

**过程与结果断言**：

1. 新增 assistant Tool content 中实际出现 `name == "execute"`；只看到自然语言总结或直接返回答案不算触发成功。
2. execute 输入是本任务的 CodeMode 程序；最终成功的 execute 至少经由 Tool snapshot 完成 1 次搜索和 3 次详情调用，PG 中记录的工具名、input、completed 状态与 fixture 一致。
3. 最终结构化 JSON 精确反映 fixture 的 3 个 open issue、2 个高优先级 issue 及编号排序；没有对 MCP 执行写操作。
4. 若模型先失败后自我修复，按 Session Message 顺序保留并检查完整 execute 序列；最终成功结果通过即可，但中间失败及其调用也必须记录，不能只摘录最后输出。

为了观察“正常触发”而非单次偶然结果，建议用 3 个独立 Session 重复该 prompt，记录 `触发次数/总次数`、完成率和结果正确率；触发率与执行正确率分开统计。

### TCM2.4b 负向对照：简单计算不应无故调用工具

在新 Session 中注册同一 fixture，提交不需要外部数据的简单请求：

```bash
SID=$(new_session)
register_workitems_mcp "$SID"
BEFORE=$(message_watermark "$SID")
send_prompt "$SID" '直接计算 17 × 23，只回答整数，不要查询外部数据。'
wait_for_assistant_completed "$SID" "$BEFORE"
assistant_tool_messages_after "$SID" "$BEFORE" | jq -es '
  [.[] | .content[]? | select(.type == "tool" and .name == "execute")] | length == 0
'
pgval "SELECT jsonb_build_object('content',(data::jsonb)->'content')
  FROM session_message WHERE session_id='$SID' AND type='assistant' AND seq > $BEFORE
  ORDER BY seq DESC LIMIT 1" |
  jq -e 'any(.content[]?; .type == "text" and (.text | test("391")))'
```

等待该轮 assistant 完成后，从 `BEFORE` 之后的 `session_message` 检查：预期没有 `execute` Tool part，也没有 `workitems.*` 调用，assistant 文本答案为 `391`。这是触发精确率对照；与 TCM2.4a 的真实工具任务一起报告，不能只测“总会触发”而不检查不必要触发。

### TCM2.4c 大中间结果在 Sandbox 内聚合

新增 deterministic `workitems-large` MCP fixture：`list` 返回至少 1,000 条记录，每条包含唯一、不可从汇总推导的 `bodySentinel`（总内容至少 1 MiB）；`get` 返回该 sentinel 的完整正文。prompt 要求计算计数、分组和前 N 项标题，只返回小型 JSON，不得返回正文。

```bash
SID=$(new_session)
register_workitems_large_mcp "$SID"
BEFORE=$(message_watermark "$SID")
send_prompt "$SID" '必须调用 execute：读取 workitems-large.list 的全部数据，在代码中统计 even/odd 数量并返回前 3 个 title。只返回 JSON，不要返回任何 bodySentinel 或正文。'
ROWS=$(wait_for_execute_terminal "$SID" "$BEFORE")
```

断言对象必须是**真实 provider 请求**，因此必须先开启 `OPENCODE_MODEL_REQUEST_LOG`（见 2.5）。脚本会提交两条 prompt：第一条要求在 execute 内聚合，第二条只要求解释上一轮口径，从而把"后续 model request"也纳入检查。

```bash
BASE="$BASE" OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
MODEL_PROVIDER=Yd-DeepSeek MODEL_ID=deepseek-v4-flash \
FIXTURE=workitems-large-mcp.mjs MCP_NAME=workitems-large \
AUDIT_DIR="$AUDIT_DIR" SENTINEL=BODY-SENTINEL \
PROMPTS='["必须调用 execute：读取 workitems-large.list 的全部数据，在代码中统计 even/odd 数量并返回前 3 个 title。只返回 JSON，不要返回任何 bodySentinel 或正文。","不要调用任何工具，只用一句话说明上一轮 even/odd 的统计口径。"]' \
node docs/test-cases/code-mode/run-audit-e2e.mjs
```

**断言**：

1. execute 实际读取 fixture 大结果，最终 execute 输出只含要求的聚合 JSON，且小于 16 KiB。
2. 本 Session 的**每一条** provider model request 的 messages 都不包含任一 `bodySentinel`；PG 中 execute Tool part 与最终 assistant 文本同样不含。
3. 第二轮 model request 必须包含第一轮的聚合 JSON（证明历史确实被携带），但不含大正文；若 provider/adaptor 将原始 MCP 结果重新写入模型上下文，此用例必须 FAIL。
4. 脚本必须额外断言"最后一条 prompt 确实出现在某条被审计的请求里"，否则"内容缺席"可能只是"请求没发生"造成的假通过。
5. 在 `executor=sandbox` 下记录 Runner/Sandbox 证据；不能用 server executor 的结果标记 Sandbox 数据局部性通过。

### TCM2.5 顺序依赖与调用顺序审计

一次 execute 内先传 `v2-first` 调用 echo，再将其结果作为第二次调用输入。

**断言**：execute 完成；调用 metadata 顺序为 first call → dependent call；第二次 input 精确依赖第一次的返回值。不得只验证 toolCalls 数量。

### TCM2.6 Promise.all 并发与总调用预算

执行脚本并行发出 3 个相互独立的 echo 调用，随后执行 12 个调用的压力变体。

**断言**：

- 3 调用场景：所有调用 completed，结果可关联到各自 input。
- `OPENCODE_CODEMODE_MAX_TOOL_CALLS` 限制一次执行准入的**总调用数**，不是并发数；该变量默认不设，显式设置为 20 时 12 次调用不得超限。
- 当前 CodeMode runtime 不承诺 `maxActive` 上限；`packages/codemode/test/promise.test.ts` 的对应契约为“不限制 live tool-call concurrency”。barrier 测试应验证 Promise.all 确实有重叠执行，而不是与不存在的并发配置比较。
- 若调用的具体工具内部使用 SandboxProvider semaphore，其排队/并发上限属于 Sandbox command 层，必须作为独立资源并发测试，不能推断为 CodeMode 调用上限。
- PG tool-call 数量、status、input/result 与 HTTP 请求水位匹配。

### TCM2.7 子工具错误与脚本错误

分两种错误：

1. **子工具失败可捕获**：向必填参数校验严格的测试工具传缺参，在 Code Mode 脚本 `try/catch` 中捕获。
2. **Code Mode 解析/执行失败**：分别提交非法语法和不允许的 capability（如 `require`、`eval`、`process`）。

**断言**：可捕获的 child tool failure 在 `metadata.toolCalls` 中为 error，脚本可继续并以 execute `completed` 返回捕获结果。当前 CodeMode 解析/解释器失败是 `CodeMode.Result` diagnostic，由 `CodeModeTool` 转为 execute 的返回文本及 `metadata.error=true`；外层 assistant Tool state 通常仍是 `completed`，只有 Core Tool executor 自身失败才应为 `state.status=error`。断言需同时检查内层诊断、metadata 和外层 state，不能把两种错误状态混为一谈。不允许的 global 不得成功读取或执行。

### TCM2.8 权限、工具快照与定义过滤

对 Session 设置 deny 规则后发送 execute 请求，随后改为 allow 并重试。规则的 API payload 以当前 `Permission` wire schema 为准，不照搬 V1 permission 字段。

当前 Session 更新契约的字段为 `permissions`，Rule 形状为 `{action, resource, effect}`。针对 permission action 为 `echo_echo` 的测试工具，可拒绝其所有资源：

```bash
jq -nc '{permissions:[{action:"echo_echo",resource:"*",effect:"deny"}]}' |
  api_curl -X PATCH "$BASE/api/session/$SID" \
    -H 'Content-Type: application/json' --data-binary @-
```

恢复时将 `effect` 改为 `allow`，并在**新 prompt**中重新检查 snapshot。示例中的 `echo_echo` 来自 MCP permission action `<server>_<tool>` 的规范化命名；测试应先按 `McpTool.name(server, tool)` 核实真实 action。工具目录过滤不是授权本身，调用时仍由 MCP leaf 的 `Permission.assert` 执行授权。

**断言**：deny 状态下工具目录不包含该工具且无法执行成功；恢复 allow 后新请求的新 Tool snapshot 能发现并成功调用；旧请求不应在执行中途悄然变更 snapshot。PG 状态应反映拒绝/成功结果，不得出现 deny 工具成功调用。

### TCM2.9 搜索与目录可见性

由脚本调用当前 CodeMode 内建搜索函数 `search({query:"echo"})`（也可用 `tools.search({query:"echo"})`），分别验证关键词搜索、namespace 过滤、空查询分页与 offset/remaining。搜索签名定义在 `packages/codemode/src/tool-runtime.ts`，不得使用 `$codemode.search`。

**断言**：搜索只返回当前 snapshot 可见工具；分页单测负责完整分页边界；HTTP E2E 验证真实请求中的权限过滤及结果。

### TCM2.9a 大工具目录按需发现

新增 Session MCP fixture，注册至少 200 个具有不同 description/input schema 的只读工具；其中只有 `inventory.lookupBySKU` 与任务相关。断言对象必须是**真实 provider 请求**，因此必须先开启 `OPENCODE_MODEL_REQUEST_LOG`（见 2.5），否则本用例记为 BLOCKED 而不是 PASS。

```bash
BASE="$BASE" OPENCODE_PASSWORD="$OPENCODE_PASSWORD" \
MODEL_PROVIDER=Yd-DeepSeek MODEL_ID=deepseek-v4-flash \
FIXTURE=inventory-mcp.mjs MCP_NAME=inventory \
AUDIT_DIR="$AUDIT_DIR" FORBIDDEN_TOOL_PREFIX=inventory. EXPECT_CATALOG_TOTAL=201 \
PROMPTS='["必须调用 execute：先搜索 SKU 相关工具，再查询 SKU-42；只返回 sku、title、quantity 的 JSON。"]' \
node docs/test-cases/code-mode/run-audit-e2e.mjs
```

**断言**：

1. provider 原生 tool definitions 仅包含 `execute` 与当前明确 `codemode:false` 的直接工具，不得包含任何 `inventory.*` schema。
2. Code Mode catalog 是**有界摘要**而不是全量展开：namespace 行报告真实工具数，并只内联预算内的少量条目。当前实现对内联条目渲染完整 input schema，因此可验证的上限是"内联条目数 < 该 namespace 工具数"，实测 `inventory 8/201`、`browser 7/44`；**不得**断言"请求里完全没有无关工具的 schema 文本"，那是与实现不符的过强断言。
3. execute 通过 `search({query:"SKU"})` 发现 `inventory.lookupBySKU`，仅调用该工具并返回 fixture 固定结果。
4. deny 一个无关工具不应改变该任务结果；deny `inventory.lookupBySKU` 后新 snapshot 的搜索与调用必须失败，证明按需发现仍遵守 snapshot/权限过滤。

> 已知取舍（非本用例失败项）：catalog 内联条目当前带完整 input schema，占用与预算内条目数成正比。若产品要进一步压缩 system prompt，应改为内联只给 path + 描述、schema 由 `search()` 按需返回；这属于 catalog 呈现策略变更，需要独立评估后再改，不能在验收用例里假装已满足。

### TCM2.10 预算、输出大小与超时

使用低测试配置启动独立 SaaS 实例（不得在线修改进程级 env）。这四个限额默认都不设，因此本节每个子场景都必须显式设置对应变量，否则限额不会触发：

> **就绪门控**：全新实例上 Session MCP 工具可能迟迟不进入 Code Mode 工具清单（2026-10-01 实测：45s 沉降 + 预热轮后 CCR 工具已在而 MCP 工具仍缺，`search` 返回空、调用报 `Unknown tool`）。每个预算子场景断言前必须先确认目标工具可见（例如先跑一轮 `search({query:"echo"})` 且结果包含该工具）；不可见时本场景记 BLOCKED，不得把"工具未就绪"误判为限额行为。

- `OPENCODE_CODEMODE_MAX_STEPS`：低步数触发 step limit。
- `OPENCODE_CODEMODE_TIMEOUT_MS`：超时脚本触发 deadline。
- `OPENCODE_CODEMODE_MAX_TOOL_CALLS`：超过预算后不再启动更多工具调用。
- `OPENCODE_CODEMODE_MAX_OUTPUT_BYTES`：超长结果触发截断诊断/返回文本限制。

**断言**：step/tool-call 超限形成相应 CodeMode diagnostic；timeout 使 Tool 执行进入终态；输出限制检查 execute 返回文本中的 `[result truncated:` 提示。`CodeModeTool` 当前把 `CodeMode.Result` 格式化为文本，PG Tool metadata 并不承诺暴露 `truncated` 字段或 `outputPath`；测试不能断言这些未定义字段。tool 总调用数不超过上限，PG 状态属于本次水位。

### TCM2.11 Session interrupt 与工具调用中断

提交一个可控的长耗时 child tool，观察 PG 中 execute state 到达 `running` 后调用当前接口：

```bash
api_curl -X POST "$BASE/api/session/$SID/interrupt" \
  -H 'Content-Type: application/json' -d '{}'
```

**断言**：assistant Tool part 进入当前协议定义的中断终态（以实际 `SessionMessage.ToolState` 和保存状态为准）；等待中的 child tool 不继续产生副作用；同一服务中其它 Session 的执行不被误中断。不要沿用 V1 `aborted`、`metadata.interrupted` 或 `/abort` 断言，除非当前 V2 wire/storage contract 明确提供该字段。

### TCM2.12 删除 MCP / Session 清理

用当前接口 `DELETE /api/session/:sessionID/mcps/:name` 删除测试 MCP，并 GET 当前 Session MCP 配置确认持久记录已移除。随后提交新 prompt。

**断言**：新 Tool snapshot 不含已删除的 MCP 工具且无法调用；执行完成后通过当前 Session 删除 API 清理测试 Session。不要断言 execute 工具整体消失：Code Mode 是否可见取决于当前注册、权限和配置，不等同于单个 MCP 的生命周期。

### TCM2.13 沙箱文件与 Session 隔离

V2 shell API 使用 `POST /api/session/:sessionID/shell`（body `command`），不是旧 `/exec`。shell route 返回 NoContent；完成状态和 bounded output 从 PG 的 `session_message` 中 `type='shell'` 消息读取。以下命令使用两个 Session 的唯一哨兵值，避免跨用例误读：

```bash
SID_A=$(new_session); SID_B=$(new_session)
BEFORE_A=$(message_watermark "$SID_A"); BEFORE_B=$(message_watermark "$SID_B")

run_shell() {
  local sid=$1 command=$2
  jq -nc --arg command "$command" '{command:$command}' |
    api_curl -X POST "$BASE/api/session/$sid/shell" \
      -H 'Content-Type: application/json' --data-binary @- -o /dev/null
}

wait_shell_output() {
  local sid=$1 after=$2 marker=$3
  for _ in $(seq 1 60); do
    local output
    output=$(pgval "SELECT data::jsonb->'output'->>'output'
      FROM session_message
      WHERE session_id='$sid' AND type='shell' AND seq > $after
        AND data::jsonb->>'status' = 'exited'
        AND data::jsonb->>'command' LIKE '%$marker%'
      ORDER BY seq DESC LIMIT 1")
    [ -n "$output" ] && { printf '%s' "$output"; return 0; }
    sleep 1
  done
  echo "shell did not finish: session=$sid marker=$marker" >&2
  return 1
}

run_shell "$SID_A" 'mkdir -p /workspace && printf A-only > /workspace/code-mode-isolation.txt'
run_shell "$SID_B" 'mkdir -p /workspace && printf B-only > /workspace/code-mode-isolation.txt'
run_shell "$SID_A" 'cat /workspace/code-mode-isolation.txt # read-A-7f6a'
run_shell "$SID_B" 'cat /workspace/code-mode-isolation.txt # read-B-1c9d'
OUT_A=$(wait_shell_output "$SID_A" "$BEFORE_A" 'read-A-7f6a')
OUT_B=$(wait_shell_output "$SID_B" "$BEFORE_B" 'read-B-1c9d')
test "$OUT_A" = 'A-only' && test "$OUT_B" = 'B-only'
```

**断言**：Session A 只能读到 A 内容，Session B 只能读到 B 内容；PG sandbox/session 记录的关联符合部署数据模型。CodeMode interpreter 本身不提供 `fs`、`require` 或直接 workspace API；但宿主可把文件工具显式放进 Code Mode tool snapshot。测试必须确认当前 snapshot 中哪些工具被暴露，不能把“无直接文件系统 capability”误解为“经授权工具无法读写文件”。

### TCM2.14 图片/附件结果

使用返回 image content 的测试 MCP 与支持图片输入的模型。图片凭据只通过受支持的 secret/auth 管理界面配置，不写入文档、仓库或命令历史。

**断言**：工具附件按当前 `Tool.Content` / Session Message contract 保留；execute 可安全汇总可见文本；不得将原始 base64 或 data URL 注入不该接收附件的 execute 文本。Provider 不可用时记为 BLOCKED/SKIPPED，并附可复核错误，不计为 PASS。

### TCM2.15 网络 capability 的显式开关

在两个独立 SaaS 测试实例中分别配置 `OPENCODE_CODEMODE_EXECUTOR=sandbox` 与 `OPENCODE_CODEMODE_NETWORK=disabled`、`sandbox`；使用受控的本地 HTTP fixture，不访问任意公网地址。fixture 必须记录请求的 TCP peer/可信 egress identity，并在响应中返回该观测值。`sandbox` 网络模式将 `fetch` capability 直接运行在 Session Sandbox，不能回退到 SaaS 进程网络。另可用显式 server executor + `network=server` 作为兼容基线。

**断言**：

- `disabled`：Code Mode 不暴露 `fetch`，脚本调用应得到受控的 `Unknown identifier 'fetch'` 类诊断，不发出 HTTP 请求。
- `sandbox`：脚本 `await fetch(fixtureURL)` 成功，返回 fixture 固定值；Tool progress 中只记录 fetch method/URL，最终 output 受 `maxOutputBytes` 限制。
- `sandbox`：fixture 记录的 peer/egress identity 必须映射到该 Session Sandbox，并与 SaaS 服务进程 identity 不同。若部署使用统一 NAT，测试环境必须提供可信的 egress identity 映射；只看到 HTTP 200 不足以证明请求来自 Sandbox。
- `server`：仅显式 `executor=server` + `network=server` 的兼容实例可请求 fixture；fixture 应观测到 SaaS 服务进程 identity，不得将其记为 Sandbox 网络访问。
- 不能使用带凭据的 URL/header；不能把可访问云 metadata、内网或任意目标的结果作为通过标准。

## 5. Sandbox executor 验收门槛（当前 BLOCKED）

本节是功能接通后的强制 E2E 清单；当前不得执行后将结果记为通过。满足以下前置条件后，另起测试环境灰度：

1. prompt 发起的 `execute` 由 SaaS 创建 execution，并在该 Session Sandbox Runner 中解释执行；不能只启动 Runner daemon 或仍调用服务端 interpreter。
2. SaaS 主动通过内部 `sandbox.endpoint(sessionID, 9911, true)` 连接 Runner；端口不公开到浏览器 proxy。
3. Runner 握手具有 nonce/owner 校验；nonce 不通过 argv、环境变量或 workspace 文件传递。
4. Runner `tool.call` 经 SaaS 当前权限与 Tool snapshot dispatch；Runner 不持有 SaaS tool 实现、PG 凭据或 provider key。脚本 `fetch` 是 Runner 进程的 Sandbox-local capability，不得经 SaaS 代理。
5. Execution 和 Call 状态在 PG 可审计；`(executionID, ordinal)` 重试幂等，不重复触发有副作用工具。
6. 取消、超时、Session/Sandbox 销毁以及服务重启均能收敛到确定终态；只取消目标 operation，不误伤该 Session 其它 isolated command。

达成以上门槛后补跑下表，并要求 HTTP、执行过程和 PG 三方面同时满足：

| 编号 | 场景 | 必须观察的 HTTP/执行过程 | 必须观察的 PG / Sandbox |
|---|---|---|---|
| TCM2.S1 | 首次启动与 endpoint | 新 Session prompt 可完成；SaaS 通过 server gateway 连接 Runner | runner readiness、execution owner 与 Session/Sandbox 关联一致 |
| TCM2.S2 | 双向工具 dispatch | Runner 发 tool.call，SaaS 以原 snapshot 工具执行并回传结果 | call 按 ordinal 唯一；input、授权决策、状态可审计 |
| TCM2.S3 | 并发执行 | 同 Session 两个独立 isolated command 和 Runner tool call 可并行完成 | 每个 operation 输出/取消隔离，并发不超过配置 semaphore |
| TCM2.S4 | 幂等与断线 | 注入重复 frame、断线重连；非幂等调用不得重复 | `(executionID, ordinal)` 唯一约束/等效幂等记录生效 |
| TCM2.S5 | 中止与清理 | interrupt、deadline、删除 Session 均及时停止对应执行 | execution/call 均进入终态；没有遗留 active lease/context |
| TCM2.S6 | 安全边界 | 无 nonce、错误 owner、过期 execution 均拒绝；公开 proxy 不能连接 Runner | 拒绝原因可审计；无 capability 明文/密钥存储 |
| TCM2.S7 | 进程恢复 | SaaS/Runner 进程重启后旧执行不得被重放 | lease 过期与 interrupted 状态一致，新 execution 正常 |
| TCM2.S8 | Sandbox-local fetch | `network=sandbox` 脚本请求受控 fixture；fixture 返回值与 fetch progress 均正确 | fixture peer/egress identity 映射到该 Session Sandbox，且不等于 SaaS identity；`disabled` 对照组没有 fixture 请求 |
| TCM2.S9 | Sandbox-local 大结果处理 | Runner 读取大 fixture、过滤/聚合后只返回小 JSON；后续 model request 不含正文 sentinel | Runner/Sandbox 身份、Session Message 与 provider request 审计共同证明数据未回流 SaaS 解释器或模型上下文 |

## 6. 清理与结果记录

每条执行记录追加于此；历史记录保留原样，最新在上。

### 2026-10-10 状态核对与覆盖评估（未跑新 E2E）

#### 补充执行（2026-10-10 晚）：Sandbox executor S2 + progress E2E ＋ S4/S6/S7/S8

**脚本 1：`code-mode-sandbox-s2.mjs`**（隔离容器 `OPENCODE_CODEMODE_EXECUTOR=sandbox` + 本地 OpenSandbox + deepseek-v4-flash），**15 项断言全绿**：

| 断言 | 结果 |
|---|---|
| 沙箱前置（node v24 + supergateway）/ fixture 安装 / MCP 注册 / 就绪门控 | ✅ |
| **S2 核心**：execute 终态 completed（经 Runner）、`Echo: <哨兵>` 回传、`metadata.toolCalls` 审计 `echo.echo completed` 且 input 哨兵一致、无 error | ✅ |
| SSE：execute input.started、**progress×2 且内容含 echo.echo 子调用**、success | ✅ |
| TCM2.12 关联：MCP 删除 204；session 清理零残留 | ✅ |

**脚本 2：`code-mode-sandbox-s3468.mjs`**（同环境），S4/S6/S7/S8 分级结果：

| 项 | 结果 | 证据 |
|---|---|---|
| S6 nonce/owner | 🔴 **RISK（产品缺口可复现）** | 沙箱内无握手直连 `ws://127.0.0.1:9911` 发 execute 帧被接受并返回 `execution.result`——任意沙箱进程可驱动代码执行 |
| S4 幂等 | 🔴 **RISK（产品缺口）** | 重复 execute 帧（同 executionID）首测未触发新 tool.call；但 `runner.ts` L166 对每个 `tool.call` 直接执行、无 `(executionID, ordinal)` 结果缓存——重复帧将重复触发有副作用工具 |
| S7 进程恢复 | ✅ | execute 长任务中 kill Runner daemon → execute 收敛 `error` 终态；下一轮 execute 重新拉起 daemon（flock 幂等启动）并 `completed` |
| S8 egress identity | ✅ | 观测容器（bridge 网络）记录：沙箱 shell 与 execute 的 fetch **同源 192.168.215.6（该沙箱容器）**，≠ SaaS 容器 192.168.215.4——`network=sandbox` 沙箱本地 egress 属实。⚠️ 首版用 `host.docker.internal` 的断言作废（macOS Docker 下所有容器都呈现 127.0.0.1，无鉴别力） |

> 过程发现的测试方法要点（已写入脚本）：MCP 注册后就绪门控必需；模型需 harness 约束 + form 自动应答（实测两模型均出现过探索/提问卡轮，失败形态 `form.cancelled + execution.interrupted`）；S8 观测必须用同网络观测容器。

#### 状态核对（日间）

每条完整 E2E 执行记录按下表登记：

| 日期 | 镜像/commit | executor/network | 数据库/Sandbox 环境 | 模型 | 自动化结果 | HTTP + PG E2E | 阻塞/失败证据 |
|---|---|---|---|---|---|---|---|
| YYYY-MM-DD |  | server |  |  |  |  |  |

| 项 | 结果 | 说明 |
|---|---|---|
| Session MCP API 可用性 | **已解除 2026-09-28 的 BLOCKED** | `/api/session/:id/mcps` 系列路由已在当前源码实现并经审计套件长期使用（mcpDefinition CRUD + E2E）；TCM2.4/2.4a/2.12 的 fixture 阻塞原因消失，可复跑 |
| Sandbox executor 基础链路 | **已有 E2E 证据** | builtin-agents runtime T62.11（2026-10-09，`OPENCODE_CODEMODE_EXECUTOR=sandbox` + 本地 OpenSandbox）：`execute` 纯代码成功、SSE 记录 input.started/success、PG 正常——覆盖 S1 与 S2 的"无子工具"子集 |
| Sandbox executor 剩余缺口 | 未验收 | S2 完整形态（Runner tool.call → SaaS dispatch）、S4 幂等、S6 nonce、S8 egress、PG ledger（见上方覆盖矩阵） |
| TCM2.1 CodeMode 包 | 1268 pass / **2 fail**（与 09-28 相同） | `RegExp > String methods lastIndex`（stdlib.test）与 `OpenAPI.fromSpec > converts representative operations`（openapi.test）为既有测试缺陷，非新回归；OpenAPI 适配器无产品接线（见覆盖矩阵），其失败不阻塞 SaaS 验收 |
| TCM2.2 Core codemode 单测 | 21 pass / 0 fail（4 文件抽测） | 与 09-28 基线一致 |

### 本次执行记录（2026-09-28）

| 检查 | 结果 | 证据/说明 |
|---|---|---|
| 本地 PG 连通性 | PASS | `opencode-v2-up` 可连接；存在 `session_v2`、`session_message`、`sandbox` 表；未发现 `code_mode_executions` 表 |
| Docker SaaS 容器健康 | PASS | `opencode-saas-test` 状态 `running healthy` |
| Core 相关单测 + typecheck | PASS | 10 个相关测试文件 **126 pass / 0 fail**；Core typecheck 通过 |
| Core CodeMode/Runner/Tool 重点用例 | PASS | **10 pass / 0 fail** |
| CodeMode 全包 | FAIL | **1268 pass / 2 fail**：RegExp String methods `lastIndex`；OpenAPI fixture `skipped` 数量 |
| Core 全包 | FAIL | **5681 pass / 52 skip / 30 fail / 3 errors**；失败涉及 MCP、Session、Shell、PluginSupervisor、GitHub Copilot 网络依赖与 Watcher 等多个区域 |
| Server typecheck | PASS | `bun run --cwd packages/server typecheck` 通过 |
| V2 HTTP + PG E2E | PASS（认证/API/PG 基础路径） | Basic Auth 配置后，V2 CLI `GET /api/info`、创建 Session、写入 Session Sandbox 文件、提交 prompt、读取 Session Message 与本地 PG 均成功 |
| 新增真实场景脚本静态检查 | PASS | 从文档提取的 15 个 Bash 代码块通过 `bash -n`；PG `session_message.data::jsonb` 查询表达式在本地库执行成功 |
| E2E MCP fixture | PASS（本地协议烟测） | 新增 `fixtures/echo-mcp.mjs`、`fixtures/workitems-mcp.mjs`；Node 语法检查通过，stdio initialize、tools/list、search_open、get_issue 返回符合固定数据的 JSON-RPC 响应 |
| 无提示词 Code Mode 触发观察 | 未触发 | Session `ses_f1777dd36ffebz6Klg8dVRRQS4`，DeepSeek V4 Flash；多文件 issue 汇总结果正确（open=4、高优先级=3），但 assistant 只调用 4 次 `read`，没有 `execute` Tool part。PG 用户消息 seq 2、assistant tool 消息 seq 9、最终回复 seq 30。一次运行只能说明该任务本次未触发，不能代表所有任务 |
| 显式 execute 冒烟 | PASS | 同一 Session 用户消息 seq 39 后，assistant seq 45 调用 `execute`，`state.status=completed`、输入 `return 2 + 2`、输出 `4`、`metadata.toolCalls=[]`；assistant 最终回复 seq 54。证明该部署上 execute 路径可用，但不证明模型会自然选择它 |
| TCM2.4a / TCM2.4b 模型场景 | BLOCKED | 当前 `14096` 部署的 OpenAPI 没有 `/api/session/{sessionID}/mcps` 与 `/api/session/{sessionID}/mcps/{name}` 路由；按当前版本的 Session MCP endpoint 注册 fixture 得到 404，因此无法执行原设计的 MCP 正向/负向场景。部署 OpenAPI 的 prompt schema 也没有 `model` 字段；模型须在 Session 创建时设置。当前代码协议定义包含 prompt model 和 Session MCP 字段，需部署与当前源码一致的镜像后复测 |
| Sandbox executor E2E | BLOCKED | 当前缺 execution/call PG ledger，且 SaaS prompt → Runner → Tool Gateway 尚未接通；不得记为通过 |

### 本轮完整用例复跑（2026-09-28）

执行环境：`opencode-saas-test`（Docker，`http://localhost:14096`，Basic Auth）、本地 PG `opencode-v2-up`、Session 模型 `Yd-DeepSeek/deepseek-v4-flash`。本轮新建的五个 Session 均已通过 V2 DELETE 清理，PG 中对应 `session_v2` 记录为 0。

| 用例 | 结果 | 本轮证据 / 阻塞 |
|---|---|---|
| TCM2.1 CodeMode package 单测 | FAIL | `bun run --cwd packages/codemode test`：1268 pass / 2 fail。失败为 `RegExp > String methods read and update lastIndex like exec` 和 `OpenAPI.fromSpec > converts representative opencode operations into the expected tool shape`；其余 CodeMode 测试通过 |
| TCM2.2 Core Code Mode / Sandbox 单测 | PASS | Core typecheck 通过；文档指定的 10 个测试文件 126 pass / 0 fail |
| TCM2.3 V2 Session message readback | PASS | 认证 V2 API 获取 `/api/session/{id}/message` 返回 `.data` 数组；创建 Session 与读取通过 |
| TCM2.4 显式 execute + echo MCP | BLOCKED | 显式 execute 路径以无外部工具脚本实测通过（见下方）；但完整 echo MCP 用例被 Session MCP API 缺失阻塞：`GET /api/session/{id}/mcps` 返回 HTTP 404 |
| TCM2.4a 无提示词 triage 自然触发 | BLOCKED | 需要注册 `workitems` Session MCP；同一 MCP API 404，无法验证本轮触发率。历史样本 `ses_f1777dd36ffebz6Klg8dVRRQS4` 未触发，不能算本轮通过 |
| TCM2.4b 简单计算负向对照 | PASS | Session `ses_f17637c4bffetzU8SeRa0fjpIq`，PG assistant 完成消息仅含文本 `391`，无 execute Tool part；断言通过 |
| TCM2.5 顺序依赖 / TCM2.6 Promise.all 工具调用 | BLOCKED（E2E） | 指定 echo MCP 未能注册（HTTP 404）；CodeMode 包 Promise 并发测试属于单测覆盖，不替代 HTTP/PG 工具编排断言 |
| TCM2.7 受限 global 错误 | PASS（部分） | Session `ses_f1762d82effeUfj9hbq9ByIgV3`；PG 中 execute `completed`，输入为 `return require("fs")`，内部输出 `ReferenceError: Unknown identifier 'require'`。子工具可捕获错误、非法语法等分支未完成 E2E |
| TCM2.8 权限过滤 / TCM2.9 CodeMode 搜索 | BLOCKED（E2E） | 需要 MCP 工具目录与真实工具调用；Session MCP API 404。相关确定性 CodeMode/Core 单测已通过，不代表 HTTP/PG 权限和目录 E2E 通过 |
| TCM2.10 低预算 / 超时配置 | BLOCKED | 需要独立启动带低预算 env 的 SaaS 容器；现有容器配置不能在线修改，本轮未重建低预算测试容器 |
| TCM2.11 中断长耗时子工具 | BLOCKED | 需要可控长耗时 MCP child tool，Session MCP 注册路由缺失 |
| TCM2.12 MCP 删除与 Session 清理 | BLOCKED（MCP 删除） | Session DELETE 清理已实测成功；MCP 注册/删除端点在当前部署缺失，不能验证 MCP 目录移除 |
| TCM2.13 Sandbox 文件隔离 | PASS | 两个 Session 的 shell 分别写入同路径唯一内容；PG 中 A 读到 `A-only`、B 读到 `B-only`，隔离断言通过 |
| TCM2.14 图片 / 附件结果 | SKIPPED | 当前未配置可复核的图片 MCP fixture 与支持图片输入的测试 Provider |
| TCM2.15 Network capability 开关 | BLOCKED（历史） | 当时仅规划 `disabled` / `server` 对照，尚未有 Sandbox Runner 直连 fetch 实现；当前用例定义见 TCM2.15 与 TCM2.S8 |
| TCM2.S1–S8 Sandbox executor | BLOCKED（历史） | 当时 Sandbox Runner 尚未接入 SaaS execute dispatch；当前 Runner 路径需按 S1–S8 重新执行 HTTP/PG E2E |

本轮新增的核心执行证据：Session `ses_f1763bf5fffedTEoDhttRSoaJv` 的 PG assistant seq 5 有 `execute` Tool part，state 为 `completed`，input.code 为 `return 2 + 2`，content 为 `4`，metadata.toolCalls 为空。该证据验证显式 execute 在当前部署可触发且执行正确；不证明其已在 Sandbox 执行，也不证明模型会对业务任务自然选择 Code Mode。

关键部署阻塞依据：当前容器 `opencode-saas-test` 由 V2 CLI 成功完成认证、`GET /api/info` 与创建 Session；但对新建 Session 的 `GET /api/session/{sessionID}/mcps` 返回 HTTP 404。故依赖 Session MCP 的多工具模型 E2E 本轮均未计为 PASS。

### 当前源码镜像复测（2026-09-28，后续覆盖旧镜像阻塞项）

为排除旧镜像影响，以当前工作区构建 `opencode-saas-codemode-e2e:local`，独立运行于 `14099`；健康检查通过。用本地 PG `opencode-v2-up`、DeepSeek V4 Flash 测试。另起限额实例 `14100`（timeout=1500ms、tool calls=2、steps=20、output=64 bytes、network=disabled）及工具调用预算实例 `14102`（tool calls=2、steps=1000）。测试 fixture 通过 shell API 按 Session 安装，未依赖 Sandbox 预置仓库。测试完成后清理了临时 Session 和容器。

| 用例 | 当前源码镜像结果 | HTTP、执行路径与 PG 证据 |
|---|---|---|
| V2 MCP API + fixture bridge | PASS | `GET /api/session/{id}/mcps` 返回 200；安装 fixture 后 `POST` 注册成功；`SessionMcps` 在 Sandbox 启动 `supergateway` 并完成工具发现/调用。旧镜像 404 已证实为部署版本差异 |
| TCM2.4 显式 execute + echo | PASS | Session `ses_f175f154bffeZWF0jQ7l3Idv1u`；PG seq 13 execute completed，调用 `echo.echo({message:"v2-single"})`，子调用 completed，输出 `Echo: v2-single` |
| TCM2.4a 无提示词自然触发 | PASS，3/3 | Sessions `ses_f175be354ffeFYJEqNrr6X7vOc`、`ses_f175b1ae4ffe2K3Yr2nAeiHmD8`、`ses_f175af0ceffe1FGtcuRmUNH770`。每个 Session 均自然生成两次 execute：先 `workitems.search_open`，再 `Promise.all` 查询 OPS-101/102/103；PG 子调用全 completed，最终 JSON 均为 openCount=3、highPriorityCount=2、highPriorityIssues=[OPS-101, OPS-103] |
| TCM2.4b 简单计算负向对照 | PASS | Session `ses_f17502350ffeVL1eUkccYav4CZ`；挂载 workitems MCP 仍未触发任何工具，PG 最终文本为 `391` |
| TCM2.5 顺序依赖 | PASS | Session `ses_f175a3b0fffeiqgmMy3GK50Z8I`；PG calls 顺序为 `v2-first` 后 `Echo: v2-first`，最终 `Echo: Echo: v2-first` |
| TCM2.6 Promise.all / 总调用预算常规值 | PASS | Session `ses_f175a0891ffeOwlCdYVXhyyTVm` 的 3 调用与 `ses_f1759e741ffeA261hSRONflNVO` 的 12 调用均 completed，input/result 一一匹配 |
| TCM2.7 子工具错误捕获 | PASS | Session `ses_f17595510ffemy2yAWYRqlsxcq`；缺少必填 message 的 `echo.echo` 在 PG metadata 为 error，脚本 catch 后 execute completed；同 Session 后续 deny/remove 检查也成功 |
| TCM2.8 deny / allow 快照 | PASS | deny 后 `search({query:"echo"})` 返回空、直接调用为 `Unknown tool 'echo.echo'` 且无 MCP 调用；更新为 allow 后新 prompt 搜索到工具并成功调用，PG child call completed |
| TCM2.9 CodeMode search | PASS | 当前 Session 快照中搜索结果为 `tools.echo.echo`；MCP 删除后新 prompt 搜索返回空 |
| TCM2.10 step / output / tool-call / timeout budgets | PASS | steps=20 时有限 100 次循环返回 `Execution exceeded the 20-step limit`；64-byte 输出含 `[result truncated: ...]`；tool calls=2 时三调用脚本只准入前两次，第三次触发 `Execution exceeded its tool-call limit of 2`；delay fixture 10 秒调用在 1500ms 后返回 timeout，PG execute/child tool 均终态 |
| TCM2.11 Session interrupt | PASS | Session `ses_f1751898affezVbi6SZ0Ut6cf3`；等待 execute 为 running 后调用 V2 interrupt，API 返回 `interrupted:true`，PG execute state 为 `error`、error.type=`aborted`，delay child call 为 error |
| TCM2.12 删除 MCP | PASS | 对 `echo` 执行当前 Session MCP DELETE 后 GET 列表为空；下一次 execute 的搜索结果为空 |
| TCM2.13 Session Sandbox 文件隔离 | PASS（前一轮） | Session `ses_f176335fdffecf3KRsKhUfHbZZ`、`ses_f176331c5ffeQYHirnPXsxNjJT` 分别读到 `A-only`、`B-only`；由 shell Tool Message PG 记录验证 |
| TCM2.15 network disabled / server | PASS（历史 server 基线） | disabled 实例 `14100` 的 execute 读取 fetch 得 `Unknown identifier 'fetch'`；server 实例 `14099` fetch 本地受控 HTTP fixture 成功返回 `codemode-network-ok`，PG progress 记录 GET URL；不证明 Sandbox-local fetch |
| TCM2.14 图片 / 附件 | SKIPPED | 本轮无受支持的图片输入 Provider 与图片 MCP fixture |
| TCM2.S1–S8 Sandbox CodeMode executor | BLOCKED（历史） | 当时源码中 CodeMode 仍走服务端 executor；当前 Sandbox Runner 路径需按 S1–S8 重新执行 HTTP/PG E2E，Runner → Tool snapshot callback 与 execution/call PG ledger 验收仍未完成 |

### Sandbox 大数据与大目录复测（2026-09-29，含模型请求审计）

复测在上述基础上开启 `OPENCODE_MODEL_REQUEST_LOG=/audit`（宿主目录 `/tmp/codemode-audit`），并改用 `run-audit-e2e.mjs` 驱动，因此下列结论基于**真实 provider 请求**而非仅持久消息。

| 用例 | 结果 | 本轮证据 |
|---|---|---|
| TCM2.4c 大中间结果聚合 | PASS | Session `ses_f15399cf5ffeQfpwb2yDQ3u80P`。3 条 agent 轮次请求全部 `truncated=false`；execute `completed`，聚合结果 total=1000/even=500/odd=500；**每条**请求的 messages 均不含 `BODY-SENTINEL`；第二轮请求确实携带第一轮聚合 JSON（`firstThreeTitles`）与第二条 prompt，但不含大正文；PG 侧 sentinel 计数 0 |
| TCM2.9a 大目录按需发现 | PASS | Session `ses_f15396710ffed0kbyldgYkvoFl`。2 条 agent 轮次请求的原生 tool definitions 为 13 个直接工具（`ccr_retrieve,edit,glob,grep,question,read,shell,skill,subagent,webfetch,websearch,write,execute`），**无任何 `inventory.*`**；catalog 实测 `inventory 8/201`、`browser 7/44`，即有界摘要而非全量展开；execute 经 `search` 只调用 `inventory.lookupBySKU` 并返回固定结果 |
| TCM2.S9 Sandbox-local 大结果处理 | PASS | 复用 4c 的同一 Session 证据链：Sandbox Runner 聚合 + provider 请求审计 + PG sentinel 检查三者同时成立，可判定大正文未回流模型上下文 |
| 审计能力单测 | PASS | `test/session-model-request-log.test.ts` 4 pass：默认关闭、凭据与 provider 设置不落盘、按 Session 分行、32 MiB 降级为 `truncated` |

审计过程中修正的两处自身缺陷：等待函数原先不区分轮次，会在上一轮未完成时提交下一轮，使"后续请求无 sentinel"成为假通过；现按轮次比较新 assistant 消息，并强制断言最后一条 prompt 出现在被审计请求中。

### Sandbox 大数据与大目录复测（2026-09-29，首轮，审计上线前）

执行环境：当前工作树构建的 `opencode-saas-codemode-current:local` 与 `opencode-opensandbox:codemode-local`，本地 OpenSandbox `http://host.docker.internal:8080`、PG `opencode-v2-up`、DeepSeek V4 Flash。SaaS 明确设置 `OPENCODE_SANDBOX_ENABLED=true`、`OPENCODE_SANDBOX_PROTOCOL=http`、`OPENCODE_CODEMODE_EXECUTOR=sandbox`（默认）。

| 用例 | 结果 | 本轮证据 / 未满足项 |
|---|---|---|
| Runner >1 MiB tool.result transport | PASS（定向容器验证） | 原 `maxPayload=1 MiB` 在 1,000 条大结果时复现 `RangeError: Max payload size exceeded` 并导致 daemon 退出；提升到 16 MiB 且处理 socket error 后，同一 Runner 镜像聚合 1,000 条并返回 `{count:1000,first:0}` |
| Runner gateway readiness | PASS | OpenSandbox 对未监听端口也返回 resolved endpoint，曾导致 `Code Mode Runner connection closed before completion`；修复为始终执行幂等 launcher。Core `codemode-runner.test.ts` 覆盖 resolved endpoint 情况 |
| TCM2.4c 大中间结果聚合 | BLOCKED（部分通过，已被上节取代） | 首轮仅验证 Sandbox execute 与 PG 侧结果，缺 provider 请求审计，无法检查第二轮模型请求。已在审计上线后重跑并判为 PASS |
| TCM2.9a 大目录按需发现 | BLOCKED（部分通过，已被上节取代） | 首轮仅验证 `search` 结果与目标工具调用，缺 provider 请求审计。已重跑并判为 PASS |
| TCM2.S9 Sandbox-local 大结果处理 | BLOCKED（部分通过，已被上节取代） | 首轮缺 provider 请求审计与后续轮次断言。已重跑并判为 PASS |

以上五个本轮临时 Session 已通过 V2 `DELETE /api/session/:id` 清理，并在 PG 验证对应 `session_v2` 记录数为 0；独立 SaaS 与 Runner 测试容器已移除。

**触发结论**：在同一模型、同一 prompt 下，未提及 execute/Code Mode 的 triage 任务自然触发率为 **3/3（本轮样本）**，且执行结果与固定 fixture 完全一致；简单计算负向对照为 **0 次 execute**。样本量仅 3，不能据此声称总体触发率为 100%。

**默认状态说明**：默认 Tool snapshot 未配置 deny 时会暴露 `execute`；自然触发样本实际证明模型可发现并选择该工具。前述自然触发 HTTP/PG 样本是在显式 server executor 基线中运行，不能证明当前默认 Sandbox executor 的 HTTP/PG 端到端行为。

Core 全量日志：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/opencode-core-tests-rerun.log`。CodeMode 全量日志：`/private/var/folders/zk/8qd0lv657wn8kvpp__hwjj400000gn/T/codemode-full-test.log`。

### 本轮全量复跑（2026-10-01，含 flock 锁缺陷修复）

环境：镜像 `opencode-saas-sandbox-test:latest` 由当前工作区构建；`opencode-saas-test`（`http://localhost:14096`，Basic Auth）、本地 PG `opencode-v2-up`、OpenSandbox `host.docker.internal:8080`、`Yd-DeepSeek/deepseek-v4-flash`。`OPENCODE_CODEMODE_EXECUTOR` 未设置（默认 sandbox）。审计/低预算/网络对照分别用独立临时实例（14098/14101/14103）。所有临时 Session 与实例均已清理，PG Session 数回到基线。

#### 过程中发现并修复的缺陷：Runner 启动锁被守护进程继承

- 现象：同一 Session 内第 2 次及以后的 `execute` 稳定失败，`state.error.message = "Failed to start Code Mode Runner: Command exceeded timeout of 10000 ms."`（`error.type=tool.execution`）；单 execute 场景全部正常。TCM2.4a 首轮 6 连败、TCM2.8-allow 两轮连败、最小复现（`return 11` → `return 22`）三连败，均可稳定复现。
- 根因：`packages/core/src/codemode/runner.ts` 的启动器 `flock -x <pid.lock> -c '<启动脚本>'` 中，锁 fd 被 `nohup` 起的守护进程继承；守护进程存活期间一直持有排他锁，后续每次启动器 `flock -x` 阻塞直至 `timeoutMs: 10_000` 超时。沙箱内直接证据：`/proc/<runner-pid>/fd` 存在 `3 -> /tmp/opencode-codemode-runner.pid.lock`。4a 中模型 `kill` 掉 runner 后下一次 execute 立即成功，与该机制完全吻合。
- 修复：`startCommand()` 改为 `flock -x -o`（`-o` 在执行命令前关闭锁 fd，阻止继承），并在 `packages/core/test/codemode-runner.test.ts` 增加回归断言（`flock -x -o`），该文件 7/7 通过。
- 修复验证：重建镜像后同一 Session 连续三次 execute 全部 completed；TCM2.8 双断言 PASS；TCM2.4a PASS。预热轮内 4 个连续 execute 亦全部 completed，证明 runner 可反复复用。

#### 结果汇总

| 用例 | 结果 | 本轮证据 / 说明 |
|---|---|---|
| TCM2.1 CodeMode package 单测 | FAIL（既有） | 1268 pass / 2 fail，与 2026-09-28 记录一致：`RegExp > String methods ... lastIndex`、`OpenAPI.fromSpec ... skipped` 数量（5→9，V2 API 端点数变化），均与 Code Mode 无关 |
| TCM2.2 Core Code Mode / Sandbox 单测 | PASS | Core typecheck 通过；文档指定 15 个测试文件 164 pass / 0 fail（含本轮新增 runner 回归测试后 165） |
| TCM2.3 V2 接口与消息 readback | PASS | `POST /api/session`、`GET /api/session/:id/message`（`.data` 数组）、`DELETE` 204 |
| TCM2.4 显式 execute + echo MCP | PASS | `metadata.toolCalls == [{"tool":"echo.echo","status":"completed","input":{"message":"v2-single"}}]`，输出 `Echo: v2-single` |
| TCM2.4a 无提示词自然触发 | PASS（修复后） | 修复 runner 锁后多轮验证：编排链 `workitems.search_open` → `workitems.get_issue`×3 全 completed，无 error 调用；最终 JSON `repository=acme/api, openCount=3, highPriorityCount=2, highPriorityIssues=[OPS-101, OPS-103]`。修复前因锁缺陷出现 6 连败 + 模型自我修复（kill runner），符合文档"自修复可过"条款但当时 JSON 形态不符已按文档断言 FAIL 记录 |
| TCM2.4b 简单计算负向对照 | PASS | 无 execute part；最终文本 `391` |
| TCM2.4c 大中间结果聚合（审计） | PASS | 独立审计实例；3 条 provider 请求全部 `truncated=false`，messages 均不含 `BODY-SENTINEL`；第二轮携带第一轮聚合结果；PG 持久消息 sentinel 计数 0 |
| TCM2.5 顺序依赖 | PASS | calls 顺序 `v2-first` → `Echo: v2-first`，第二次 input 精确依赖第一次返回值 |
| TCM2.6 Promise.all 并发 | PASS | 3 路并发 echo 全部 completed，input 一一对应 |
| TCM2.7 子工具错误 / 脚本错误 | PASS | 7a：缺参 `echo.echo` 在 metadata 记为 error、脚本捕获后 execute completed；7b：`return require("fs")` → `ReferenceError: Unknown identifier 'require'` 且 `metadata.error=true`（该子项存在模型不调用 execute 的波动，强化措辞后稳定复现） |
| TCM2.8 deny/allow 快照 | PASS（修复后） | deny：`echo_echo` 无成功调用；allow：新 prompt 新快照成功调用 `after-allow`。修复前的失败均为 runner 锁超时（最终文本含确切错误），非权限回归 |
| TCM2.9 search 可见性 | PASS | `search({query:"echo"})` 返回 `tools.echo.echo` |
| TCM2.9a 大目录按需发现（审计） | PASS | 原生 tool definitions 无任何 `inventory.*`；catalog `inventory 8/201`、`browser 7/44`；仅调用 `inventory.lookupBySKU` |
| TCM2.10 预算 | steps PASS / output PASS / timeout PASS / tool-call **BLOCKED** | steps=20 → `Execution exceeded the 20-step limit`；output=64B → `[result truncated:`；timeout=1500ms → execute 进入终态（符合本用例断言口径）。tool-call 子项三次尝试均因**新起低预算实例上 Session MCP 未进入 Code Mode 工具清单**（search 空/`Unknown tool 'echo.echo'`，45s 沉降 + 预热轮后 CCR browser 工具已在而 echo 仍缺）无法触发限额路径，按 BLOCKED 记录；限额行为由单测覆盖 |
| TCM2.11 Session interrupt | PASS | interrupt 返回 200；execute `error` 终态（`error.type=aborted`）；等待中的 child call 未完成；另一 Session 并发执行不受影响 |
| TCM2.12 删除 MCP | PASS | DELETE 204；GET 列表为空；删除后 `search` 不再返回 echo |
| TCM2.13 沙箱文件隔离 | PASS | A/B Session 分别读到 `A-only` / `B-only` |
| TCM2.14 图片/附件 | SKIPPED | 无图片输入 Provider 与图片 MCP fixture |
| TCM2.15 网络 capability | PASS（功能）/ 观察受限 | disabled：`Unknown identifier 'fetch'`；sandbox（默认）：fetch 受控 fixture 成功且 progress 记录；server（显式 executor=server）：同样成功。egress identity 区分在本地 OrbStack 统一 NAT（peer 均为 127.0.0.1）下不可判定，符合本节"统一 NAT 不足以证明来源"的既有口径 |
| TCM2.S1–S8 | 维持 BLOCKED | §5 门槛未变（无 PG execution/call ledger、nonce/owner 校验）；S9 的等价证据链（Sandbox 聚合 + provider 请求审计 + PG sentinel）已由 TCM2.4c 满足 |

#### 本轮观察项（未判 FAIL，需产品侧评估）

1. **中断不保留 in-flight 子调用记录**：sandbox executor 下 interrupt 后 `state.metadata.toolCalls` 为空（`runner.ts` abort 立即 `finish(new Error)` 关闭连接，不回传最终 progress）。与 2026-09-28 server executor 时代"child call 记为 error"的观察不同；本用例文档断言不受影响，但可审计性下降，建议 abort 前先落一条最终 progress 或在 error state 保留最后已知 toolCalls。
2. **新起实例 Session MCP 冷启动**：全新实例上 Session MCP 工具可能长时间不进入 Code Mode 工具清单（内置/CCR 工具正常），长运行实例无此问题。影响低预算等需要独立实例的场景；建议为 Session MCP 桥接增加就绪探测/重试。
3. **主容器两次非预期退出（exit 130）**：均发生在高强度 Code Mode E2E 期间，退出前日志出现 `postgres.js TimeoutNegativeWarning: -10681ms`（负数超时，系统时钟回拨特征）。疑与时钟跳变相关的 PG 重连风暴，未定位到根因，需环境侧关注。

#### 本轮测试方法修正（已回写到正文）

- 2.3 新增 `wait_for_turn_idle`：回合可能链式多次 execute，"首条 assistant completed"不代表回合结束，聚合断言前必须等 `idle` 消息。
- TCM2.4a 断言改为聚合整轮 execute（历史"两次 execute"模式下旧断言永远取不到 search_open），最终 JSON 从回合末尾纯文本 assistant 消息读取（不在最后一个 execute 的 content 里），剥离 ```` ```json ```` 围栏，`highPriorityIssues` 接受编号或对象两种形态。
- TCM2.10 增加就绪门控：预算断言前必须先确认 `search` 能看到目标工具，否则记 BLOCKED，避免把"工具未就绪"误判为限额行为（本轮三次误判根源）。
- TCM2.11 子调用断言对齐文档口径（未完成 + 无副作用），不再强求 error 记录。

结果只能标记为 `PASS`、`FAIL`、`BLOCKED` 或 `SKIPPED`：

- `PASS`：预期行为、执行路径和持久化断言全部满足。
- `FAIL`：可复现的行为与契约不符，附请求、日志和 PG 证据。
- `BLOCKED`：功能/环境前置条件缺失；列明缺少项，不计通过。
- `SKIPPED`：可选 provider 或凭据不可用；注明原因，不计通过。
