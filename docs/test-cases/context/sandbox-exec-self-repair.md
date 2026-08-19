# 沙箱 Exec 失败自修复（exec-failed → code-agent 自修复）

> 验证沙箱 exec 失败自修复（`/exec/async` + `repairOnFailure: true` 时：自动落盘完整输出、发布事件、触发主会话 Agent 自修复闭环）。同步 `/exec` 失败不触发（结果直接返回调用方）。

## 功能背景与效果

沙箱 exec（`POST /session/:sessionID/exec` 同步、`POST /session/:sessionID/exec/async` 异步）执行命令失败时：同步接口的失败结果（exitCode / stdout / stderr）直接随 HTTP 响应返回给调用方，调用方自行处理，**不触发**自修复；异步接口在后台执行，调用方无法即时感知失败，因此提供**由调用方显式开启**（请求体 `repairOnFailure: true`）的自修复能力：完整输出（不受 64KB 限制）落盘到沙箱内文件，并通过事件驱动让**主会话 Agent**自动介入：分析失败、修改代码、重试命令——形成自修复闭环。

| 能力 | 效果 |
|------|------|
| 完整输出落盘 | 失败时 stdout+stderr 完整写入沙箱 `/workspace/.opencode/exec-logs/<execId>.log`，**不截断** |
| Agent 可检索 | 落盘路径回传给主会话 Agent，Agent 用 Grep / Read（沙箱路径映射）按需检索，勿整读 |
| 事件驱动触发 | 失败 → GlobalBus 发布 `server.sandbox.exec.failed` → 全局监听器按 directory 路由到对应实例，注入修复 prompt |
| 错误模式匹配 | 内置模式（error/exception/traceback/failed/EADDRINUSE/…）；非零退出码 + 命中模式才触发，避免误报（如 grep 无匹配 exit 1） |
| 防死循环 | 同一 (sessionID, command) 最多触发 3 次自修复，超过则不再注入 |
| Agent 自行重试 | 修复后由 Agent 自己调用 bash/shell 工具重跑命令，系统不代为重试 |
| 仅异步 opt-in | 同步 `/exec` 失败**不触发**（结果直接返回）；异步 `/exec/async` 仅当请求体 `repairOnFailure: true` 时触发，默认不触发 |
| 优雅降级 | 沙箱不可达时跳过落盘，仍发布事件（outputPath 为空）；监听失败不影响 exec 响应 |

## 触发判定

- **接口与开关**：仅 `/exec/async`（异步）且请求体 `repairOnFailure: true` 时进入失败检测；同步 `/exec` 与未带开关的异步失败**不触发**（也不落盘）
- **必要条件**：`exitCode !== 0` 或 `status ∈ {failed, timed_out, killed}`
- **充分条件**：stdout/stderr 合并文本命中内置错误模式之一（大小写不敏感）
- 二者同时满足才触发；仅非零退出码（无错误特征）不触发，避免对 `grep` 无匹配（exit 1）等良性场景误报

内置错误模式（正则，大小写不敏感）：`error`、`exception`、`traceback`、`failed`、`fatal`、`not found`、`no such file or directory`、`command not found`、`cannot find module`、`out of memory`、`segmentation fault`、`bus error`、`permission denied`、`undefined is not`、`is not defined`、`panic`、`timeout`、`exit code [1-9]`、`E[A-Z]+`（Node 系统调用错误如 EADDRINUSE/EACCES/ENOENT）。

## 实现位置

