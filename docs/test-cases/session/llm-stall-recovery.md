# 会话挂死恢复验证（陈旧 run 接管 + 重启恢复）

> 背景（2026-08-17 线上事故）：LLM provider 流停滞（TCP 活着但永不出事件）→ run fiber 永挂 → Runner 停在 `Running` → 后续 prompt 无限排队 → 会话「发消息不回复」。

## ⚠️ V1 机制在 V2 中已全部移除（2026-09-29 实测）

原文档描述的四道防线，**在 V2 代码中一个都不存在**。全仓 grep 结果：

| V1 防线 | V1 参数 | V2 实测 |
|---|---|---|
| Runner 陈旧 run 接管 | `OPENCODE_SESSION_STALE_RUN_SEC` | **无此 env，无 `cancelling stale run` 日志** |
| HTTP 层 session 锁 | `OPENCODE_SESSION_LOCK_TIMEOUT_SEC` / `waitForSessionLock` | **无此 env，无 `waitForSessionLock`** |
| PG statement_timeout | `OPENCODE_PG_STATEMENT_TIMEOUT_MS` | **无此 env** |
| watchdog 孤儿/超时标记 | `OPENCODE_WATCHDOG_TIMEOUT_SEC` / LEASE_TOOLS | **无此 env** |

V2 中唯一的 `OPENCODE_SESSION_*` 变量是 `OPENCODE_SESSION_AUTO_KEEPALIVE`（无关）。

**单测文件也已迁移/消失**：

| V1 单测 | V2 现状 |
|---|---|
| `packages/opencode/test/effect/runner.test.ts` | **文件不存在** |
| `packages/opencode/test/session/llm.test.ts` | 迁至 `packages/ai/test/llm.test.ts`（12 例），但**不含任何 stall/timeout 用例** |

## V2 的实际机制：持久化 execution claim

V2 用**写前日志式的持久化 claim** 取代了上述四道防线：

- `packages/core/src/session/store.ts` — `claim()` 在 turn 开始时写入；`release()` 由终态事件提交时清除。**claim 存活过重启 = 上一进程死在 turn 中途**。
- `packages/core/src/session/execution/restart.ts` — `resumeSuspendedSessions()` 在**启动时**扫描未释放的 claim 并恢复。

源码注释原文说明了设计意图：

> Recovery for orphaned executions. Claims are written at turn start by SessionExecution, so this sweep needs no cooperation from the previous process: crash, SIGKILL, isolate eviction, and graceful restart all leave the same durable signature.
>
> The claim is never cleared here: only a terminal event releases it, so a death anywhere in the resume path leaves the same orphaned claim for the next boot.

还有**恢复预算**（`countResume` / `maxAttempts`）：反复恢复失败超过预算后发 `SessionEvent.Execution.Failed` 终态化，避免无限重启循环。

对应单测：`packages/core/test/session-execution.test.ts`（**35 pass / 0 fail**，含 "SessionRestart background recovery" 与重启预算用例）。

## 公共环境

```bash
export BASE="${BASE:-http://localhost:14096}"
export PG_URL="${PG_URL:-postgresql://local@127.0.0.1:5432/opencode-v2-up}"
export MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
api(){ curl -sS --noproxy '*' "${CURL_AUTH[@]}" "$@"; }
pgval(){ psql "$PG_URL" -t -A -c "$1"; }
new_session(){ jq -nc --argjson m "$MODEL" '{location:{directory:"/workspace"}, model:$m}' \
  | api -X POST "$BASE/api/session" -H 'Content-Type: application/json' --data-binary @- \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])"; }
prompt_nowait(){ jq -nc --arg t "$2" '{text:$t,metadata:{},delivery:"queue"}' \
  | api -X POST "$BASE/api/session/$1/prompt" -H 'Content-Type: application/json' --data-binary @- >/dev/null; }
wait_sid(){ curl -s --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null --max-time "${2:-180}" \
  -X POST "$BASE/api/experimental/session/$1/wait" -H 'Content-Type: application/json' -d '{}'; }
last_text(){ api "$BASE/api/session/$1/message?order=asc&limit=200" \
  | jq -r '[.data[] | select(.type=="assistant") | .content[]? | select(.type=="text") | .text] | last // ""'; }
```

