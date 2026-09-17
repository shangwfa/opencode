# 会话挂死恢复验证（陈旧 run 接管 + 重启恢复）

> 背景（2026-08-17 线上事故）：LLM provider 流停滞（TCP 活着但永不出事件）→ run fiber 永挂 → Runner 停在 `Running` → 后续 prompt 在 `awaitDone` 无限排队 → 会话「发消息不回复」。
>
> **历史注**：曾以 `withStallTimeout` 包装 `fullStream` 做单拉停滞断流，后于 `add48efde0`（2026-08-20）**整体移除**（与 watchdog 职责重复且误杀长 bash / question 等待）。现行兜底链：
>
> | 防线 | 参数 | 默认 |
> |---|---|---|
> | `waitForSessionLock` 超时（HTTP 层） | `OPENCODE_SESSION_LOCK_TIMEOUT_SEC` | 60s（超时 503，见 [`lock-timeout-recovery.md`](./lock-timeout-recovery.md)） |
> | PG `statement_timeout`（run 内写挂死源头） | `OPENCODE_PG_STATEMENT_TIMEOUT_MS` | 30000ms |
> | watchdog 孤儿/超时标记（含 LEASE_TOOLS） | `OPENCODE_WATCHDOG_TIMEOUT_SEC` 等 | 见 [`watchdog-coverage.md`](./watchdog-coverage.md) |
> | Runner 陈旧 run 接管（本文档 ST-2） | `OPENCODE_SESSION_STALE_RUN_SEC` | 1800s |

## 公共环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。

### 单测（`packages/opencode` 目录下运行）

```bash
bun test test/effect/runner.test.ts test/session/llm.test.ts
```

覆盖：陈旧 run 接管恢复、shell 后排队不被误杀（`runner.test.ts`）；llm 流处理回归（`llm.test.ts`）。

以下为 HTTP 层集成用例（需重建 SaaS 镜像后执行）。

---

## ST-2: 陈旧 run 接管（兜底修复）

### T40.2.1 幽灵 run 后新 prompt 在接管超时后恢复

**场景**：制造一个永不结束的 run（长时间无超时的工具调用挂住第一条消息），随后发第二条消息。设置短接管超时 `OPENCODE_SESSION_STALE_RUN_SEC=30` 让等待可观测。

> **分层说明**（2026-08-17 实测）：HTTP 层 `withSessionLock` 先于 Runner 串行——幽灵 run 持锁期间第二条消息先卡 `waitForSessionLock`（现行为 60s 超时 + 503，不再无限等待），Runner 接管对绕过 HTTP 锁的内部调用方（subagent/background job 直调 prompt）生效，单测钉死该路径。HTTP 层的完整恢复由重启（ST-3）或锁超时保证。

```bash
# server 以 OPENCODE_SESSION_STALE_RUN_SEC=30 启动
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)

# 第一条消息挂住（长工具）
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hang me"}],"model":{"providerID":"stall-mock","modelID":"m1"}}' &
sleep 2

# 第二条消息走正常模型，应被排队 → 接管超时 → 取消幽灵 run → 重试成功
time curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"takeover check"}],"model":$MODEL}' | jq -r '.info.role'
```

**期望**：
- 内部调用方（单测路径）：第二条在接管超时后恢复执行，日志出现 `cancelling stale run`
- HTTP 调用方：第二条最长等 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC`（默认 60s）后 503，而非无限挂起

### T40.2.2 正常长 run 不被误接管

**场景**：默认 `OPENCODE_SESSION_STALE_RUN_SEC=1800` 下，一条正常耗时 60s+ 的消息（如长工具调用）运行期间并发发送第二条，第二条应共享等待而非触发接管。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 第一条：长 bash（60s）
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 sleep 60 && echo long-done"}],"model":$MODEL}' &
sleep 5
# 第二条：并发到达，应等到第一条完成（共享同一 run 的结果）
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"queued behind long run"}],"model":$MODEL}' | jq -r '.info.role'
```

**期望**：
- 两条都正常完成，第二条共享第一条 run 的结果（返回最后 assistant 消息）
- **无** `cancelling stale run` 日志——正常 run 未被误杀

### T40.2.3 shell 会话（交互式终端）不受接管超时影响

**场景**：打开长驻 shell（`/session/:id/shell`），排队一条 prompt，确认排队的 run 在 shell 结束后正常执行，不被接管超时取消。

**期望**：shell 关闭后排队消息正常产生 assistant 回复；shell 期间未被 `cancelling stale run` 打断（shell 是合法长驻状态，`behindRun=false` 路径不设超时）。HTTP pty websocket 集成未跑，由 `runner.test.ts` "queued work behind a shell is not cancelled" 单测覆盖。

---

## ST-3: 回归确认——事故场景复现

### T40.3.1 多实例共享 PG，远端实例重启后卡死会话自动恢复

**场景**：复现 2026-08-17 事故形态：会话在某实例上有幽灵 run（实例重启前挂死），验证**部署修复后的实例重启即恢复**。

```bash
# 1. 制造挂死会话（长任务进行中保持进程）
SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 sleep 120 && echo ghost-done\"}],\"model\":$MODEL}"

# 2. 重启实例（幽灵 run 随进程消失）
docker restart opencode-saas-test

# 3. 重启后对该会话发消息
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"recovered?\"}],\"model\":$MODEL}" | jq -r '.info.role'
```

**期望**：
- 新实例内存态干净（幽灵 run 随旧进程消失），消息立即正常回复
- 现行防线保证挂死会话最长 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC` + `OPENCODE_SESSION_STALE_RUN_SEC` 内自愈，无需人工重启

---

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-17 | 单测（runner 2 例 + llm 7 例，当时含 stall 用例） | ✅ 62 pass | 历史记录（stall 用例后随机制移除删除） |
| 2026-08-17 | T40.2.1 HTTP 层分层发现 | ⚠️ 改由单测覆盖 | HTTP `withSessionLock` 先卡（当时无超时）；Runner 接管对内部调用方生效。遗留的锁无限等待已于 2026-08-21 修复（[`lock-timeout-recovery.md`](./lock-timeout-recovery.md)：60s 超时 + 503 + PG statement_timeout 兜底） |
| 2026-08-17/18 | T40.2.2 正常长 run 不误杀 | ✅ | 长消息期间排队消息正常返回；`cancelling stale run` 0 条 |
| 2026-08-17/18 | T40.3.1 事故复现+重启恢复 | ✅ | 幽灵 run 持锁新消息超时（事故形态）；restart 后同 session ~10s 恢复回复 |
| 2026-08-19 | MCP permission.ask 挂起被 stall 误杀 | ✅ 随机制移除消解 | 原 `ses_fe76d6edaffeqduKwo76qF2rBM` 事故场景；stall 移除后该形态不复存在（permission 挂起现由 HITL lease 清扫善后） |
| 2026-09-14 | 单测 runner.test.ts + llm.test.ts | ✅ 57 pass / 0 fail | 镜像 `hitl-cbf2276a-wip2` 复测 |
| 2026-09-14 | T40.2.2 长跑不误接管 | ✅ | sleep 45 期间并发第二条：48s 共享返回 `long-done`；`cancelling stale` 0 条 |
| 2026-09-14 | T40.3.1 幽灵 run 重启恢复 | ✅ | 长任务进行中 `docker restart` → 重启后同 session 消息 **4s** 恢复回复 `ok` |
| 2026-09-14 | T40.2.1 / T40.2.3 | ✅ 单测覆盖 | 同分层定性；shell 排队不误杀（单测，57/57 内含） |