| 模块 | 内容 |
|------|------|
| `packages/opencode/src/sandbox/exec-failed.ts` | 事件 schema、内置错误模式、`detect`/`summarize`、`writeLog`（沙箱内落盘）、`maybeTrigger`（编排：取 sb → 落盘 → 发布）、`publish`（GlobalBus） |
| `packages/opencode/src/server/sandbox-proxy.ts` | `ExecBody` 定义 `repairOnFailure` 可选参数；仅 `/exec/async` 失败分支且 `repairOnFailure === true` 时调用 `ExecFailed.maybeTrigger`；`/exec`（同步）失败分支不调用（结果直接返回调用方）；async 改用全量 `result.logs` 而非截断 `state.stdout` |
| `packages/opencode/src/sandbox/exec-repair.ts` | 全局监听器（`makeGlobalNode`）：订阅 GlobalBus、按 directory 通过 `InstanceStore.provide` 路由到对应实例、按 (session,command) 限 3 次、`bridge.fork(SessionPrompt.prompt)` 注入修复消息 |
| `packages/opencode/src/server/routes/instance/httpapi/server.ts` | app group 挂载 `ExecRepair.node` |

## 落盘路径

| 位置 | 路径 |
|------|------|
| 沙箱内（Agent 实际访问） | `/workspace/.opencode/exec-logs/<execId>.log` |
| 宿主机映射（诊断/外部调用） | `<hostWorkdir>/.opencode/exec-logs/<execId>.log` |

修复 prompt 向 Agent 提供沙箱路径 `/workspace/...`；Agent 的 Grep / Read / bash 工具可直接访问该文件。宿主路径仅用于外部诊断，不进入修复 prompt。

## 公共配置

```bash
# 加载 SaaS 测试环境（提供 $BASE/$PG_URL/$MODEL，见 docs/test-cases/test-env.sh）
source ../test-env.sh 3 && source ../test-lib.sh
```

## 验收层级

| 层级 | 用例 | 验证目标 |
|------|------|----------|
| L0 单元 | T-EX.1 | `detect`/`summarize` 纯函数：错误模式匹配、tail 截断、良性场景不触发 |
| L0 单元 | T-EX.2 | `maybeTrigger`：失败落盘 + 发布事件；成功 no-op；沙箱不可达仍发布 |
| L0 单元 | T-EX.3 | 监听器：directory 过滤、(session,command) 限 3 次、注入 prompt |
| L1 落盘 | T-EX.4 | 同步 `/exec` 失败**不触发**自修复、不落盘（结果直接返回） |
| L1 落盘 | T-EX.5 | 异步 `/exec/async` + `repairOnFailure: true` 失败后沙箱内生成完整输出文件（含超 64KB） |
| L1 落盘 | T-EX.5b | 异步 `/exec/async` 不带 `repairOnFailure` 失败后**不**注入、**不**落盘 |
| L2 事件 | T-EX.6 | 失败发布 `server.sandbox.exec.failed`，成功不发布 |
| L3 自修复 | T-EX.7 | Agent 收到修复 prompt、引用落盘路径、改代码、重试命令 |
| L4 防死循环 | T-EX.8 | 同 (session,command) 第 4 次失败不再注入修复 prompt |
| L5 误报 | T-EX.9 | 非零退出但无错误特征（grep 无匹配）不触发自修复 |
| L6 降级 | T-EX.10 | 沙箱不可达（destroyed）时 exec 失败仍发布、outputPath 为空 |
| L3 实战 | T-EX.11 | Agent 修复实际 JavaScript 未定义变量并重跑成功 |
| L3 端到端 | T-EX.12 | Vite React 项目：配置错误 → 自修复 → dev server 可达 |

## 测试用例

### T-EX.1 单元测试：detect / summarize（L0）

> 测试必须从包目录运行，不能从仓库根运行。

```bash
cd packages/opencode
bun test test/sandbox/exec-failed.test.ts
```

**期望**：12 pass / 0 fail。覆盖点：
- `detect`：error/exception/traceback/failed/EADDRINUSE/timeout 命中；exit 0 不触发；非零退出 + 无模式（grep 无匹配）不触发；stderr 噪声 + exit 0 不触发
- `summarize`：短输出原样；超 4KB tail 截断并带 `...[truncated]...` 前缀
- `writeLog`：沙箱文件 API 写入失败时，事件 `outputPath` 为空，不向 Agent 伪报日志文件存在