### 单测（先跑这两个，比 HTTP 层更快定位）

```bash
cd packages/core && bun test test/session-execution.test.ts   # 35 pass —— V2 的恢复机制
cd packages/ai   && bun test test/llm.test.ts                 # 12 pass —— llm 流处理（无 stall 用例）
```

---

## T40.2.1 幽灵 run 后新 prompt 恢复

⛔ **原用例在 V2 无法执行**。它依赖两件已不存在的东西：

1. `stall-mock` provider（V2 无此 mock）
2. `OPENCODE_SESSION_STALE_RUN_SEC=30` 的接管超时（V2 无此机制）

且原文档自己已注明分层结论：HTTP 层 `withSessionLock` 会先于 Runner 拦截，**Runner 接管只对绕过 HTTP 锁的内部调用方（subagent / background job 直调 prompt）生效**。V2 取消 HTTP 锁后，这条分层讨论随之失效。

**V2 下的等价验证**：`packages/core/test/session-execution.test.ts` 中的 "SessionRestart background recovery" 系列，覆盖了「内部调用方（subagent）在重启后被恢复」这条真正的路径。

## T40.2.2 长 run 期间的排队消息不被误取消

**这个用例在 V2 仍然有效**（验证同一 session 串行 drain，且长任务不被中断）。

```bash
SID=$(new_session)
prompt_nowait "$SID" '用 shell 工具执行 sleep 45 && echo long-done'
sleep 6
api "$BASE/api/session/active" | jq -c --arg s "$SID" '.data[$s]'      # 期望 {"type":"running"}
prompt_nowait "$SID" '回复 queued-behind 即可'                          # 并发到达，应排队
wait_sid "$SID" 200
last_text "$SID"                                                          # 期望含 queued-behind
```

**期望**：
- 两条消息都产生 assistant 回复（PG `user=2`，`assistant>=2`）
- 最后一条回复是第二条的内容（`queued-behind`）—— 排队语义正确
- **`sleep 45` 的 shell 工具真实跑完**，输出 `long-done`、`exit=0` —— 长任务未被误杀
- 日志中无 `cancelling stale run`（V2 该机制已不存在，此断言恒真，仅作回归护栏）

> ⚠️ **断言陷阱**：AI 的 `shell` **工具调用**记录在 assistant 消息的 tool part 里
> （`p->>'type'='tool' AND p->>'name'='shell'`）；
> 而 `session_message.type='shell'` 的**消息**是 `POST /api/session/:id/shell` **API** 产生的。
> 查错会导致「明明跑完了却断言失败」。

## T40.2.3 shell 会话不受接管超时影响

⛔ **V2 无「接管超时」机制**，本用例的前提不存在。

V2 中 shell 是普通工具调用，串行 drain 期间不会被取消 —— 该性质已由 T40.2.2 覆盖（`sleep 45` 期间排队的消息正常执行，长任务未被中断）。

## T40.3.1 实例重启后卡死会话自动恢复

**这个用例在 V2 仍然有效，且直接验证 claim 恢复机制**。

```bash
SID2=$(new_session)
prompt_nowait "$SID2" '用 shell 工具执行 sleep 120 && echo ghost-done'   # 制造执行中的 claim
sleep 8
api "$BASE/api/session/active" | jq -c --arg s "$SID2" '.data[$s]'       # 期望 running

docker restart opencode-saas-test                                          # 幽灵 claim 随进程消失
for _ in $(seq 1 60); do curl -s --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null "$BASE/api/info" && break; sleep 1; done

# 恢复后新消息必须能正常收敛
T0=$(date +%s); prompt_nowait "$SID2" '回复 recovered 即可'; wait_sid "$SID2" 120; T1=$(date +%s)
echo "收敛耗时 $((T1-T0))s"
last_text "$SID2"                                                          # 期望含 recovered
```

