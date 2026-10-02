# Session Watchdog 覆盖（V2）

> 前置条件：独立 Docker 服务、隔离 PostgreSQL 与可用模型。该用例会在沙箱中发起长时间 shell 命令，必须在专用测试环境执行。脚本通过 HTTP API 验证运行过程与结果，并查询 PG 事件记录；结束时删除测试 session。

## V2 实现行为

实现依据：`packages/core/src/session/watchdog.ts`、`packages/core/src/session/execution.ts`、`packages/core/src/session/runner/llm.ts`。

- 默认超时 120 秒、扫描间隔 60 秒、首次扫描延迟 10 秒；可分别用 `OPENCODE_WATCHDOG_TIMEOUT_SEC`、`OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC` 配置。将 timeout 配成 `0` 会禁用 watchdog。
- 仅检查当前进程 `SessionExecution.active` 中的会话。已运行且超过时限的工具触发整个执行中断，事件 reason 为 `watchdog`。
- 默认豁免 `subagent`、`task`；`OPENCODE_WATCHDOG_EXEMPT_TOOLS` 可覆盖豁免列表。V2 没有 V1 的 `MONITORED_TOOLS` 白名单；没有 `time.ran` 的 tool part 不参与超时判断。
- 执行中断后 runner settlement 将未完成工具收敛为失败终态。进程重启遗留的工具不由定时 watchdog 扫描，恢复执行时由 `settleStaleToolCalls` 收敛。

## 用例

### T-WDT.V2.1 活跃长工具触发 watchdog 中断

在专用容器中将 timeout 和 scan interval 均设为 1 秒，通过 `prompt_stream` 请求模型执行 `sleep 30`。断言事件流中出现 `session.execution.interrupted` 且 `reason=watchdog`。

### T-WDT.V2.2 工具状态持久化收敛

通过消息 API 读回 assistant tool part，断言存在工具记录且所有工具均不再是 `running`。

### T-WDT.V2.3 PostgreSQL 记录中断事件

查询该 session 的 `event` 表，断言存在一条 `session.execution.interrupted` 版本化事件且 JSON 数据的 `reason=watchdog`。

## 复跑

脚本：`docs/test-cases/scripts/watchdog-v2-e2e.mjs`。需指定运行中的测试服务、PG URL 和口令。该脚本默认服务端口 `14104`，模型可用 `MODEL` 覆盖。

```bash
BASE=http://127.0.0.1:14104 \
PG_URL=postgresql://local@127.0.0.1:5432/opencode-v2-test \
OPENCODE_PASSWORD='<测试口令>' \
bun docs/test-cases/scripts/watchdog-v2-e2e.mjs
```

服务容器启动时需设置：

```text
OPENCODE_WATCHDOG_TIMEOUT_SEC=1
OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC=1
```

## 复测记录

| 日期 | 环境 | 用例 | 结果 | 证据 |
|---|---|---|---|---|
| 2026-09-30 | Docker `opencode-watchdog-tmp`（端口 14104），隔离 PG `opencode-v2-test`，真实模型 `Yd-DeepSeek/deepseek-v4-flash`，timeout/scan=1s | T-WDT.V2.1–V2.3 | ✅ 3/3 | SSE 事件包含 watchdog interrupted；API 读回 shell tool 状态 `error`；PG 查到 1 条对应中断事件。测试 session 已删除，隔离库 session 数恢复为 14，临时容器已清理。 |

单测：`packages/core/test/session-watchdog.test.ts` **9 pass**（扫描阈值、活动会话范围、豁免工具、无运行时间记录及配置覆盖）。

## V1 历史记录说明

旧版本页的 `T-WDT.1–T-WDT.3` 及 2026-08/09 的实测记录针对 V1 的 PG part 扫描、工具白名单和孤儿收敛实现，不作为 V2 验收依据。V2 watchdog 是进程内活动执行监控；其行为与旧版 PG 观测口径不同。