### T-EX.2 单元测试：maybeTrigger（L0）

```bash
cd packages/opencode
bun test test/sandbox/exec-failed.test.ts
```

**期望**：覆盖 `maybeTrigger` 三例——
- 失败：mock 沙箱记录到 `writeFiles` 调用，GlobalBus 收到事件，`directory` 路由正确，`outputPath` 文件内容含 `## stderr` 与原始错误文本
- 成功（exit 0）：不发布事件、不写文件
- 沙箱不可达（`get` 返回 null）：仍发布事件，`outputPath` 为空，`hostOutputPath` 仍由 directory 派生

### T-EX.3 单元测试：exec-repair 监听器（L0）

```bash
cd packages/opencode
bun test test/sandbox/exec-repair.test.ts
```

**期望**：3 pass / 0 fail。覆盖点：
- 同 directory 事件：连续发布 4 次同一 (session,command)，`SessionPrompt.prompt` 仅被调用 3 次（MAX_ATTEMPTS）；prompt 文本含 command 与 `full output saved to:`
- 异 directory 事件：发布到其他 directory，`prompt` 调用 0 次
- 无日志降级：`outputPath` 为空时 prompt 明确说明日志不可用，并包含失败摘要

### T-EX.4 同步 exec 失败不触发（L1）

```bash
# 创建 session 并触发沙箱创建
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"echo ready\"}],\"model\":$MODEL}" > /dev/null

# 执行一条必定失败且含错误特征的命令（同步）
EXEC=$(curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"node -e \"throw new Error(boom)\""}')
echo "$EXEC" | python3 -m json.tool
EXEC_ID=$(echo "$EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin).get('id',''))")

# 检查：不落盘 + 不注入修复 prompt
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"ls /workspace/.opencode/exec-logs/${EXEC_ID}.log 2>&1\"}" | python3 -m json.tool
curl -s --max-time 30 "$BASE/session/$SID/message?limit=50" | \
  python3 -c "import json,sys;print(sum('A sandbox command failed' in str(m) for m in json.load(sys.stdin)))"
```

**期望**：
- exec 返回 `exitCode` 非 0，stderr/stdout 含 `Error: boom`（失败结果直接返回给调用方）
- 落盘文件**不存在**（`No such file or directory`）
- 主会话中 `A sandbox command failed` 修复 prompt 计数 = 0

### T-EX.5 异步 exec 失败落盘（含超 64KB，L1）

```bash
# 生成超过 64KB 的错误输出（必须带 repairOnFailure: true）
ASYNC=$(curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"repairOnFailure":true,"command":"node -e \"for(let i=0;i<100000;i++)process.stderr.write(String(i)+\\\" Error line\\\\n\\\"); throw new Error(big)\""}')
EXEC_ID=$(echo "$ASYNC" | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")
# 轮询状态直至完成
curl -s --max-time 30 "$BASE/session/$SID/exec/$EXEC_ID" | python3 -m json.tool

# 验证落盘文件大小 > 64KB，且含尾部 "Error: big"
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"wc -c /workspace/.opencode/exec-logs/${EXEC_ID}.log; tail -5 /workspace/.opencode/exec-logs/${EXEC_ID}.log\"}" | python3 -m json.tool
```

**期望**：
- async 状态最终为 `failed`（命令执行完成但 exitCode 非 0；与 sync 一致，exitCode≠0 判为 failed）
- 落盘文件字节数 > 65536（不受 64KB 截断）
- 文件尾部含 `Error: big`

### T-EX.5b 异步 exec 不带 repairOnFailure 不触发（L1）