**期望**：
- 重启后新消息在**数秒内**收敛（实测 2–3s），会话**未卡死**
- 得到正常 assistant 回复
- 最终该会话不在 `/api/session/active` 中

---

## 2026-09-29 V2 实测记录

环境：SaaS `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG + 本地 OpenSandbox、Bun 1.3.14。

### 单测

| 文件 | 结果 | 说明 |
|---|---|---|
| `packages/core/test/session-execution.test.ts` | ✅ **35 pass / 0 fail** | V2 恢复机制的主力覆盖：background recovery、subagent 恢复、恢复预算终态化、interrupt continuation |
| `packages/ai/test/llm.test.ts` | ✅ **12 pass / 0 fail** | llm 流处理回归；**无 stall 用例** |

### HTTP 层

| 用例 | 结果 | 实际观察 |
|---|---|---|
| T40.2.1 | ⛔ 不适用 | 依赖已移除的 stale-run 接管 + `stall-mock` provider；等价路径由单测覆盖 |
| T40.2.2 | ✅ | `sleep 45` 期间 active=running；第二条排完后回复 `queued-behind`；PG `user=2 assistant=3`；**shell 工具真实输出 `long-done`、`exit=0`**；总收敛 43s；无 stale 日志 |
| T40.2.3 | ⛔ 不适用 | 前提（接管超时）已不存在；性质由 T40.2.2 覆盖 |
| T40.3.1 | ✅ | 长任务进行中 `docker restart` → 重启后同会话新消息 **2s** 收敛，回复 `recovered`；最终 `active=null` |

**合计 7 条断言 PASS，0 FAIL，2 条不适用（T40.2.1 / T40.2.3）。**

### 需要产品/技术决策

V2 取消「陈旧 run 接管」与「HTTP session 锁超时」后，**运行中进程内的 LLM 流停滞**（TCP 活着但不出事件，run fiber 永挂）这个原始事故形态，靠什么兜底？

- 若认为 V2 的 `prompt_stream` / watchdog 已在别层覆盖 → 应在本文档写明替代防线，否则后来者会误以为「已有保护」
- 若认为确有缺口 → 需补超时机制（本轮测试**未发现该缺口**，因为无法在不引入 mock provider 的前提下构造稳定的流停滞场景）

**清理**：本轮 2 个会话已删除，直接 `count` 复查为 0。

---

## 历史记录（V1 时期，保留备查）

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-17 | 单测（runner 2 例 + llm 7 例） | ✅ 62 pass | 历史记录（stall 用例后随机制移除删除） |
| 2026-08-17 | T40.2.1 HTTP 层分层发现 | ⚠️ 改由单测覆盖 | HTTP `withSessionLock` 先卡；Runner 接管对内部调用方生效 |
| 2026-08-17/18 | T40.2.2 正常长 run 不误杀 | ✅ | 长消息期间排队消息正常返回 |
| 2026-08-17/18 | T40.3.1 事故复现+重启恢复 | ✅ | restart 后同 session ~10s 恢复回复 |
| 2026-08-19 | MCP permission.ask 挂起被 stall 误杀 | ✅ 随机制移除消解 | stall 移除后该形态不复存在 |
| 2026-09-14 | 单测 runner.test.ts + llm.test.ts | ✅ 57 pass / 0 fail | 镜像 `hitl-cbf2276a-wip2` |
| 2026-09-14 | T40.2.2 长跑不误接管 | ✅ | sleep 45 期间并发第二条：48s 共享返回 `long-done` |
| 2026-09-14 | T40.3.1 幽灵 run 重启恢复 | ✅ | 长任务进行中 `docker restart` → **4s** 恢复回复 `ok` |
