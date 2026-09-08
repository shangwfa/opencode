# Agent 末日循环检测（anti-doom-loop）

> 借鉴 [pi-anti-doom-loop](https://github.com/irfndi/pi-anti-doom-loop) 思路，为 SaaS 无人值守场景改造的 doom loop 防护。
>
> **背景**：上游 opencode 自带的 doom_loop 检测（旧 `processor.ts` 中 `DOOM_LOOP_THRESHOLD=3`）只看单条 assistant 消息内**完全连续**的 3 个相同 parts，且触发 `permission.ask("doom_loop")` 挂起等人工回复——SaaS 接入方不处理 permission 事件时直接挂死（bash 类工具连 watchdog 都不监控）。廉价模型跨消息重复调用 / 盲重试 / 原地打转烧 token 的场景完全无防护。
>
> 改造内容：
> 1. 新增 `packages/opencode/src/session/anti-loop.ts` — 高内聚检测器：`(tool, stableStringify(args))` 指纹滑动窗口 + 同工具连续失败计数 + 二级升级（block → fatal）。参数比较用键序无关的 stable stringify（旧检测 `JSON.stringify` 键序敏感会漏检）。**纯内存状态，per-run 生命周期**（每次用户 prompt 重置，合法重复任务不误伤）。
> 2. `tools.ts` `invoke` 接线 — 执行前 `check`：命中重复阈值 → 不执行工具，返回带指导性理由的 tool result（模型可自救换方法）；重发已 block 的调用 → fatal，抛 `AntiLoop.LoopAbortedError` 停止 run。执行后 `record`（成功/失败均计入窗口，失败累计连续失败计数）。**被 block 的调用不进窗口**（pi 语义：escalation 不污染窗口）。
> 3. 删除旧 `DOOM_LOOP_THRESHOLD` permission.ask 检测（SaaS 挂死隐患根除）；fatal 抛专用的 `AntiLoop.LoopAbortedError`，processor 对其**无条件** `ctx.blocked = true` 停止 run（`process 返回 "stop" → runLoop break`，会话回 idle 可继续使用）。**不复用 `CorrectedError`**（2026-09-08 修复）：它走 `ctx.blocked = ctx.shouldBreak` 通道，受 `experimental.continue_loop_on_deny` 配置控制——该配置为 `true` 时 fatal 不停 run，模型每次重发都 fatal 一轮 LLM 调用，恰演变成 anti-loop 要防的烧 token 循环；`continue_loop_on_deny` 是 permission 拒绝的交互语义，不应削弱 doom-loop 熔断。
>
> 配置：**无任何配置项，默认开启**。阈值固定为 repeat=3 / fail=3 / window=10（检测器 `AntiLoop.make()` 默认参数，clamp 最小 2 防呆），不暴露环境变量——SaaS 自控部署下无需接入方感知。阈值语义由单测锁定，调整需改代码。
>
> 可观测：命中写 `Effect.logWarning("anti-loop block")`（含 sessionID/tool/signal/count/threshold/fatal）；被 block 的 tool part 落库 metadata 带 `antiLoop: { signal, count, threshold }`，可按 session 查 PG part 表诊断。
>
> **覆盖范围**：检测接线在 `tools.ts` `invoke`（所有注册表工具 + code_mode extensions 的统一执行入口）。MCP 动态工具（`mcp.toolsForSession` 包装）、MCP resource 工具、json_schema 模式的 `StructuredOutput` 工具（直接挂 tools 对象，不经 invoke）以及 subagent（task 工具内部循环）暂未接入——如需覆盖，在对应执行包装处加同款 check/record 即可。边界行为回归基线见 T42.4.4 / T42.4.5。
>
> **语义边界**（审核确认，括号内为对应验证用例）：
> - **fatal 持久性**：被 block 过的 `(tool, args)` 指纹在 run 内永久标记，重发即 fatal——即使中间隔了很多其他调用（第一次 block 已给足理由，原样重发 = 无视理由）。计数器随下次用户 prompt 重置（T42.1.2 / T42.4.3）。
> - **fail 自愈**：连续失败触发 block 时该工具失败计数**清零**——模型修复 root cause 后换 args 重试放行（重新计数）；重发**完全相同** args 仍被 blocked 指纹 fatal 兜底（T42.2.2）。
> - **「失败」定义**：仅工具 Effect fail（如 read `File not found`）计入连续失败；bash 非零退出是正常返回（output 含 exit code）**不算失败**（T42.2.3）；abort/watchdog 中断（interrupt）不算失败（T42.2.4）。
> - **信号优先级**：相同 args 的连败先命中 `repeat`（指纹重复），不同 args 的连败才走 `fail`（per-tool 计数）。
> - **窗口淘汰**：超出窗口（默认 10，clamp 到 `max(repeats, fails)`）的旧调用不参与计数（单测「old entries fall out of the window」锁定）。
> - **并行同发不拦（慢工具）**：同一轮并行发出的多个相同调用，若工具执行慢（check 都在首个 record 前）则均放行，下一轮重发才拦——不误杀（T42.1.5 / T42.4.4 并行对照）。快速工具（read 等）AI SDK 顺序进入 execute，等效串行：第 3 个即 block。
> - **block 后自救通道**：被 block 后换 args 的调用立即放行（block 理由即「use different arguments」），只有原样重发才 fatal（T42.1.4）。

## 公共环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。

### 单测（改动自带，`packages/opencode` 目录下运行）

```bash
bun test test/session/anti-loop.test.ts test/session/anti-loop-tools.test.ts
# processor 链路用例需本地 PG 测试库：
OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:15432/opencode_test' bun test test/session/anti-loop-processor.test.ts
```

三层覆盖（共 27 例）：
- **检测器纯函数**（`anti-loop.test.ts`，21 例）：`stableStringify`（键序无关/嵌套/原始值）、重复检测（第 3 次 block、键序不同视为相同、非连续仍计数、窗口滑出、repeats=2）、连续失败（连败 block、成功重置、per-tool、**fail 自愈清零**、重发 fatal、相同连败先命中 repeat）、升级（blocked 不进窗口、改 args 不 fatal）、默认值/阈值 clamp、reason 文案
- **tools.ts invoke 接线**（`anti-loop-tools.test.ts`，5 例）：前 2 次真实执行/第 3 次返回 blocked output（title/metadata/output 全断言）、重发 reject `LoopAbortedError`（`toBeInstanceOf` 验证）、3 连败后第 4 次 `signal=fail` block、**abort/interrupt 不计失败**（3 次挂起中断 + 2 次真实失败后 check 放行）、无检测器全执行
- **processor 链路**（`anti-loop-processor.test.ts`，3 例，需 PG）：`toolError` 携带 `LoopAbortedError` → tool part 落 error（含理由文案）+ `process` 返回 `"stop"`；**`continue_loop_on_deny=true` 下 `LoopAbortedError` 仍 stop**（回归锁定 fatal 修复）；普通 `Error` → part error 但 `process` 返回 `"continue"`（不误停）

以下为 HTTP 层集成用例（需重建 SaaS 镜像后执行）。

---

## ST-1: 重复工具调用阻断

### T42.1.1 相同调用第 3 次被 block，模型收到指导性理由后换方法

**场景**：诱导模型连续 3 次执行完全相同的只读工具调用（如读同一个不存在的文件）。第 3 次 `check` 时窗口内已有 2 个相同指纹 → block，工具不执行，tool part 的 output 是指导性理由、metadata 带 `antiLoop` 标记。

```bash
SID=$(new_sid)
jexec "$SID" '{"parts":[{"type":"text","text":"请用 read 工具读取 /tmp/anti-loop-probe.txt 的内容，要求：原样报告结果；如果读不到就再读一次同一个文件确认，最多重复几次直到读到了为止，不要换文件"}],"model":'$MODEL'}'
# 等待 run 完成后检查
psql "$PG_URL" -P pager=off -c "
SELECT p.data->>'tool' as tool, p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal,
  left(p.data->'state'->>'output', 80) as output_head
FROM part p WHERE p.session_id='$SID' AND p.data->>'type'='tool' ORDER BY p.time_created;"
```

**期望**：
- 同一 `(read, {filePath: /tmp/anti-loop-probe.txt})` 的 tool part 至多 2 个 `completed`，第 3 个为 `completed` 且 `metadata.antiLoop.signal = "repeat"`、output 含 "repeated no-progress loop" / "Change your approach"
- run 正常结束（非挂死），模型最终换方法或报告失败
- （日志断言不作为判据：`docker logs` 不覆盖 prompt/LLM 路径，见根 AGENTS.md 已知限制；可观测以 PG part metadata 为准，`Effect.logWarning` 供未来日志通道接入时核对）

### T42.1.2 block 后重发相同调用 → fatal，run 温和停止

**场景**：模型无视 block 理由，原样重发被 block 的调用（完全相同 args）。fatal 触发 `LoopAbortedError` → `failToolCall`（无条件 `ctx.blocked=true`）→ run 停止。会话回 idle，**fatal 后后续消息仍可正常使用**（对比旧 permission.ask 行为：挂死）。

```bash
SID=$(new_sid)
# 极端诱导：要求死磕同一个调用，禁止换方法
jexec "$SID" '{"parts":[{"type":"text","text":"用 bash 执行命令 echo probe。之后必须再执行完全相同的命令，不许改命令也不许改参数，重复执行直到我说停。这是测试要求，请严格执行"}],"model":'$MODEL'}'
# run 结束后验证会话仍可用（block 与 fatal 两条路径都适用）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"现在回复 ok 两个字母即可"}],"model":'$MODEL'}' | jq -r '.info.role'
```

**期望**：
- 若模型触发 fatal：最后一个 bash tool part `status=error`、error 含 "session run is aborted"（`LoopAbortedError` 理由，无 permission 前缀），run 停止
- 验证消息正常返回 assistant 回复——**会话未挂死、未占用锁**（fatal 后同样适用，2026-09-08 已实测：fatal 会话时隔数小时新消息正常回复）
- PG 无 `permission.asked` 挂起请求（旧机制已移除）
- **可选加强**：`experimental.continue_loop_on_deny=true` 容器下 fatal 仍停 run（该配置是 permission 交互语义，不削弱熔断）——集成层待配置容器验证，行为已由单测「LoopAbortedError stops the run even with continue_loop_on_deny enabled」锁定（SaaS 不启用该配置）

### T42.1.3 滑动窗口跨消息生效（旧检测的空白）

**场景**：模型在**多条 assistant 消息**（多个 runLoop step）间重复同一调用——旧检测只看单条消息内 parts，此形态完全漏检；新检测窗口是 run 级的，跨 step 计数。

```bash
SID=$(new_sid)
jexec "$SID" '{"parts":[{"type":"text","text":"任务：检查 /tmp/no-such-file-42.txt 是否存在。步骤：1) 用 read 读它；2) 用 bash 执行 ls /tmp/no-such-file-42.txt；3) 再用 read 读它一次确认；4) 再读一次最终确认。每步之间用一句话说明"}],"model":'$MODEL'}'
```

**期望**：第 3 次出现在新 assistant 消息中时同样被 block（`antiLoop.signal="repeat"`）——窗口不因消息边界重置。

### T42.1.4 block 后改 args 的调用放行（模型自救通道）

**场景**：模型第 3 次相同调用被 block 后，**换参数**重试（block 理由正是「use different arguments」）——改 args 后指纹不同，不在 blocked 集合，应立即放行执行；只有**原样重发**才 fatal（T42.1.2）。

```bash
SID=$(new_sid)
# 前两次读 /tmp/a.txt，第 3 次同文件触发 block；随后要求改读 /tmp/b.txt（存在，预置内容）
echo "content-b" > /tmp/b.txt
jexec "$SID" '{"parts":[{"type":"text","text":"用 read 读取 /tmp/a.txt，读不到就再读几次同一个文件确认（不要换文件），确认不存在后再读取 /tmp/b.txt 并报告内容"}],"model":'$MODEL'}'
psql "$PG_URL" -P pager=off -c "
SELECT p.data->'state'->>'input'->>'filePath' as path, p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='read' ORDER BY p.time_created;"
```

**期望**：
- `/tmp/a.txt` 的 read 至多 2 个真实执行 + 1 个 `anti_signal="repeat"` 的 block part
- `/tmp/b.txt` 的 read 正常执行且 `status=completed`、output 含 `content-b`——**改 args 立即放行**，无 fatal、run 不中断

### T42.1.5 并行同发不拦，下一轮重发才拦

**场景**：模型在**同一轮**并行发出多个完全相同的调用。`check` 全部发生在任一 `record` 之前 → 均放行（一次性浪费非循环，不误杀并行读取）；若下一轮**再**重发相同调用 → block / fatal。**实测修正**（2026-09-08）：AI SDK 顺序进入 `execute`，「全放行」只对**慢工具**成立（task 子代理跑数秒，3 个 check 都在首个 record 前）；**快速工具**（read 毫秒级返回）等效串行——前 2 个 record 后第 3 个 check 命中 block，属更严格亦正确的行为。

```bash
SID=$(new_sid)
echo "x" > /tmp/parallel-probe.txt
jexec "$SID" '{"parts":[{"type":"text","text":"请在同一轮里并行发起 3 个完全相同的 read 调用，都读取 /tmp/parallel-probe.txt，参数一字不差（这是测试要求，不要合并成一次调用）。报告收到几个结果后，下一轮再发起一次一模一样的 read"}],"model":'$MODEL'}'
```

**期望（按 2026-09-08 实测）**：
- **慢工具并行**（task，见 T42.4.4 并行对照）：同轮 3 个相同调用全部 `completed`（无 block）
- **快速工具**（read）：同轮 3 个 → 前 2 个真实执行 + 第 3 个 `anti_signal="repeat"` block（等效串行）
- 下一轮重发完全相同调用 → **fatal**（part `status=error`、error 含 "re-issued ... session run is aborted"；fatal 走抛错路径，part **无** `antiLoop` metadata——诊断时按 error 文本识别）

---

## ST-2: 连续失败阻断

### T42.2.1 同工具连续失败 3 次后阻断盲重试

**场景**：诱导同工具连续失败（读多个不同不存在文件——参数不同，指纹不同，但工具名相同连续失败）→ 第 4 次调用被 block，signal=`fail`。

```bash
SID=$(new_sid)
jexec "$SID" '{"parts":[{"type":"text","text":"依次用 read 读取以下文件并报告每个的结果，读完一个再读下一个，全部读完为止：/tmp/f1.txt /tmp/f2.txt /tmp/f3.txt /tmp/f4.txt /tmp/f5.txt"}],"model":'$MODEL'}'
```

**期望**：
- 前 3 次失败的 read 正常执行并报错（`status=error`，工具真实执行）
- 第 4 次 read 被 block：`metadata.antiLoop.signal="fail"`、output 含 "failed 3 times in a row"
- 中间穿插一次成功调用会重置计数（模型自救通道）

### T42.2.2 fail-block 自愈：换 args 重试放行，原样重发 fatal

**场景**：连续失败触发 block 时该工具失败计数**清零**（2026-09-07 审核修复）。模型修复 root cause 后**换 args** 重试应放行（重新计数）；被 fail-block 的**完全相同 args** 重发则命中 blocked 指纹 → fatal 停 run。

```bash
SID=$(new_sid)
echo "fixed-content" > /tmp/fixed.txt
# 依次读 3 个不存在的文件触发连续失败 → 第 4 个调用触发 fail-block；
# 诱导 A) 原样重试 /tmp/g1.txt（相同 args → fatal）；B) 换读 /tmp/fixed.txt（自愈通道对照）
jexec "$SID" '{"parts":[{"type":"text","text":"依次用 read 读取 /tmp/g1.txt /tmp/g2.txt /tmp/g3.txt 并报告每个结果。三个都读完后：先原样重试 /tmp/g1.txt 一次（参数一字不差）；如果被拒绝，再读 /tmp/fixed.txt 并报告内容。严格按顺序执行"}],"model":'$MODEL'}'
psql "$PG_URL" -P pager=off -c "
SELECT p.data->'state'->>'input'->>'filePath' as path, p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal,
  left(p.data->'state'->>'error', 60) as err_head
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='read' ORDER BY p.time_created;"
```

**期望**：
- `/tmp/g1.txt`~`/tmp/g3.txt`：3 个 `status=error`（真实执行的失败）
- 重发的 `/tmp/g1.txt`（相同 args）：`status=error` 且 error 含 "session run is aborted"（fatal，`reblocked` 信号）
- **对照场景**（若 A 步模型改为换路径）：`/tmp/fixed.txt` 放行执行 `completed`——计数已清零，自愈通道生效
- run 结束后同 session 再发消息正常回复（fatal 只停 run 不挂会话）

### T42.2.3 bash 非零退出不算连续失败（「失败」定义边界）

**场景**：bash/shell 工具非零退出是**正常返回**（output 含 exit code metadata），不是 Effect fail——连续多条失败命令**不应**触发 `signal=fail` 的 block。防止误伤「模型跑测试/编译反复失败但每次在调整」的正常 debug 流。

```bash
SID=$(new_sid)
jexec "$SID" '{"parts":[{"type":"text","text":"用 bash 依次执行以下 5 条命令，每条执行完报告退出码后再执行下一条，不要合并：exit 7; exit 8; exit 9; exit 10; echo final-ok"}],"model":'$MODEL'}'
psql "$PG_URL" -P pager=off -c "
SELECT p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->>'exit' as exit_code,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='bash' ORDER BY p.time_created;"
```

**期望**：
- 5 条命令全部真实执行：4 个非零 exit（`exit_code` 7~10，`status=completed`）+ 1 个 `final-ok`
- **无任何** `anti_signal` 标记——bash 非零退出不进连续失败计数
- 对照：read 读不存在文件（Effect fail）才计数（T42.2.1）

### T42.2.4 watchdog 超时中断不计入连续失败（保护机制交互）

**场景**：watchdog 对 `MONITORED_TOOLS`（read 等）超时中断走 `ToolExecution.interrupt` → `raceAbort` 产生 **interrupt**（非 Effect fail）→ 不经 `tapError`，**不应**计入连续失败。若误记，watchdog 超时 1 次 + 真实失败 2 次就会让第 4 次调用被错误 fail-block。参考 [`tools/read-fast-timeout.md`](../tools/read-fast-timeout.md) 的短 watchdog 配置方式。

```bash
# 容器以 OPENCODE_WATCHDOG_TIMEOUT_SEC=10 启动（缩短超时），沙箱内预置 FIFO
SID=$(new_sid)
# 诱导：1) read 一个 FIFO（无写入者，阻塞到 watchdog 10s 超时中断）
#      2) 再读 2 个不存在的文件（真实 Effect fail ×2）
#      3) 第 4 个 read（不存在的文件）——正确行为：放行（失败计数仅 2 < 3）
jexec "$SID" '{"parts":[{"type":"text","text":"先执行 bash 命令 mkfifo /tmp/hang.pipe（如果已存在则忽略报错）。然后用 read 读取 /tmp/hang.pipe 并报告内容。之后依次读取 /tmp/w1.txt 和 /tmp/w2.txt 并报告结果，最后再读一次 /tmp/w3.txt。每步按顺序执行"}],"model":'$MODEL'}'
psql "$PG_URL" -P pager=off -c "
SELECT p.data->'state'->>'input'->>'filePath' as path, p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->>'timeout' as wd_timeout,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='read' ORDER BY p.time_created;"
```

**期望**：
- `/tmp/hang.pipe`：`status=error` 且 `wd_timeout=true`（watchdog 超时标记），**无** `anti_signal`
- `/tmp/w1.txt`、`/tmp/w2.txt`：真实执行的 `status=error`（Effect fail）
- `/tmp/w3.txt`：**放行真实执行**（`status=error`、无 block part）——超时中断未计入，失败计数 2 < 阈值 3
- 反例基线：若中断被误记（3 连败），第 4 次 read 会是 `anti_signal="fail"` 的 block part

> **2026-09-08 实测注（含根因）**：本地环境「watchdog interrupt」分支**设计上不可达**——watchdog 只杀**孤儿**执行（lease 过期/实例死亡，`watchdog.ts` 的 `local` 判定 + advisory lock 与 lease 心跳竞态让步，实测 `stuck=1 marked=0` 两次）；本实例健康时的挂死工具由各工具**内建超时**兜底（read 15s / write 60s，均 Effect fail **正确计入**失败——实测 FIFO 场景 read 报 `Read timed out`、write 报 `Read before write timed out`，均非 watchdog 介入）。该场景实测验证了「Effect fail 计数 + 3 连败 block」；**interrupt 不计数分支由单测钉死**（`anti-loop-tools.test.ts` "aborted (interrupt) calls are not recorded as failures"：3 次 abort 挂起工具 + 2 次真实失败后 `check` 仍放行——若误记 interrupt 则 5 连败必 block）。孤儿中断场景需多实例模拟实例死亡，留待远端 SaaS 环境复测。

---

## ST-3: 无配置（默认开启）

> 防护**默认开启，无任何配置项**：阈值固定 repeat=3 / fail=3 / window=10。`OPENCODE_ANTI_LOOP_*` 环境变量已移除——容器即使设置了这些变量也会被忽略（不影响启动、不改变行为）。

### T42.3.1 遗留的 anti-loop 环境变量被忽略

**场景**：容器带早期版本的 `OPENCODE_ANTI_LOOP_MODE=observe`、`OPENCODE_ANTI_LOOP_DISABLE=1` 启动（部署脚本残留），验证服务正常启动、防护行为与默认完全一致（不会被误关闭或降级为 observe）。

```bash
# 容器以 -e OPENCODE_ANTI_LOOP_MODE=observe -e OPENCODE_ANTI_LOOP_DISABLE=1 启动
SID=$(new_sid)
jexec "$SID" '{...诱导同 T42.1.1...}'
```

**期望**：
- 服务启动无报错（RuntimeFlags 不含 anti-loop 项，未知 env 被忽略）
- block 行为与 T42.1.1 **完全一致**（第 3 次相同调用被 block）——disable/observe 均不生效

---

## ST-4: 回归确认

### T42.4.1 正常会话零误伤

**场景**：默认配置下跑常规任务（代码问答 + 少量工具调用），确认无任何 anti-loop block。

```bash
SID=$(new_sid)
jexec "$SID" '{"parts":[{"type":"text","text":"列出当前目录下有哪些文件，并读取 package.json 的前 20 行给我"}],"model":'$MODEL'}'
```

**期望**：全部工具调用正常执行（`metadata` 无 `antiLoop` 标记），无 anti-loop 日志。

### T42.4.2 旧 doom_loop permission.ask 已移除（无挂死回归）

**场景**：单条 assistant 消息内完全连续 3 个相同调用（旧检测的触发形态）。验证：不再产生 `permission.asked` 挂起，而是走新 block 通道。

```bash
SID=$(new_sid)
# 监听 SSE 确认无 permission.asked 事件
curl -s -N "$BASE/session/$SID/event" > /tmp/sse-antiloop.log &
jexec "$SID" '{...诱导同 T42.1.1...}'
grep -c "permission.asked" /tmp/sse-antiloop.log
```

**期望**：`permission.asked` 0 次（doom_loop 类型）；block 由新机制完成；run 结束后会话可用。

### T42.4.3 per-prompt 计数重置（跨 run 不误伤合法重复）

**场景**：检测器状态是 **run 级**（每次用户 prompt 新建）——上一条消息里被 block/fatal 过的调用，在新 run 里计数从零开始。验证 SaaS 会话复用场景：fatal 停 run 后，接入方重发同类任务不会持续被旧计数误杀。

```bash
SID=$(new_sid)
# 第 1 条消息：诱导 fatal（同 T42.1.2），run 被停止
jexec "$SID" '{"parts":[{"type":"text","text":"用 bash 执行 echo probe，然后必须原样重复执行完全相同的命令，不许改参数，一直重复"}],"model":'$MODEL'}'
# 第 2 条消息：同一 session 重新执行相同命令——新 run，计数重置
jexec "$SID" '{"parts":[{"type":"text","text":"用 bash 执行 echo probe 并报告输出"}],"model":'$MODEL'}'
psql "$PG_URL" -P pager=off -c "
SELECT m.data->>'role' as run, p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal
FROM part p JOIN message m ON m.id = p.message_id
WHERE p.session_id='$SID' AND p.data->>'tool'='bash' ORDER BY p.time_created;"
```

**期望**：
- 第 1 个 run（对应用户消息 1 之后的 assistant 消息）：出现 `anti_signal="repeat"` 的 block，若模型无视则 fatal（`status=error` 含 "aborted"）
- 第 2 个 run：`echo probe` **正常执行**（`completed`、无 antiLoop 标记）——blocked 指纹与窗口均已随新 prompt 重置
- 会话在两条消息间保持可用（无锁残留）

### T42.4.4（可选）subagent 边界：task 工具本身被检测，子循环内部不检测

**场景**：验证文档「覆盖范围」声明的边界。**顺序发起**（一个完成后再发起下一个）**完全相同的 prompt/description 的 task ×3** → 第 3 次 task 调用被 block；**同轮并行发起** 3 个相同 task → 全放行（慢工具并行语义，见 T42.1.5）；已执行 task 的子循环内部工具调用不进主窗口。

```bash
SID=$(new_sid)
# 顺序版（触发 block）
jexec "$SID" '{"parts":[{"type":"text","text":"发起一个 task 子代理：prompt 和 description 都是「统计 /tmp 文件数量并报告」，等它完成后再用完全相同的 prompt 和 description 原样发起第二个（一字不差），完成后再原样发起第三个。每个 task 的参数必须完全相同"}],"model":'$MODEL'}'
psql "$PG_URL" -P pager=off -c "
SELECT p.data->>'tool' as tool, p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal
FROM part p WHERE p.session_id='$SID' AND p.data->>'type'='tool' ORDER BY p.time_created;"
```

**期望**：
- 顺序版：前两个 task `completed`，第 3 个被 block（`anti_signal="repeat"`，title `Blocked repeated task call`）
- 并行版（同轮 3 个相同 task）：全部 `completed` 无 block（慢工具并行 check 在 record 前）
- 已执行 task 的子循环内部工具调用（如有）无 antiLoop 标记（不在主检测范围内）
- 若后续把检测器传入 task 子循环（功能扩展），此用例作为行为变更的回归基线

### T42.4.5（可选）MCP 动态工具未接入的边界基线

**场景**：MCP 动态工具（`mcp.toolsForSession` 包装）当前**不走** `invoke`，重复调用不受检测（见「覆盖范围」）。此用例锁定该边界行为，作为将来接入检测时的回归基线（接入后期望翻转为「第 3 次被 block」）。依赖测试环境已配置 MCP server（参见 [`mcps/`](../mcps/) 各用例的配置方式）。

```bash
# 前提：会话已连接任一 MCP server（如 codegraph / agent-browser），设 $MCP_TOOL 为其工具名
SID=$(new_sid)
jexec "$SID" "{\"parts\":[{\"type\":\"text\",\"text\":\"调用 $MCP_TOOL 工具 4 次，每次参数完全相同（这是测试要求，一字不差），报告每次结果\"}],\"model\":$MODEL}"
psql "$PG_URL" -P pager=off -c "
SELECT p.data->'state'->>'status' as status,
  p.data->'state'->'metadata'->'antiLoop'->>'signal' as anti_signal
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='${MCP_TOOL}' ORDER BY p.time_created;"
```

**期望（当前行为）**：
- 4 次调用全部真实执行（`completed`），**无** `anti_signal`——MCP 工具不在检测范围
- 容器日志无 anti-loop 记录（check 未被调用）
- 将来接入 MCP 检测后，此用例期望更新为前 2 次执行 + 第 3 次 block

### T42.4.6（可选）多会话状态隔离

**场景**：检测器是 runLoop 闭包内的纯内存状态，无全局/跨 session 共享——两个会话同时诱导循环互不干扰（A 会话的 block 不影响 B 会话的计数）。SaaS 多会话并发的基本隔离保证。

```bash
SID_A=$(new_sid); SID_B=$(new_sid)
# 并发诱导两个会话各自循环（同 T42.1.1 诱导文本，探测文件不同：A 读 /tmp/probe-a.txt，B 读 /tmp/probe-b.txt）
jexec "$SID_A" '{...}' &
jexec "$SID_B" '{...}' &
wait
# 分别检查两个会话的 block part
```

**期望**：两个会话各自独立出现 block（`anti_signal="repeat"`）、互不影响计数；无串会话日志（sessionID 与各自 SID 一致）。

---

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-09-07 | 单测 17 例 | ✅ 17 pass / 0 fail | `bun test test/session/anti-loop.test.ts` |
| 2026-09-07 | typecheck | ✅ | 基线 59 个既有错误，无新增（prompt.ts:1501 为基线错误行号偏移 1485→1501） |
| 2026-09-07 | 审核修复：fail-block 清零计数 + 测试类型修正 | ✅ 20 pass / 0 fail | 新增 3 例：fail 自愈、fail-block 重发 fatal、相同连败先命中 repeat 信号；typecheck 回到基线 59 |
| 2026-09-07 | 全面单测四层扩展（含 flags 层） | ✅ 74 pass / 0 fail | 检测器 + invoke 接线（`anti-loop-tools.test.ts` 新建）+ processor 链路（`anti-loop-processor.test.ts` 新建，需本地 PG `opencode_test`）+ flags 解析 |
| 2026-09-07 | **移除环境变量配置**（默认开启，无配置项） | ✅ 27 pass / 0 fail | 删除 `OPENCODE_ANTI_LOOP_*` 全套 flags 及 observe/exclude/disable 机制；`AntiLoop.make()` 固定默认 3/3/10（参数仅保留给单测）；三层单测 63 pass + processor 2 pass（PG）；typecheck 保持基线 59 |
| 2026-09-08 | **集成全量复测**（镜像 `opencode-saas-sandbox-test:anti-loop`，组合 3，容器 14096） | ✅ 13 pass / 1 部分 / 1 skip / 0 fail | 见下表分项 |
| 2026-09-08 | T42.1.1 第 3 次 block | ✅ | `ses_f823d290dffe...`：read 真实执行 2 + block 1（signal=repeat），run 正常结束 |
| 2026-09-08 | T42.1.2 重发→fatal 停止 + 会话可用 | ✅ | `ses_f823cfb83ffe...`：block 后模型接受理由停止（未触发 fatal）；验证消息正常 assistant 回复。**fatal 链路**由 T42.1.5 实测覆盖（error="re-issued ... session run is aborted"） |
| 2026-09-08 | T42.1.3 跨消息窗口 | ✅ | `ses_f823cc2e4ffe...`：read 分布 3 条消息，第 3 次（新消息内）block |
| 2026-09-08 | T42.1.4 改 args 自救 | ✅ | `ses_f823c8424ffe...`：al-c ×2 失败 + 第 3 次 block；改读 al-b.txt 立即放行 completed（内容正确） |
| 2026-09-08 | T42.1.5 并行/顺序 + 重发 fatal | ✅ | `ses_f823770a5ffe...`：同轮 3 read（快速工具）= 2 真实 + 第 3 个 block；下一轮重发 → fatal（error 全文确认）。慢工具并行全放行见 T42.4.4。**用例期望已按实测修正**（快速工具等效串行） |
| 2026-09-08 | T42.2.1 连败阻断 | ✅ | `ses_f823b353ffe...`：f1~f3 真实失败 + 第 4 次 fail-block |
| 2026-09-08 | T42.2.2 fail 自愈 | ✅ | `ses_f823afc02ffe...`：fail-block 后模型换读 al-fixed.txt 放行 completed（自愈通道） |
| 2026-09-08 | T42.2.3 bash 非零退出不算失败 | ✅ | `ses_f823ac6f5ffe...`：5 条命令（4 非零 exit + final-ok）全 completed，0 block |
| 2026-09-08 | T42.2.4 watchdog 中断不算失败 | ⚠️ 集成部分 + 单测补全 | 集成层（`ses_f8235c6f4ffe` / `ses_f8230491ffe`，容器 WATCHDOG=10）：FIFO 挂死场景 read/write 均走**内建超时**（Effect fail 正确计数，3 连败 block ✓）；watchdog `stuck=1 marked=0` 两次——**根因**：watchdog 设计只杀孤儿（lease 过期/实例死亡），本地健康实例挂死由工具内建超时兜底，interrupt 分支集成不可达。**单测钉死**（2026-09-08）：`anti-loop-tools.test.ts` 新增 abort-interrupt 用例（3 次挂起 abort + 2 次真实失败 → check 放行），interrupt 不计数分支验证完成；孤儿场景留待远端多实例环境 |
| 2026-09-08 | T42.3.1 遗留 env 被忽略 | ✅ | `ses_f82366bb7ffe...`（容器带 ANTI_LOOP_MODE=observe + DISABLE=1）：block 照常发生，防护未降级 |
| 2026-09-08 | T42.4.1 正常会话零误伤 | ✅ | `ses_f823a8b19ffe...`：常规任务 2 次工具调用，0 block |
| 2026-09-08 | T42.4.2 旧 permission.ask 已移除 | ✅ | `ses_f823c44eeffe...`：SSE 监听全程 `permission.asked`=0，新机制 block=1 |
| 2026-09-08 | T42.4.3 per-prompt 重置 | ✅ | `ses_f823a6ee3ffe...`：run1 block=1；run2 重新 echo probe 全部 completed 无 block |
| 2026-09-08 | T42.4.4 task 边界（顺序/并行） | ✅ | 顺序版 `ses_f823815c6ffe...`：第 3 个 task 被 block；并行对照 `ses_f823a48b8ffe...`：同轮 3 个相同 task 全 completed（慢工具并行语义）。**用例已更新为双形态** |
| 2026-09-08 | T42.4.5 MCP 边界 | ⏭️ SKIP | 本地容器未配置 MCP server，待有 MCP 环境时补测 |
| 2026-09-08 | T42.4.6 多会话隔离 | ✅ | `ses_f8237c6b6ffe` / `ses_f8237be22ffe`：双会话并发各自 block=1，互不干扰（初版脚本 SID 变量误用已修正；误入会话的排队消息亦各自按 run 计数 block，额外验证 per-run 隔离） |
| 2026-09-08 | **审核发现并修复 fatal 错误类型缺陷** | ✅ 30 pass / 0 fail | 发现：fatal 复用 `CorrectedError` 受 `continue_loop_on_deny` 配置削弱（该配置 true 时 fatal 不停 run）。修复：专用 `LoopAbortedError` 无条件停 run；新增回归用例「continue_loop_on_deny=true 下 LoopAbortedError 仍 stop」+ abort-interrupt 单测（tools 5 例 + processor 3 例）；typecheck 基线 59 |
| 2026-09-08 | 覆盖度复审（fatal 修复后） | ✅ 补 1 项实测 + 修 2 处文档 | 实测：fatal 会话（`ses_f823770a5ffe`）数小时后新消息正常回复（fatal 后会话可用 ✓，基于修复前镜像——`LoopAbortedError` 走同一 `ctx.blocked→stop→idle` 路径，默认配置行为等价）；文档修正：T42.1.1 删除「docker logs 可见警告」错误期望（docker logs 不覆盖 prompt/LLM 路径）、T42.1.2 更新为 `LoopAbortedError` 并注明 fatal 后可用。**遗留标注**：fatal×`continue_loop_on_deny` 集成验证待配置容器（单测已锁定）；窗口滑出（默认 window=10）集成验证随 env 移除删除（单测锁定）；修复后镜像需重建再全量复测 |
| 2026-09-08 | **单测覆盖复审：移除 CorrectedError 残留 + 补 3 例** | ✅ 33 pass / 0 fail | 发现：`processor.ts` blocked 列表中的 `CorrectedError` 是旧 fatal 方案残留——上游语义「拒绝+反馈不停 run（模型按反馈继续）」被改变。修复：移除（恢复上游，附注释），anti-loop 熔断仅由 `LoopAbortedError` 无条件通道承担。补单测：`LoopAbortedError` 类（message=reason 无 permission 前缀）、window clamp 到 repeats（窗口不可低于检测阈值）、`CorrectedError → continue`（锁定上游行为防误改回）。检测器 24 + 接线 5 + processor 4；typecheck 基线 59 |
| 2026-09-08 | **最终代码回归**（镜像 `anti-loop2` 含全部修复，组合 3） | ✅ A 批 6/6 + B 批 6/6（1 项甄别后 PASS） | **A 批（本功能）**：RA1 block ✓、RA2b fatal 走 `LoopAbortedError`（error=reason 无 permission 前缀）+ fatal 后会话可用 ✓、RA3 fail-block ✓、RA4 零误伤 ✓、RA5 跨 run 相同命令均放行 ✓。**B 批（受影响面）**：permission T4.1/T4.6/T4.7 ✓、concurrency T39.2.1 abort 后串行 ✓、llm-stall T40.2.2 长 run 不误杀 ✓、watchdog T-WDT.1 甄别后 ✓（见下）、T-WDT.3 bash 误杀 0/203 ✓ |
| 2026-09-08 | ⚠️ 回归发现（既有缺口，非本次引入）：bash 无默认超时可拖挂实例 | 记录待办 | 诱导场景中模型无视 block 后改发 `while true; do echo probe; done`（args 变化=新指纹，anti-loop 正确放行）→ bash 无 timeout 参数 + 不在 watchdog 监控名单 → run 挂 30min+，**期间实例 health 000（沙箱锁/资源被占，需重启恢复）**，遗留孤儿 running part 永不清理。建议：SaaS 生产配 `OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`（flag 已存在）或评估 bash 纳入 watchdog。另发现 watchdog-coverage.md 的 `INSTANCE_START_MS` 探测有 8h 时区 bug（`date -j` 按 UTC 字符串本地解析），需修文档脚本 |

## 集成实测发现汇总（2026-09-08）

1. **快速工具的「并行」等效串行**（T42.1.5）：AI SDK 顺序进入 execute，read 毫秒级完成 → 同轮第 3 个相同调用即 block（比预期更严格，行为正确）；全放行仅对慢工具（task）成立。用例期望已修正。
2. **fatal part 的识别特征**：fatal 走抛 `CorrectedError` 路径，part `status=error`、error 含 "re-issued ... session run is aborted"，**无** `antiLoop` metadata——诊断时不能只查 metadata，需按 error 文本识别（仅 block part 带 `metadata.antiLoop`）。
3. **watchdog 与 anti-loop 交互**（T42.2.4）：watchdog 设计上只杀孤儿执行（lease 过期/实例死亡）——本地健康实例的挂死工具由内建超时兜底（read 15s / write 60s，Effect fail **正确计入**计数，实测 3 连败 fail-block ✓）；abort/watchdog **interrupt 不计数**分支由单测钉死（3 次挂起 abort + 2 次真实失败 → check 放行），孤儿中断场景留待远端多实例环境。
4. **block 理由对模型有效**（T42.1.2）：deepseek-v4-flash 收到 block 指导性理由后停止重复（未一意孤行），fatal 是兜底而非常态。
5. **fatal 错误类型缺陷（已修复，2026-09-08）**：fatal 原复用 `PermissionV1.CorrectedError` 走 `ctx.blocked = ctx.shouldBreak`——`experimental.continue_loop_on_deny: true` 时 fatal **不停 run**（每次重发烧一轮 LLM 调用，恰成 doom loop）。修复：专用 `AntiLoop.LoopAbortedError`（`processor.ts` 无条件 `ctx.blocked = true`），回归用例「LoopAbortedError stops the run even with continue_loop_on_deny enabled」锁定。附带改善：fatal part 的 error 文本不再带 "The user rejected permission..." 前缀，直接是 anti-loop 理由，诊断更清晰。