```bash
ASYNC=$(curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"node -e \"throw new Error(noopt)\""}')
EXEC_ID=$(echo "$ASYNC" | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")
sleep 5
# 检查：不落盘 + 不注入
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"ls /workspace/.opencode/exec-logs/${EXEC_ID}.log 2>&1\"}" | python3 -m json.tool
curl -s --max-time 30 "$BASE/session/$SID/message?limit=50" | \
  python3 -c "import json,sys;print(sum('A sandbox command failed' in str(m) and 'noopt' in str(m) for m in json.load(sys.stdin)))"
```

**期望**：async 最终 failed（exitCode 非 0），但落盘文件不存在、无 `noopt` 相关修复 prompt（默认不开启）。

### T-EX.6 事件发布验证（L2）

> 单元测试已覆盖事件发布（T-EX.2）。端到端可订阅 GlobalBus 或观察 exec_log 表：

```bash
# 失败 exec 应在 exec_log 表有记录
psql "$PG_URL" -c \
  "SELECT id, status, exit_code, LEFT(stdout, 80) AS stdout_head
     FROM exec_log WHERE session_id='$SID' AND status IN ('failed','timed_out')
     ORDER BY time_started DESC LIMIT 5;"
```

**期望**：失败 exec 行存在；成功 exec（exit 0）不进入 failed/timed_out。

### T-EX.7 自修复效果验证（L3）

```bash
# 1. 在主会话中让 Agent 写一个有 bug 的脚本（如引用未定义变量），后台运行触发修复
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"repairOnFailure":true,"command":"node /workspace/bug.js"}' > /dev/null
# bug.js 可先由一条同步 exec 创建：
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"printf '\''console.log(undefinedVar)\\\\n'\'' > /workspace/bug.js"}' > /dev/null

# 2. 观察主会话后续消息：Agent 应收到注入的修复 prompt
#    （可通过 event SSE 或轮询 messages 观察）
curl -s --max-time 60 "$BASE/session/$SID/message?limit=5" | python3 -m json.tool
```

**期望**：
- 主会话出现一条 synthetic 用户消息，文本含 `A sandbox command failed`、`command:` 原命令、`project directory:` + 从 `cd` 提取的路径、`full output saved to: <path>`、`Fix the relevant code in ...`、`background: true`
- prompt 明确标识 `/workspace` 为沙箱操作目录，并含最多 4KB 的失败摘要；Agent 先据此修复，不会因读取日志的 external-directory 权限请求阻塞。需要完整堆栈时才调用 Read/Grep 访问落盘路径。
- Agent 后续在 `/workspace` 修改 bug.js，重跑命令并验证成功

### T-EX.8 防死循环验证（L4）

```bash
# 对同一命令连续触发 4 次失败（每次重新执行相同命令，均带 repairOnFailure: true）
CMD='node -e "throw new Error(persistent)"'
for i in 1 2 3 4; do
  curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
    -H 'Content-Type: application/json' -d "{\"repairOnFailure\":true,\"command\":\"$CMD\"}" > /dev/null
  sleep 2
done
# 统计主会话中针对该命令的修复 prompt 数量
curl -s --max-time 30 "$BASE/session/$SID/message?limit=50" | \
  python3 -c "import json,sys;msgs=json.load(sys.stdin);print(sum('A sandbox command failed' in str(m) and 'persistent' in str(m) for m in msgs))"
```

**期望**：注入的修复 prompt 数量 = 3（MAX_ATTEMPTS），第 4 次失败不再注入。

### T-EX.9 误报抑制（L5）

```bash
# grep 无匹配返回 exit 1，但无错误特征 → 即使开了 repairOnFailure 也不应触发自修复
BEFORE=$(curl -s --max-time 30 "$BASE/session/$SID/message?limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"repairOnFailure":true,"command":"grep nonexistent /etc/hostname"}' > /dev/null
sleep 3
AFTER=$(curl -s --max-time 30 "$BASE/session/$SID/message?limit=1" | python3 -c "import json,sys;print(json.load(sys.stdin)[0]['id'])")
echo "before=$BEFORE after=$AFTER"
```

**期望**：`before == after`（主会话最新消息未变化，即未注入修复 prompt）。

### T-EX.10 沙箱不可达降级（L6）

```bash
# 销毁沙箱后执行命令（沙箱会被重建，但若重建失败则 get 返回 null）
curl -s --max-time 30 -X POST "$BASE/session/$SID/kill-sandbox" > /dev/null
# 立即执行一条会失败的命令
EXEC=$(curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"repairOnFailure":true,"command":"node -e \"throw new Error(down)\""}')
EXEC_ID=$(echo "$EXEC" | python3 -c "import json,sys;print(json.load(sys.stdin)['execId'])")
sleep 10
curl -s --max-time 30 "$BASE/session/$SID/exec/$EXEC_ID" | python3 -m json.tool
```

**期望**：async 状态最终 failed（exitCode 非 0）；即便落盘失败，主会话仍可能收到修复 prompt（outputPath 为空，hostOutputPath 仍由 directory 派生）。系统不崩溃，exec 响应正常。

### T-EX.11 实战：修复未定义变量并验证（L3）

```bash
# 让失败命令同时创建一个真实的可修复文件；失败后 Agent 应通过注入 prompt 修复它。
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d "{\"command\":\"printf 'console.log(undefinedVariable)\\\\n' > /workspace/repro.js\"}" > /dev/null
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"repairOnFailure":true,"command":"node /workspace/repro.js"}' > /dev/null

# 等待 Agent 修复并自行重跑后确认文件和命令结果。
sleep 10
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/repro.js && node /workspace/repro.js"}' \
  | python3 -m json.tool
```

**期望**：async 运行 repro.js 失败（stderr 含 `ReferenceError`）；主会话出现修复 prompt；Agent 读取失败日志、修改 `repro.js`，随后 `node /workspace/repro.js` exitCode 为 0。该用例验证的是完整业务闭环，不只验证 prompt 注入。

### T-EX.12 端到端：Vite React 配置错误自修复（L3）

> 验证完整闭环：创建项目 → 注入配置错误 → 触发 dev server 失败 → Agent 在沙箱修复 → dev server 恢复可达。
>
> **前置**：
> - `source ../test-env.sh && source ../test-lib.sh`
> - session 必须设置 `external_directory: /*:allow`（或 `/workspace/**`），否则 Read/Edit 工具会被权限阻塞。
> - session 必须设置 `keepAlive + boot`，保证沙箱在 Agent 修复期间不被回收。

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"permission":[{"permission":"external_directory","pattern":"/*","action":"allow"}]}' \
  | jexec "d['id']")
echo "SID: $SID"

curl -s --noproxy '*' -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true,"boot":true}' > /dev/null

# Step 1：创建 Vite React 项目并注入配置错误（单条 exec，确保原子性）
curl -s --noproxy '*' --max-time 300 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"npm create vite@latest vite-repair -- --template react && cd vite-repair && npm install && printf \"import { defineConfig } from '\''vite'\''\\nexport default defineConfig({ plugins: [brokenPlugin()] })\\n\" > vite.config.js","timeoutSeconds":240}' \
  | jexec "d.get('exitCode')"   # 期望 0

# Step 2：后台启动 dev server —— 必定失败（brokenPlugin 未定义），开启自修复
FAIL_ID=$(curl -s --max-time 10 -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"repairOnFailure":true,"command":"cd vite-repair && npm run dev -- --host 0.0.0.0 --port 5173","timeoutSeconds":30}' \
  | jexec "d.get('execId')")
echo "fail execId: $FAIL_ID"

# Step 3：等待 Agent 自修复（Agent 读取 vite.config.js → 修复 → background 启动 → 验证 HTTP 200）
sleep 180

# Step 4：通过 sandbox endpoint 直连验证 dev server 可达
EP=$(curl -s --noproxy '*' --max-time 30 "$BASE/session/$SID/endpoint/5173")
PROXY_URL=$(echo "$EP" | jexec "d.get('proxyUrl','')")
echo "proxyUrl: $PROXY_URL"
curl -s --noproxy '*' --max-time 15 -o /dev/null -w "Vite HTTP %{http_code}\n" "$PROXY_URL/"

# Step 5（可选）：确认 Agent 的修复动作
curl -s --noproxy '*' --max-time 30 "$BASE/session/$SID/message?limit=6" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin,strict=False)
for m in d:
    for p in m.get('parts',[]):
        if p.get('type')=='tool' and p.get('state',{}).get('status')=='completed':
            inp=p.get('state',{}).get('input',{})
            out=str(p.get('state',{}).get('output',''))[-200:]
            cmd=inp.get('command') or inp.get('filePath') or ''
            print(f'TOOL: {cmd[:80]} => {out[:80]}')
"
```

**期望**：

| 步骤 | 检查项 |
|------|--------|
| Step 1 | exitCode = 0（项目创建 + 配置注入成功） |
| Step 2 | async exec 最终 status = failed、exitCode ≠ 0（`ReferenceError: brokenPlugin is not defined`） |
| Step 3 | Agent 消息中出现：Read `/workspace/vite-repair/vite.config.js` → Edit 修复 → bash `background: true` 启动 dev server → 验证 HTTP 200 |
| Step 4 | endpoint `proxyUrl` 返回 **HTTP 200** |
| Step 5 | 工具调用历史含 Read、Edit、background bash |

> **设计要点**：
> - 配置错误通过单独的 `printf > vite.config.js` 注入（非命令链），保证 Agent 重跑 `npm run dev` 时不会重新写入错误配置。
> - Agent 的 bash/Edit/Read 工具通过 `ExecRepair.node` → `SandboxProvider.node` 依赖链获得沙箱上下文，与 `/exec` 使用同一沙箱。
> - endpoint 验证使用 `proxyUrl`（经 sandbox server 代理）而非 `url`（Pod 私网 IP，宿主机不可路由）。

## 已知限制

- 防死循环计数在**进程内存**（监听器 `Map`），进程重启后计数重置；同一命令可能再次触发最多 3 次。
- 错误模式为内置正则，不可配置；特定场景（如自定义框架错误）可能漏匹配，需后续扩展为可配置。
- 落盘仅发生在**异步失败 + `repairOnFailure: true` + 检测到错误特征**时；同步失败与成功命令不落盘。
- 监听器为全局级（`makeGlobalNode`），单一监听器订阅 GlobalBus，按事件携带的 directory 通过 `InstanceStore.provide` 路由到对应实例；跨实例事件不会串扰。
- 修复重试完全由 Agent 自主决策（调用 bash 工具重跑），系统不代为重试，也不保证修复成功。
- **exec_log 表 status 字段差异**：`maybeTrigger` 的触发条件（async `state.status`）已修正为 exitCode≠0 判 failed，但同步 `/exec` 写入 `exec_log` 的 `status` 仍沿用旧逻辑（`result ? "completed"`，仅看 result 是否存在）。因此 T-EX.6 查 exec_log 表时，同步 exitCode≠0 但 result 存在的记录 status 可能为 `completed`，与自修复是否触发无关。后续应统一 exec_log status 判定。
- **用户主动 kill 不触发自修复**：`POST /exec/:execId/kill` 将 status 置为 `killed` 并直接结束，不走 `maybeTrigger`。这是设计如此——用户主动中断不是"失败"，不应触发修复。
- **并发 exec + session busy 竞态**：当 Agent 正在处理修复 prompt（session busy）时，新的 exec 请求可能因沙箱命令串行化（per-session Semaphore）而排队或超时。快速连续触发多个不同失败命令时，部分 exec 可能返回 500（`Sandbox.create` 超时或 `runInSession` 并发冲突）。这不影响已注入的修复 prompt，但可能导致该次 exec 的失败输出未落盘。建议串行执行（间隔 ≥5s）避免竞态。
- **沙箱上下文依赖**：`ExecRepair.node` 的 `deps` 必须包含 `SandboxProvider.node`，否则 bridge 上下文不含 `SandboxProvider.Service`，Agent 的 bash/Edit/Read 工具会回退到宿主机本地执行，无法操作沙箱内文件。这是 T-EX.12 端到端验证的前置条件。
- **dev server 验证方式**：endpoint `url`（如 `http://10.12.x.x:5173`）是沙箱 Pod 私网 IP，宿主机通常不可路由。应使用 `proxyUrl`（经 sandbox server 代理转发）或 `/session/:id/proxy/:port/`（经 SaaS server 代理）验证可达性。

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-19 | T-EX.1~3 单测 | ✅ 15 pass / 0 fail | `bun test test/sandbox/exec-failed.test.ts test/sandbox/exec-repair.test.ts`（`maybeTrigger`/监听器纯函数层，不受路由改动影响） |
| 2026-08-19 | 路由单测（新增） | ✅ 3 pass / 0 fail | `test/server/exec-repair-trigger.test.ts`：mock provider 挂真实 `sandboxProxyRoute`，验证同步不触发/异步无开关不触发/异步带开关触发。运行需 `OPENCODE_DATABASE_URL`（PG） |
| 2026-08-19 | T-EX.4 同步失败不触发 | ✅ | exitCode 1 直接返回；exec-logs 无落盘文件；修复 prompt 计数 0 |
| 2026-08-19 | T-EX.5 异步+开关落盘 | ✅ | `repairOnFailure:true`；status=failed；落盘 94836 字节（>64KB）；含 `Error line`×5956 与 `ReferenceError: big` |
| 2026-08-19 | T-EX.5b 异步无开关不触发 | ✅ | status=failed exitCode 1；不落盘；无 `noopt` 相关修复 prompt |
| 2026-08-19 | T-EX.9 误报抑制 | ✅ | `grep nonexistent`（exit 1 无错误特征）+ 开关开启 → 不注入 |
| 2026-08-19 | T-EX.8 防死循环 | ✅ | 同命令 4 次 async+开关 → 注入 3 次。**坑**：bash 双引号内 `$CMD` 展开会破坏 JSON（内层 `"` 未转义 → 400），payload 需整体单引号预构建再 `-d "$PAYLOAD"` |
| 2026-08-19 | T-EX.7 prompt 格式 | ✅ | 注入 synthetic user 消息含 command/exit code/failure summary（4KB 截断）；Agent 后续 tool-only 消息介入 |
| 2026-08-19 | T-EX.6 事件/表记录 | ✅ | exec_log 表 failed 记录与请求一致（exec-5/8/10 failed，成功命令 completed） |
| 2026-08-19 | T-EX.10 | ⏭ 未跑 | 沙箱不可达降级未执行，待后续补测 |
| 2026-08-19 | T-EX.11 实战修复闭环 | ✅ | async+开关运行 `repro.js`（ReferenceError）→ 注入 → Agent 改为 `const undefinedVariable = 'fixed'` → 重跑 exitCode 0 输出 `fixed` |
| 2026-08-19 | T-EX.12 Vite 端到端 | ✅ | Step1 exitCode 0；Step2 async failed（brokenPlugin）；Step3 Agent Read→Edit→background dev→自检 200；Step4 `/session/:id/proxy/5173/` HTTP 200。注：endpoint `proxyUrl`（host.docker.internal:30040）为容器视角地址，宿主机访问 000 属预期，验证走 SaaS server 代理 |
| 2026-08-19 | typecheck | ✅ | 基线 39 个既有错误，无新增 |
| 2026-08-19 | 镜像 | — | `opencode-saas-sandbox-test:exec-repair-optin`，本地 PG + 远端沙箱组合 |

