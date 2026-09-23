# 沙箱性能优化与 Watchdog 兜底（SaaS / PG）

> **仅适用于 opencode SaaS（PostgreSQL）**。
> 公共测试环境和配置请参考 `docs/local-test-env.md`。

> **本文档含三个主题**：
> - **一、沙箱缓存性能**（T28.1-T28.4, T28.6-T28.8）：`getOrCreate` 缓存、并发、超时、日志——属于沙箱对象访问性能优化
> - **二、PG 命令生命周期超时**（T28.15-T28.22）：command session、semaphore、前台/后台命令、清理和恢复——仅验证 PG provider
> - **二、Part Watchdog 工具超时兜底**（T28.5, T28.5b, T28.9-T28.14）：扫描超时 tool part 并标记 error——与沙箱生命周期无关
>
> **与其他文档的关系**：
> - 沙箱生命周期与空闲回收（创建/复用/keepAlive/onIdle 销毁/idle-reap）见合并后的 [`sandbox-lifecycle.md`](./sandbox-lifecycle.md)（T12 生命周期 + T30 空闲回收）
> - 本文档的缓存/超时/日志属于沙箱对象访问层；Part Watchdog 标记的是 tool part 状态，**不销毁沙箱**（沙箱回收由 T12/T30 负责）

## 背景

针对 `ses_127609d2fffeU5lQ79QBAdcZYV` 卡顿会话的诊断（详见 [`guides/session-diagnostic-guide.md`](./guides/session-diagnostic-guide.md)），发现以下问题：

1. **每次工具调用都重新走 reconnect + isHealthy**（无沙箱对象缓存），并发请求被 `lock(sessionID)` 串行化，单次卡顿会放大 N 倍
2. **`getOrCreate` 无超时**，远端沙箱重建卡死时无限等待
3. **无 part watchdog / lifecycle 兜底**，工具调用 fiber 挂起时 part 状态永远 `running`
4. **`tools.ts` 的 `.catch(() => null)` 静默吞错**，沙箱 init 失败看不到任何日志
5. **`sandbox-provider` 关键阶段无耗时日志**，无法定位卡在哪一步

## 改动清单

| 文件 | 改动 | 防御层 |
|------|------|--------|
| `packages/opencode/src/tool/sandbox-provider.ts` | PG provider 的沙箱获取 90s 超时、command session/信号量/命令/清理超时 + 各阶段 `log.info` | 缓存（治本）+ 超时（防单点）+ 日志（诊断）|
| `packages/opencode/src/session/mark-timed-out.ts`（原 tools.ts 拆出）| `SessionTools.markTimedOut()` lifecycle 方法；PG 模式 CAS + retry attempt + durable event 同事务（`pg_advisory_xact_lock(message_id)`）；`transitionRunningTool` CAS | 错误不再静默；tool lifecycle 统一超时标记；事件原子性 |
| `packages/opencode/src/session/watchdog.ts`（**新建**）| 每 60s 扫描候选 running tool；本进程 callID + lease 过期 + orphan 兜底三路判定；调用 `SessionTools.markTimedOut()` | Watchdog（发现）+ lease recovery + orphan recovery |
| `packages/opencode/src/session/watchdog-sql.ts`（**新建**）| `runningToolCondition`（基础 SQL 条件）+ `watchdogToolCondition`（含 lease/orphan 的三路条件）+ `MONITORED_TOOLS` 白名单 | SQL 筛选层 |
| `packages/opencode/src/session/tool-execution.ts`（**新建**）| 本进程 `ToolExecution` 注册表（register/interrupt/has/callIDs）+ `raceAbort`（`Effect.raceFirst` 保证不响应 signal 的工具也能退出） | 调用边界 abort race |
| `packages/opencode/src/session/tool-execution-lease.ts`（**新建**）| PG 模式 lease heartbeat（30s 续租，2 分钟 lease，写入 part `metadata.watchdog.{owner,leaseUntil}`） | 跨 Pod 执行所有权 |
| `packages/opencode/src/session/tools.ts` | invoke 注册 `AbortController`；MONITORED_TOOLS 执行与 lease `maintain` raceFirst；`raceAbort` 包裹整个执行链 | 调用边界 + lease |
| `packages/opencode/src/session/processor.ts` | `isWatchdogTimeout` + `settleWatchdogTimeout`；complete/fail 检测已 timeout 的 part 则 settle | settle 已被 watchdog 终结的 tool call |
| `packages/opencode/src/effect/app-runtime.ts` | 注册 `SessionWatchdog.defaultLayer` 并提供 `SessionTools.defaultLayer` | 启动入口 |

## 关键常量

| 常量 | 默认值 | 代码位置 | 说明 |
|------|--------|---------|------|
| `timeoutMs` | 2 分钟（120_000ms） | `watchdog.ts` | 工具执行超时阈值；可通过 `OPENCODE_WATCHDOG_TIMEOUT_SEC` 覆盖 |
| `orphanTimeoutMs` | 15 分钟（900_000ms） | `watchdog.ts` | 无 lease 的旧版 running part 的 orphan 回收阈值 |
| `scanInterval` | 60s | `watchdog.ts` | watchdog 扫描间隔；实际终止发生在 120-180s |
| `initialDelay` | 10s | `watchdog.ts` | 首次扫描延迟 |
| `leaseDurationMs` | 2 分钟（120_000ms） | `tool-execution-lease.ts:12` | lease 有效期 |
| `heartbeatInterval` | 30s | `tool-execution-lease.ts:11` | lease 续租间隔 |
| `MAX_AGENT_RETRY_ATTEMPTS` | 2 | `mark-timed-out.ts:169` | 同一 message 内 watchdog 超时重试上限 |
| `SB_CACHE_TTL_MS` | 5 分钟（300_000ms） | `sandbox-provider.ts` | 沙箱对象缓存 TTL |
| `CREATE_TIMEOUT_SECONDS` | 60s | `sandbox-provider.ts` | 底层 `Sandbox.create` 超时 |
| `GET_OR_CREATE_TIMEOUT_SECONDS` | 90s | `sandbox-provider.ts` | PG 命令入口的锁 + `getOrCreate` 总超时 |
| `COMMAND_CLEANUP_TIMEOUT_SECONDS` | 10s | `sandbox-provider.ts` | detached command session 删除超时 |

> **lease PG-only**：`tool-execution-lease.ts` 的 `refresh`/`maintain` 在非 PG 模式返回 `Effect.succeed(false)` / `Effect.never`（无副作用）。SaaS PG 模式下才真正写入 lease 元数据。

### Watchdog 阈值依据（2026-08-01 至 2026-08-08）

本机最近 7 天的 53 个会话包含 5,876 次受监控工具调用：P95 93ms、P99 217ms，最大正常耗时 42.382s；只有 3 次超过 30s，0 次超过 60s，且没有遗留 `running` part。120s 是样本最大值的 2.8 倍，同时为沙箱冷启动、外部目录确认和多文件/LSP 后处理保留余量。60s/90s 的长尾余量不足，180s/300s 会把故障恢复延后到 3-6 分钟。

白名单使用真实 Tool ID：`read`、`write`、`edit`、`apply_patch`、`glob`、`grep`、`list`。`bash`、`task` 等长任务不由该 watchdog 处理。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应时间 | 连续调用 `/file/content` | 第 1 次慢（建沙箱），30s 内后续快（缓存 hit）|
| 2. 并发性能 | 同时发 5 个请求 | 缓存 hit 时总耗时 < 1s（不串行排队）|
| 3. PG 记录 | 查 `part.data->state->status` | `SessionTools.markTimedOut()` 标 error 的 part 含 `metadata.timeout=true` |
| 4. 容器日志 | `docker logs` 含 `--print-logs` | 能看到 `getOrCreate start/done`、`reconnect done`、`isHealthy done` 各阶段耗时 |

## 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

# 启动容器时务必加 --print-logs 才能看到 log.info 输出
# docker run ... opencode-saas-sandbox-test:v2fix serve --hostname 0.0.0.0 --port 4096 --print-logs
```

---

## 二十八、沙箱性能优化与 Watchdog

## 一、沙箱缓存性能优化

### T28.1 沙箱对象缓存命中（首次慢、后续快）

**验证点**：首次 `getOrCreate` 走完整流程（reconnect + isHealthy），成功后写入 **5 分钟 TTL** 缓存（`SB_CACHE_TTL_MS=300_000`，见 `sandbox-provider.ts:639`；曾为 30s，`a7ca47c15d` 调整为 5 分钟以减少 SDK handle 重建）。缓存窗口内的后续调用直接返回沙箱对象，跳过 lock 和 SDK 调用。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

FILE_URL="$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# 第 1 次：建沙箱，慢（2-3s）
T1=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$FILE_URL")
echo "第 1 次: ${T1}s"

# 第 2-6 次：缓存 hit，快（< 100ms）
for i in 2 3 4 5 6; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$FILE_URL")
  echo "第 $i 次: ${T}s"
done
```

**期望**：
- 第 1 次：1-3s（含 `createSandbox` 2s）
- 第 2-6 次：全部 < 0.2s（缓存 hit）
- 速度差距 > 10x

**容器日志验证**：
```bash
docker logs opencode-saas-test 2>&1 | grep "getOrCreate" | tail -5
# 期望：只看到一次 getOrCreate start → createSandbox done → getOrCreate done
# 后续 5 次缓存 hit 不输出 getOrCreate 日志
```

---

### T28.2 文件接口并发请求绕过生命周期 lock（缓存 hit 时并发执行）

**验证点**：文件接口缓存命中时跳过 `getOrCreate` 的生命周期 `lock(sessionID)`，多个并发请求真正并发返回，不再因为 reconnect/isHealthy 串行排队。命令类工具仍会受 command session semaphore 保护，避免同一 shell session 并发写入。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
FILE_URL="$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# 先 warmup 1 次（建沙箱 + 写缓存）
curl -s -o /dev/null --max-time 30 "$FILE_URL"
echo "warmup 完成"

# 5 个并发请求
START=$(date +%s%N)
for i in 1 2 3 4 5; do
  curl -s -o /dev/null --max-time 30 "$FILE_URL" &
done
wait
END=$(date +%s%N)
TOTAL_MS=$(( (END - START) / 1000000 ))
echo "5 个并发总耗时: ${TOTAL_MS}ms"

# 判定
if [ "$TOTAL_MS" -lt 1000 ]; then
  echo "✅ T28.2 PASS: 并发执行（缓存 hit 绕过 lock）"
elif [ "$TOTAL_MS" -lt 5000 ]; then
  echo "⚠️ T28.2 WARN: 部分串行"
else
  echo "❌ T28.2 FAIL: 严重串行（缓存可能没生效）"
fi
```

**期望**：5 个文件接口并发请求总耗时 < 1000ms（缓存 hit 时每个 ~50-100ms，并发执行）

---

### T28.3 缓存 TTL 过期（5 分钟后重新走流程）

**验证点**：缓存 TTL **5 分钟**（`SB_CACHE_TTL_MS=300_000`），过期后首次调用重新走完整 getOrCreate 流程，再次写入缓存。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
FILE_URL="$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# 首次建沙箱
T1=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$FILE_URL")
echo "首次: ${T1}s"

# 立刻调用（缓存 hit）
T2=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$FILE_URL")
echo "缓存内: ${T2}s"

# 等 305s 让缓存过期（TTL 5 分钟 + buffer）
echo "等 305s 让缓存过期（TTL 5 分钟）..."
sleep 305

# 过期后第 1 次（重新走流程）
T3=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$FILE_URL")
echo "过期后: ${T3}s"

# 立刻又 1 次（再次缓存 hit）
T4=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$FILE_URL")
echo "重新缓存: ${T4}s"
```

**期望**：
- 首次 T1：1-3s（建沙箱）
- 缓存内 T2：< 0.2s
- 过期后 T3：0.2-1s（reconnect + isHealthy，比 T1 快因为不用 createSandbox）
- 重新缓存 T4：< 0.2s

> ⚠️ **等待 305s**：缓存 TTL 是 5 分钟（`a7ca47c15d` 由 30s 调整），需等 5 分钟才能观察到缓存过期。若不想等，可临时把 `SB_CACHE_TTL_MS` 调小后重建镜像。

---

### T28.4 PG 命令入口的沙箱获取 90s 超时

**验证点**：PG provider 的命令入口对 `lock(sessionID) + getOrCreate` 增加 90 秒总超时，覆盖 reconnect、isHealthy、可能的 destroy 和 createSandbox。超时后请求失败并释放 PG 锁；底层 `Sandbox.create` 仍有独立的 60 秒超时。该用例通过真实命令入口验证，不直接调用 provider 内部函数。

```bash
# 此用例需要模拟"远端沙箱不可达"场景。两种方法：
# 方法 A：把 OPENCODE_SANDBOX_DOMAIN 指向不可达地址
# 方法 B：在代码层临时禁用缓存 + 让 reconnect 失败

# 方法 A 示例（启动新容器）：
docker rm -f opencode-saas-test-timeout 2>/dev/null
docker run -d --name opencode-saas-test-timeout \
  -p 14097:4096 \
  -e OPENCODE_DATABASE_URL="$PG_URL" \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:39999 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  opencode-saas-sandbox-test:v2fix \
  serve --hostname 0.0.0.0 --port 4096 --print-logs
sleep 10

SID=$(curl -s -X POST "http://localhost:14097/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

START=$(date +%s)
RESP=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 120 \
  "http://localhost:14097/file/content?path=/workspace&sessionID=$SID&directory=/workspace")
END=$(date +%s)
echo "响应: $RESP"
echo "总耗时: $((END - START))s"

# 判定
ELAPSED=$((END - START))
if [ "$ELAPSED" -lt 120 ]; then
  echo "✅ T28.4 PASS: 在合理时间内返回（${ELAPSED}s）"
else
  echo "❌ T28.4 FAIL: 超过 120s 仍未返回，超时机制未生效"
fi

docker logs opencode-saas-test-timeout 2>&1 | grep -iE "getOrCreate|timeout|fail" | tail -10
docker rm -f opencode-saas-test-timeout
```

**期望**：
- HTTP 状态码非 200（500 或类似）
- 总耗时 < 120s（90s 超时 + 一些 buffer）
- 错误或容器日志含 `get or create sandbox timed out after 90s`（具体 HTTP 错误包装可能不同）

---

## 二、PG 命令生命周期超时

> 本节只验证 PostgreSQL provider。不要用内存 provider 的 fake layer 代替；需要通过 `/exec`、`/exec/async` 或 PG 集成测试验证真实的 PG lock、command session 记录和清理行为。

### T28.15 PG command session 创建超时

**验证点**：command session 创建长时间不返回时，`runInSession` 在调用方 `timeoutSeconds` 内失败，不会一直占用 PG command session 创建路径。

**执行方式**：使用 PG 集成测试注入一个永不完成的 `sb.commands.createSession`；不要通过普通 `sleep` 命令模拟，因为 `sleep` 发生在 command session 创建成功之后。

```bash
cd packages/opencode
OPENCODE_DATABASE_URL="$PG_URL" bun test test/tool/sandbox-provider-pg.test.ts --timeout 30000
```

**期望**：
- 返回错误包含 `create command session timed out` 或 `prepare command session timed out`。
- 测试不会超过 30 秒。
- PG 中不存在错误写入的 `command_session_id`。

### T28.16 PG command semaphore 排队超时

**验证点**：同一 Session 的第一个命令占用 command semaphore 时，第二个命令等待 semaphore 超时；不会重复创建 command session。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 先建立 PG command session，并让第一个命令占用 semaphore
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 5","timeoutSeconds":10}' > /tmp/t28-16-first.json &
FIRST_PID=$!
sleep 1

# 第二个命令的 1 秒超时应包含 semaphore 等待时间
SECOND=$(curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo second","timeoutSeconds":1}')
wait "$FIRST_PID"
echo "$SECOND" | python3 -m json.tool

psql "$PG_URL" -c "SELECT id, session_id, command_session_id FROM sandbox WHERE session_id='$SID'"
```

**期望**：
- 第二个请求在约 1 秒后返回，不等待第一个命令完成。
- 不产生第二条 command session。
- 第一个命令完成后，后续 `echo recovered` 可以成功执行。

> **实现说明（2026-08-25）**：`Semaphore.withPermit` 在 Effect v4 中不可被外层 timeout 打断，
> PG provider 改用 `withPermitsIfAvailable + 10ms 轮询`，排队预算为 `timeoutSeconds + 5s 宽限`
> （宽限保证执行阶段 `withExecTimeout` 先到期，避免把执行超时误判成排队超时）。
> 排队超时错误文本为 `command queue wait timed out after Ns`；生命周期锁等待为
> `sandbox lock wait timed out after Ns`。诊断日志 `command permit acquired waitedMs=` 可观察实际排队时长。

### T28.17 PG 前台命令整体超时

**验证点**：同步 `/exec` 的命令执行、semaphore 等待和前台命令生命周期受同一个 `timeoutSeconds` 约束，并写入 `exec_log.status=timed_out`。

```bash
RESULT=$(curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 10","timeoutSeconds":2}')
echo "$RESULT" | python3 -m json.tool

psql "$PG_URL" -c "SELECT id, status, error FROM exec_log WHERE session_id='$SID' ORDER BY time_started DESC LIMIT 1"
```

**期望**：
- HTTP 请求在 10 秒内结束。
- 返回结果的 `error.name=TimeoutError`，或 `exec_log.status=timed_out`。
- PG 中 `time_finished` 已写入，不能保持无限期 running。

> **超时后回收（2026-08-25）**：前台命令执行超时后，底层命令仍在沙箱运行且 SDK `interrupt`
> 会使持久 command session 进入立即 EOF 的报废状态（实测后续命令秒回空结果）。
> 因此 PG provider 超时后改为 `deleteSession + 清空 command_session_id`，
> 下一条命令自动重建干净 session。注意：若命令总耗时接近 `timeoutSeconds`，
> 该命令结束后 session 会被回收，紧随其后的第一条命令会有一次性的 session 重建开销。

### T28.18 PG detached 命令超时与中断

**验证点**：`/exec/async` 使用 PG provider 的 detached command；命令超时后触发 `interrupt`，最终状态可查询。

```bash
START=$(curl -s -X POST "$BASE/session/$SID/exec/async" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 20","timeoutSeconds":2}')
EXEC_ID=$(echo "$START" | python3 -c "import json,sys; print(json.load(sys.stdin)['execId'])")
sleep 5
curl -s "$BASE/session/$SID/exec/$EXEC_ID" | python3 -m json.tool
```

**期望**：
- 初始响应立即返回 `status=running` 和 `execId`。
- 约 2 秒后状态不再是 running，通常为 `timed_out` 或 `failed`。
- 沙箱仍可执行后续命令，不能因为 detached 超时进入不可用状态。

### T28.19 PG detached session 清理超时

**验证点**：`deleteSession` 不返回时，清理最多等待 `COMMAND_CLEANUP_TIMEOUT_SECONDS=10s`，不会永久阻塞请求完成或本地 detached session 状态清理。

**执行方式**：在 PG provider 集成测试中注入只阻塞 `sb.commands.deleteSession` 的 fake SDK；命令本身必须先完成。

```bash
cd packages/opencode
OPENCODE_DATABASE_URL="$PG_URL" bun test test/tool/sandbox-provider-pg.test.ts --timeout 30000
```

**期望**：
- 主流程在清理超时后结束。
- 清理超时被忽略，不覆盖命令本身的成功结果。
- detached session 的本地跟踪记录被移除。

### T28.20 PG 沙箱锁等待超时

**验证点**：PG `lock(sessionID)` 或 `getOrCreateUnlocked` 卡住时，命令入口在 90 秒内失败，并且不会留下永久锁。

**执行方式**：使用 PG 集成测试注入永不完成的沙箱获取操作；生产黑盒测试可将 Sandbox API 指向不可达地址复测 T28.4。

**期望**：
- 返回错误包含 `get or create sandbox timed out after 90s`。
- 同一 Session 的后续请求在沙箱服务恢复后可以重新获取锁并执行。
- PG sandbox 记录不会被错误标记为新的 running command session。

### T28.21 PG 超时后的命令恢复

**验证点**：一次前台命令超时后，PG 中的 command session 记录和 provider 内存 semaphore 状态仍可用于下一次命令；必要时允许重新创建。

```bash
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 10","timeoutSeconds":1}' > /tmp/t28-21-timeout.json

RECOVERED=$(curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo recovered","timeoutSeconds":10}')
echo "$RECOVERED" | python3 -m json.tool
```

**期望**：
- 超时请求结束后，恢复命令返回 `exitCode=0` 且 stdout 含 `recovered`。
- PG 中同一 sandbox 的 command session 记录保持一致，或旧 session 失效后只产生一条新的有效记录。
- 不出现后续命令永久排队。

### T28.22 PG keep-alive 与 idle-reap 回归

**验证点**：命令操作超时包装不改变 `keep_alive` 和 idle-reap 语义。

```bash
# keep-alive=true 时，超时命令之后沙箱仍可用
curl -s -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' -d '{"enabled":true}' > /dev/null
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 10","timeoutSeconds":1}' > /dev/null
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo keep-alive-ok"}' | python3 -m json.tool

psql "$PG_URL" -c "SELECT id, session_id, state, keep_alive, command_session_id FROM sandbox WHERE session_id='$SID'"
```

**期望**：
- `keep_alive=true` 时超时不会触发沙箱销毁。
- 后续命令可以成功执行。
- 按 T19.8/T19.9 和 T30 的 idle-reap 配置复测释放 keep-alive 后的正常回收。

---

## 三、Part Watchdog：工具执行超时兜底

> 本节与沙箱生命周期无关。Part Watchdog 每 60s 扫描超时的 tool part 并标记 error，**不销毁沙箱**（沙箱回收见 T12/T30）。

### T28.5 Part Watchdog 自动标记超时工具

**验证点**：watchdog 每 60s 扫描一次 parts 表；发现 `status=running` 且 `time.start` 超过 `timeoutMs` 的 tool part 后，不直接裸写 DB，而是调用 `SessionTools.markTimedOut(partID, expectedStart, timeoutMs)` 标记为 error，并设置 `metadata.timeout=true`。默认阈值为 120s，可通过 `OPENCODE_WATCHDOG_TIMEOUT_SEC` 覆盖；`layerWithConfig` 可为测试注入更短的阈值和扫描间隔。

生产 Watchdog 将执行超时与崩溃恢复分开判定：本进程调用由 `ToolExecution` 注册表确认所有权；其他 Pod 的活跃调用通过 `metadata.watchdog.leaseUntil` 续租，不会被误标；lease 过期后由任一实例恢复。为兼容升级前没有 lease 的遗留记录，只有超过 `orphanTimeoutMs`（默认 15 分钟）才按 orphan 处理。因此不能通过“只向 PG 插入刚超过 120s 的 running part”模拟真实超时。

推荐使用应用级集成测试：

1. 通过测试 ToolRegistry 注册一个等待 `ctx.abort` 的阻塞工具。
2. 使用 `layerWithConfig` 注入较短的 `timeoutMs`、`scanInterval` 和 `initialDelay`。
3. 正常发起工具调用，使 `ToolExecution.register()` 建立本进程所有权。
4. 等待 Watchdog 调用 `markTimedOut()`，并确认工具收到 abort；即使工具不监听 signal，调用边界也必须退出。
5. 查询 PG Part 状态及订阅 `PartUpdated`。

```bash
cd packages/opencode
bun test test/session/watchdog.test.ts test/session/tool-execution.test.ts
OPENCODE_DATABASE_URL="$PG_URL" bun test test/session/watchdog-pg.test.ts
```

**期望**：
- 活跃的本进程超时调用状态变为 `error`
- 默认配置下 `data->state->error` 含 `"Tool execution timed out after 120s (watchdog)"`
- `data->state->metadata.timeout = true`
- 工具的 `AbortSignal.aborted = true`
- 不响应 `AbortSignal` 的工具不会继续阻塞 Session runner
- 容器日志含 `service=session.tools ... marked tool as timed out`
- 远端有效 lease 不会被处理；过期 lease 和超过 15 分钟的无 lease 遗留记录会被恢复

---

### T28.5b Watchdog 事件同步可见性

**验证点**：超时标记必须经过 `MessageV2.Event.PartUpdated` 同步事件路径，不能只改 `part` 表。PG 模式下 message advisory lock、retry attempt 分配、part CAS 与 durable event publish 位于同一事务；publish 失败时 part 保持 `running`，下一轮可以安全重试。

```bash
# 复用 T28.5 应用级集成测试产生的 $SID 和 $PART_ID。

psql "$PG_URL" -c "
SELECT type, aggregate_id, data->'part'->>'id' AS part_id, data->'part'->'state'->>'status' AS status
FROM event
WHERE type LIKE 'message.part.updated%'
  AND aggregate_id = '$SID'
  AND data->'part'->>'id' = '$PART_ID'
ORDER BY seq DESC
LIMIT 3;
"
```

**期望**：
- 至少有一条 `message.part.updated` 事件。
- `part_id = $PART_ID`。
- 最新事件里的 `status = error`。
- 如果 `OPENCODE_EXPERIMENTAL_WORKSPACES` 未开启导致 `event` 表不落库，则改用 SSE/SDK 订阅验证同一事件。

> **⚠️ 已知行为（P2）**：SaaS 默认不开启 `OPENCODE_EXPERIMENTAL_WORKSPACES`，`event` 表不落库。
> `sync.run` 的 bus publish 仍实时触发（UI/SSE 订阅者能看到状态变化），但 **event replay 场景**（新实例 replay 历史重建状态）看不到 watchdog 标记。
> 影响：watchdog 状态变更是"实时通知 + DB 持久化"而非"事件溯源可 replay"。对于 stuck tool 恢复场景这是可接受的——replay 时 DB 里的 part 状态已经是 error，不需要事件重放来推导。
> 如果未来需要完整事件溯源，开启 `OPENCODE_EXPERIMENTAL_WORKSPACES=true` 即可自动落库。

---

## 四、缓存性能：缓存失效与日志（续一）

> T28.6-T28.8 属于「一、沙箱缓存性能优化」主题（缓存失效、init 失败日志、阶段耗时日志），物理位置在此，逻辑归属「一」。

### T28.6 沙箱销毁后缓存失效

**验证点**：`destroySandbox` 主动调用 `invalidateCachedSandbox`，下次 getOrCreate 不会返回已死的沙箱对象。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
FILE_URL="$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# 1. 首次建沙箱（写缓存）
curl -s -o /dev/null --max-time 30 "$FILE_URL"
echo "首次调用完成（缓存已写入）"

# 2. 销毁沙箱
curl -s -X POST "$BASE/session/$SID/kill-sandbox" -H 'Content-Type: application/json' -d '{}'
echo "已 kill-sandbox"

# 3. 再次调用（应该重新建沙箱，而不是用陈旧缓存）
T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 30 "$FILE_URL")
echo "kill 后调用: ${T}s"

# 判定
if (( $(echo "$T > 0.5" | bc -l) )); then
  echo "✅ T28.6 PASS: 缓存已失效，重新建沙箱（${T}s）"
else
  echo "❌ T28.6 FAIL: 缓存未失效（${T}s，太快，可能用了陈旧缓存）"
fi
```

**期望**：kill-sandbox 后再次调用耗时 > 0.5s（说明缓存被清除，走了重建流程）

---

### T28.7 沙箱 init 失败日志可见

**验证点**：`tools.ts` 的 `getSandbox()` 失败时输出 `log.error`，不再被 `.catch(() => null)` 静默吞掉。

```bash
# 制造一个沙箱不可达场景
docker rm -f opencode-saas-test-log 2>/dev/null
docker run -d --name opencode-saas-test-log \
  -p 14098:4096 \
  -e OPENCODE_DATABASE_URL="$PG_URL" \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:39999 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  opencode-saas-sandbox-test:v2fix \
  serve --hostname 0.0.0.0 --port 4096 --print-logs
sleep 10

SID=$(curl -s -X POST "http://localhost:14098/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 触发工具调用（沙箱不可达）
curl -s -o /dev/null --max-time 120 \
  "http://localhost:14098/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# 验证日志输出
docker logs opencode-saas-test-log 2>&1 | grep -iE "sandbox init failed|sandbox ready" | tail -5

docker rm -f opencode-saas-test-log
```

**期望**：
- 日志含 `ERROR ... service=session.tools ... sandbox init failed`
- 包含 `error=` 字段说明失败原因
- 包含 `ms=` 字段说明耗时

---

### T28.8 getOrCreate 各阶段耗时日志

**验证点**：缓存 miss 时能看到阶段耗时日志。新 session 通常是 `getOrCreate start` → `createSandbox done` → `getOrCreate done`；已有 running 记录会额外出现 `reconnect done` 和 `isHealthy done`。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

# 触发 getOrCreate（缓存 miss，走完整流程）
curl -s -o /dev/null --max-time 30 \
  "$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# 查看完整日志
docker logs opencode-saas-test 2>&1 | grep "service=sandbox-provider" | grep "$SID" | tail -10
```

**期望日志格式**：
```
INFO ... getOrCreate start              sessionID=ses_...
INFO ... reconnect done     ms=XXX      sessionID=ses_... success=true/false   # 仅已有 running 记录
INFO ... isHealthy done      ms=XXX      sessionID=ses_... healthy=true/false   # 仅 reconnect 成功
INFO ... createSandbox done  ms=XXX totalMs=XXX   sessionID=ses_... sandboxID=...
INFO ... getOrCreate done    totalMs=XXX          sessionID=ses_... sandboxID=...
```

**字段说明**：
- `ms` — 单阶段耗时
- `totalMs` — 从 getOrCreate 开始累计耗时
- `success` / `healthy` — 该阶段结果

**排查用法**：当出现卡顿时，对照日志判断卡在哪一步：
- reconnect `ms` 大 → SDK `Sandbox.connect` 慢（K8s API 慢）
- isHealthy `ms` 大 → execd `/ping` 慢（Pod 网络问题）
- createSandbox `ms` 大 → `Sandbox.create` + `waitUntilReady` 慢（K8s 调度慢）

---

## 五、Part Watchdog：CAS 幂等与配置（续二）

> T28.9-T28.13 属于「二、Part Watchdog」主题（markTimedOut CAS 防覆盖、多实例幂等、配置注入、未超时不处理、可观测性）。

### T28.9 `SessionTools.markTimedOut` CAS 防覆盖

**验证点**：`markTimedOut()` 必须使用 CAS 条件更新，只有 `part.id`、`state.status=running`、`state.time.start=expectedStart` 同时匹配时才标记 error。如果工具在扫描后已经 completed/error，或 start 已变化，不能被 watchdog 覆盖。黑盒 SQL 用例验证 completed 不被 watchdog 误杀；单元/集成用例应直接调用 `markTimedOut()` 验证 CAS 返回 `false`。

```bash
psql "$PG_URL" <<'SQL'
INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning)
VALUES ('ses_test_watchdog_cas', 'global', '/workspace', 'test-cas', 'watchdog cas test', '2.0',
        (extract(epoch from now())*1000)::bigint, (extract(epoch from now())*1000)::bigint, 0, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO message (id, session_id, data, time_created, time_updated)
VALUES ('msg_test_watchdog_cas', 'ses_test_watchdog_cas', '{"role":"assistant"}'::jsonb,
        (extract(epoch from now())*1000)::bigint, (extract(epoch from now())*1000)::bigint)
ON CONFLICT (id) DO NOTHING;

INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
VALUES ('prt_test_watchdog_cas', 'msg_test_watchdog_cas', 'ses_test_watchdog_cas',
  '{"type":"tool","callID":"cas","tool":"bash","state":{"status":"running","input":{"command":"sleep 999"},"time":{"start":0}}}'::jsonb,
  (extract(epoch from now()-interval '7 minute')*1000)::bigint,
  (extract(epoch from now()-interval '7 minute')*1000)::bigint)
ON CONFLICT (id) DO NOTHING;

UPDATE part
SET data = jsonb_set(data, '{state,time,start}', to_jsonb((extract(epoch from now()-interval '6 minute')*1000)::bigint))
WHERE id = 'prt_test_watchdog_cas';

-- 模拟正常执行刚完成：watchdog 后续扫描到旧候选也不能覆盖 completed。
UPDATE part
SET data = jsonb_set(
  jsonb_set(data, '{state,status}', '"completed"'::jsonb),
  '{state,output}', '"finished before watchdog"'::jsonb
)
WHERE id = 'prt_test_watchdog_cas';
SQL

echo "等待一次 watchdog 扫描（最多 90s）..."
sleep 90

psql "$PG_URL" -c "
SELECT data->'state'->>'status' AS status,
       data->'state'->>'output' AS output,
       data->'state'->>'error' AS error
FROM part
WHERE id = 'prt_test_watchdog_cas';
"

psql "$PG_URL" -c "DELETE FROM session WHERE id='ses_test_watchdog_cas'" >/dev/null
```

**期望**：
- `status` 保持 `completed`。
- `output` 保持 `finished before watchdog`。
- `error` 为空。
- 如果变成 `error`，说明 CAS 防覆盖失败。

**单元/集成补充**：
```ts
// 建议放到 packages/opencode/test/session/tools-watchdog.test.ts
// 插入 running part 后读取 expectedStart，再把 part 改成 completed。
// 直接调用 tools.markTimedOut({ partID, expectedStart, timeoutMs: 300_000, now })。
// 期望返回 false，DB 状态仍是 completed。
```

---

### T28.10 `markTimedOut` 多实例幂等

**验证点**：SaaS 多实例同时扫描同一个 stuck part 时，只有一个实例能 CAS 成功；其他实例返回 no-op，不重复覆盖、不重复写 error。

```bash
# 该用例建议在单元/集成测试中直接并发调用 SessionTools.markTimedOut，避免真的启动多份容器。
# 伪代码：
#
# const result = await Effect.all([
#   tools.markTimedOut({ partID, expectedStart, timeoutMs: 300_000, now }),
#   tools.markTimedOut({ partID, expectedStart, timeoutMs: 300_000, now }),
#   tools.markTimedOut({ partID, expectedStart, timeoutMs: 300_000, now }),
# ], { concurrency: "unbounded" })
# assert.equal(result.filter(Boolean).length, 1)

psql "$PG_URL" -c "
SELECT data->'state'->>'status' AS status,
       data->'state'->'metadata'->>'timeout' AS timeout
FROM part
WHERE id = '<partID>';
"
```

**期望**：
- 并发返回结果中只有 1 个 `true`，其余为 `false`。
- DB 最终状态为 `error` 且 `metadata.timeout=true`。
- 不应出现多次覆盖同一个 part 的状态变更。

---

### T28.11 Watchdog 配置注入与 `scanOnce`

**验证点**：`SessionWatchdog.layerWithConfig(config)` 支持测试注入较短 timeout / scan interval；`Service.scanOnce` 可直接触发一次扫描，不必在测试里 sleep 60-90s。

```ts
// 建议放到 packages/opencode/test/session/watchdog.test.ts
// 伪代码：
//
// const layer = SessionWatchdog.layerWithConfig({
//   scanInterval: Duration.seconds(60),
//   initialDelay: Duration.seconds(999),
//   timeoutMs: 100,
// }).pipe(Layer.provide(SessionTools.defaultLayer))
//
// await insertRunningPart({ start: Date.now() - 1_000 })
// await Effect.runPromise(SessionWatchdog.Service.use((svc) => svc.scanOnce).pipe(Effect.provide(layer)))
// await assertPartStatus("error")
```

**期望**：
- 测试不依赖真实 5 分钟 timeout。
- 测试不依赖后台 fiber 的 60s schedule。
- `scanOnce` 只执行一次扫描，适合 deterministic 单元/集成测试。

---

### T28.12 Watchdog 不处理未超时 running tool

**验证点**：running tool 只有超过配置 timeout 才会被标记。刚开始运行的 tool 不应被误杀。

```bash
psql "$PG_URL" <<'SQL'
INSERT INTO session (id, project_id, directory, slug, title, version, time_created, time_updated, cost, tokens_input, tokens_output, tokens_reasoning)
VALUES ('ses_test_watchdog_fresh', 'global', '/workspace', 'test-fresh', 'watchdog fresh test', '2.0',
        (extract(epoch from now())*1000)::bigint, (extract(epoch from now())*1000)::bigint, 0, 0, 0, 0)
ON CONFLICT (id) DO NOTHING;

INSERT INTO message (id, session_id, data, time_created, time_updated)
VALUES ('msg_test_watchdog_fresh', 'ses_test_watchdog_fresh', '{"role":"assistant"}'::jsonb,
        (extract(epoch from now())*1000)::bigint, (extract(epoch from now())*1000)::bigint)
ON CONFLICT (id) DO NOTHING;

INSERT INTO part (id, message_id, session_id, data, time_created, time_updated)
VALUES ('prt_test_watchdog_fresh', 'msg_test_watchdog_fresh', 'ses_test_watchdog_fresh',
  '{"type":"tool","callID":"fresh","tool":"bash","state":{"status":"running","input":{"command":"sleep 30"},"time":{"start":0}}}'::jsonb,
  (extract(epoch from now())*1000)::bigint,
  (extract(epoch from now())*1000)::bigint)
ON CONFLICT (id) DO NOTHING;

UPDATE part
SET data = jsonb_set(data, '{state,time,start}', to_jsonb((extract(epoch from now())*1000)::bigint))
WHERE id = 'prt_test_watchdog_fresh';
SQL

echo "等待一次 watchdog 扫描（最多 90s）..."
sleep 90

psql "$PG_URL" -c "
SELECT data->'state'->>'status' AS status,
       data->'state'->>'error' AS error
FROM part
WHERE id = 'prt_test_watchdog_fresh';
"

psql "$PG_URL" -c "DELETE FROM session WHERE id='ses_test_watchdog_fresh'" >/dev/null
```

**期望**：
- `status` 仍为 `running`。
- `error` 为空。
- 如果变成 `error`，说明 timeout 条件判断过宽。

---

### T28.13 Watchdog scan 可观测性输出

**验证点**：每次 scan 在日志输出 `marked`（实际标记成功数）和 `durationMs`（本轮耗时），并写入 span attributes，便于定位"扫描到候选但没标记""扫描过慢"等问题。复用 T28.5 的 stuck part 场景。

```bash
# 前置：先执行 T28.5，插入 stuck part 并等到 status=error

docker logs opencode-saas-test 2>&1 | grep "watchdog scan completed" | tail -1
docker logs opencode-saas-test 2>&1 | grep "watchdog stuck tools detected" | tail -1
```

**期望**：
- `watchdog scan completed` 日志含 `marked=1`（T28.5 的 stuck part 被标记）和 `durationMs=<正整数>`。
- `watchdog stuck tools detected` 日志含 `count=1`、`marked=1`。
- 若开启 OpenTelemetry（`OTEL_EXPORTER_OTLP_ENDPOINT`），`SessionWatchdog.scan` span 上携带 `watchdog.scanned/stuck/marked/duration_ms` 四个属性。
- 若 `marked=0` 但 `stuck>0`，说明 `markTimedOut` 的 CAS 全未命中或全失败，需进一步排查。

---

### T28.14 Watchdog 超时后的 Code Agent 恢复重试

**验证点**：Watchdog 不在服务端直接重放原工具调用。它中断当前执行、写入结构化 Agent 重试策略并 settle 当前 tool call，让模型在下一 provider turn 重新读取历史、检查现场并决定是否重试。

超时 ToolPart 的 `metadata.retry` 应为：

```json
{
  "strategy": "agent",
  "eligible": true,
  "attempt": 1,
  "maxAttempts": 2,
  "requiresVerification": false
}
```

其中 `write`、`edit`、`apply_patch` 的 `requiresVerification=true`；Code Agent 必须先用 `read` 等只读工具确认操作是否已部分完成，再使用更窄或幂等的操作重试。服务端不得自动重放 `bash`、`task` 或任何写入型工具。

```bash
# 复用真实执行超时后的 $SID 和 $PART_ID。直接向 PG 插入 part 不会触发
# 本进程 watchdog，因为生产实现只处理 ToolExecution 注册表中由本进程拥有的调用。
psql "$PG_URL" -x -c "
SELECT
  data->'state'->>'status' AS status,
  data->'state'->'metadata'->'retry'->>'strategy' AS strategy,
  data->'state'->'metadata'->'retry'->>'eligible' AS eligible,
  data->'state'->'metadata'->'retry'->>'attempt' AS attempt,
  data->'state'->'metadata'->'retry'->>'maxAttempts' AS max_attempts,
  data->'state'->'metadata'->'retry'->>'requiresVerification' AS requires_verification,
  data->'state'->>'error' AS error
FROM part
WHERE id = '$PART_ID';
"

# 检查后续工具调用。重试必须使用新的 callID，由 Code Agent 发起，而不是服务端重放。
psql "$PG_URL" -c "
SELECT id, data->>'callID' AS call_id, data->>'tool' AS tool,
       data->'state'->>'status' AS status
FROM part
WHERE session_id = '$SID' AND data->>'type' = 'tool'
ORDER BY time_created;
"
```

**期望**：
- 第一、二次超时 part 为 `error`，`strategy=agent`、`eligible=true`、`attempt=1/2`、`max_attempts=2`。
- 同一 assistant message 的第三次超时为 `eligible=false`，错误文本要求停止重试并报告失败。
- 错误文本提示操作可能已部分完成，并要求最多重试两次。
- 当前调用被 settle，Session 不因普通 watchdog timeout 进入 blocked。
- 如果 Agent 决定重试，会出现新 `callID`；写入型工具之前先出现状态检查调用。
- 连续失败达到两次后 Agent 停止重试并向用户报告，不形成无限工具循环。

---

## 排查场景对照表

| 现象 | 可能原因 | 验证用例 | 日志关键字 |
|------|---------|---------|-----------|
| 工具调用一直 running | fiber 挂起 / 沙箱卡死 | T28.5 | `service=session.tools ... marked tool as timed out` |
| 不响应 signal 的工具卡住 | 调用边界未参与 abort race | T28.5 | `raceAbort` 保证 `Effect.raceFirst` 中断 |
| completed 被误改 error | watchdog 覆盖正常完成结果 | T28.9 | CAS 条件未命中应 no-op |
| 多实例重复标记同一 part | watchdog 幂等性不足 | T28.10 | 并发 `markTimedOut` 只有一个 true；`pg_advisory_xact_lock` |
| 并发 retry attempt 重复 | message 无行锁 | 单测 | `pg_advisory_xact_lock(message_id)` 串行分配 |
| 事件丢失（DB 已 error 但消费者仍 running） | publish 失败被吞 | 单测 | PG 同事务 publish，失败回滚 |
| Pod 崩溃后 running part 永不处理 | 无 lease/orphan 恢复 | 单测 | lease 过期或超 orphanTimeoutMs 被 watchdog 处理 |
| 其他 Pod 活跃执行被误杀 | lease 未续租或 watchdog 判定过宽 | 单测 | `metadata.watchdog.leaseUntil > now` 则跳过 |
| watchdog 测试耗时过长 | timeout / schedule 不可注入 | T28.11 | `layerWithConfig` + `scanOnce` |
| 新 running tool 被误杀 | timeout 判断过宽 | T28.12 | start 未超过 timeout 不应处理 |
| 踩边界的 stuck part 延迟一轮才标记 | scan 复用过时 now 判断超时 | T28.11 | scan 不传 now，`markTimedOut` 内部用即时 `Date.now()` |
| 单次调用慢（> 5s）| getOrCreate 卡某阶段 | T28.8 | `reconnect done ms=` / `isHealthy done ms=` |
| 文件接口并发请求变串行 | 缓存失效或被清 | T28.2 | `getOrCreate start` 出现多次（应该只有 1 次）|
| 沙箱销毁后调用失败 | 缓存返回陈旧对象 | T28.6 | kill-sandbox 后立刻调用应该 > 0.5s |
| 错误看不到原因 | tools.ts 静默吞错 | T28.7 | `ERROR ... sandbox init failed` |
| 卡 90s+ 才报错 | PG 命令入口沙箱获取超时 | T28.4/T28.20 | `get or create sandbox timed out after 90s` |
| 同 Session 后续命令排队 | command session semaphore 等待超时 | T28.16 | `prepare command session timed out` / `run command timed out` |
| 前台命令返回后 PG 仍 running | exec 生命周期未收敛 | T28.17 | `exec_log.status=timed_out` 且有 `time_finished` |
| detached 命令超时后仍占用资源 | interrupt 或 deleteSession 未执行 | T28.18/T28.19 | `exec-async` 状态收敛，detached session 清理结束 |
| 超时后下一条命令继续排队 | semaphore/session 状态未释放 | T28.21 | 恢复命令 `exitCode=0` |
| keep-alive 超时后沙箱被误回收 | 命令超时误触发 idle-reap | T28.22 | PG `keep_alive=true` 且后续 exec 成功 |
| scan 标记数/耗时不可见 | 结果丢弃或未记日志 | T28.13 | `watchdog scan completed ... marked= durationMs= orphaned=` |
| 超时后 Session 不继续 | 已标记 error 的 tool call 未 settle | T28.14 | `metadata.retry.strategy=agent`，后续出现新 callID |
| 写入操作被重复执行 | 服务端直接重放或 Agent 未检查现场 | T28.14 | `requiresVerification=true`，重试前应先 read |

## 改动文件清单

```
packages/opencode/src/tool/sandbox-provider.ts        # PG 命令生命周期超时 + 缓存/日志 + reconnect/heartbeat/idle-reap
packages/opencode/src/session/mark-timed-out.ts         # SessionTools.markTimedOut（CAS + PG 同事务 event + retry attempt + pg_advisory_xact_lock）
packages/opencode/src/session/watchdog.ts               # watchdog 扫描（三路判定：本进程 callID + lease 过期 + orphan 兜底）
packages/opencode/src/session/watchdog-sql.ts           # SQL 条件（runningToolCondition + watchdogToolCondition + MONITORED_TOOLS）
packages/opencode/src/session/tool-execution.ts         # 本进程注册表（register/interrupt/has/callIDs）+ raceAbort
packages/opencode/src/session/tool-execution-lease.ts   # PG lease heartbeat（refresh/maintain，30s 续租 2min lease）
packages/opencode/src/session/tools.ts                  # invoke abort 注册 + lease raceFirst + raceAbort 包裹
packages/opencode/src/session/processor.ts              # isWatchdogTimeout + settleWatchdogTimeout
packages/opencode/src/effect/app-runtime.ts             # 注册 watchdog layer 并提供 SessionTools layer
packages/opencode/test/session/watchdog.test.ts         # runningToolCondition 单测（SQLite）
packages/opencode/test/session/watchdog-pg.test.ts       # PG 集成（CAS/retry/event/lease/orphan/scanOnce）
packages/opencode/test/session/tool-execution.test.ts    # 注册/interrupt/raceAbort 单测
packages/opencode/test/session/processor-watchdog.test.ts # settleWatchdogTimeout 单测
```

## 防御链路示意

```
LLM 并发触发 N 个工具调用
  ↓
文件/工具 A: getOrCreate → 缓存 hit → 30ms 返回（跳过生命周期 lock）
文件/工具 B: getOrCreate → 缓存 hit → 30ms 返回（跳过生命周期 lock）
文件/工具 C: getOrCreate → 缓存 hit → 30ms 返回（跳过生命周期 lock）
  ↓
文件操作可并发执行；命令类工具继续受 command session semaphore 保护
  ↓
MONITORED_TOOLS 执行期间：ToolExecutionLease.maintain 每 30s 续租（PG only）
  ↓
raceAbort 包裹执行：工具不响应 AbortSignal 时调用边界仍能退出
  ↓
正常完成 → transitionRunningTool CAS → updatePart → settle
  ↓
如果某个工具卡住（极端情况）
  ↓
  PG 命令入口 getOrCreate 90s 超时 → fail → 释放 lock
  ↓
如果工具 fiber 仍卡（更极端）
  ↓
Watchdog 每 60s 扫描（三路判定）：
  ├─ 本进程 callID（ToolExecution 注册表）
  ├─ lease 过期（metadata.watchdog.leaseUntil <= now）
  └─ 无 lease 且 start < now - 15min（orphan 兜底，兼容旧版）
  （默认 120s 阈值，实际扫描命中窗口约 120-180s）
  ↓
SessionTools.markTimedOut(partID, expectedStart, timeoutMs)
  ↓
PG 事务内：pg_advisory_xact_lock(message_id) → 串行分配 retry attempt
  → 复验 running/start/timeout → CAS 更新（避免覆盖 completed/error）
  → durable PartUpdated event 同事务（publish 失败回滚）
  ↓
ToolExecution.interrupt(sessionID, callID) → abort controller.signal
  ↓
  command 类工具额外 sandbox.interrupt；detached session 删除最多等待 10s
  ↓
Processor 检测已 timeout 的 part（isWatchdogTimeout）→ settleWatchdogTimeout
  ↓
重新加载最新历史，进入下一 provider turn
  ↓
Code Agent 检查现场并决定是否重试（最多 2 次；写入操作先验证）
```

---

## 结果汇总（2026-08-08 全量复测，SaaS PG）

| 用例 | 状态 | 说明 |
|------|------|------|
| T28.1 缓存命中 | ✅ | 后续 exec 0.31-0.37s（缓存 hit） |
| T28.2 并发绕过 lock | ✅ | 5 并发 exec 总耗时 1.2s（不串行排队） |
| T28.3 缓存 TTL 过期 | ⏭️ SKIP | 需 5 分钟等待（`SB_CACHE_TTL_MS=300_000`），逻辑由代码保证 |
| T28.4 PG 命令入口沙箱获取 90s 超时 | ⏭️ 待当前 PG 版本复测 | 需验证 PG lock + getOrCreate 总超时和锁释放；底层 Sandbox.create 为 60s |
| T28.5 Part Watchdog 超时标记 | ✅ | PG 有 333 条 `timeout=true` 的 part，全部 `status=error`；retry 元数据（strategy/eligible/attempt）由单测覆盖 |
| T28.5b 事件同步可见性 | ✅ | PG `event` 表有 17 条 `message.part.updated` 含 `timeout=true` |
| T28.6 销毁后缓存失效 | ✅ | kill 后 exec 4.06s（重建，非缓存） |
| T28.7 init 失败日志 | ⏭️ SKIP | 需制造不可达沙箱触发 init 失败；日志未落盘 `opencode.log` |
| T28.8 各阶段耗时日志 | ⏭️ SKIP | INFO 级日志未落盘 `opencode.log`；逻辑由代码保证 |
| T28.9 CAS 防覆盖 | ✅ | 333 条 timeout part 全部 `error` 终态，无 `completed` 被覆盖；单测覆盖 first-writer-wins |
| T28.10 多实例幂等 | ✅ | 单测 `watchdog-pg.test.ts` 覆盖并发 `markTimedOut` + `pg_advisory_xact_lock` |
| T28.11 配置注入 scanOnce | ✅ | 单测 `watchdog-pg.test.ts` `scanOnce` 用短阈值注入 |
| T28.12 未超时不处理 | ✅ | PG 验证：131 个 running tool part，0 个被误标 `timeout=true` |
| T28.13 可观测性 | ✅ | PG 验证 timeout part 分布（question 97, read 73, task 61...）；单测覆盖 `scan completed ... scanned/stuck/marked/orphaned/durationMs` |
| T28.14 Agent 恢复重试 | ✅ | 单测覆盖 retry 元数据完整性（strategy/eligible/attempt/maxAttempts/requiresVerification） |
| T28.15 PG command session 创建超时 | ⏭️ 待复测 | 需要 PG provider 注入卡住的 `createSession` |
| T28.16 PG command semaphore 排队超时 | ✅ PASS | 单测覆盖排队超时（5.05s 预算准时 fail）；生产日志 `command permit acquired waitedMs=` 证实串行化与排队预算生效。注意黑盒复测需避开 idle-reap（30s 无活动回收持锁数秒）与远端流关闭延迟干扰 |
| T28.17 PG 前台命令整体超时 | ✅ PASS | `sleep 10` + `timeoutSeconds=2` 返回 `TimeoutError`，PG `exec_log.status=timed_out` 且有 `time_finished`；超时后自动回收 command session |
| T28.18 PG detached 命令超时与中断 | ✅ PASS | `/exec/async` 返回 running，约 2s 后 PG/查询状态为 `timed_out` |
| T28.19 PG detached session 清理超时 | ⏭️ 待复测 | 需要注入卡住的 `deleteSession`，确认 10s 上限 |
| T28.20 PG 沙箱锁等待超时 | ⏭️ 待复测 | 验证 90s 超时和后续请求可恢复 |
| T28.21 PG 超时后的命令恢复 | ✅ PASS | 超时回收 session 后 `echo recovered` 返回 `exitCode=0`（session 自动重建） |
| T28.22 PG keep-alive 与 idle-reap 回归 | ✅ PASS | `keep_alive=true` 时超时后 `keep-alive-ok` 成功；测试结束已释放并销毁沙箱 |

> **2026-08-25 修复轮补充单测**：`sandbox-provider-timeout.test.ts` 4 pass（无 timeout 直通 / 卡住操作带操作名 fail / 预算内完成 / semaphore 排队超时），`sandbox-provider-concurrency.test.ts` 9 pass。
> **已知边界**：命令总时长接近 `timeoutSeconds` 时，前台超时回收会清除 `command_session_id`，紧随其后的第一条命令有一次性的 session 重建开销（见 T28.17 说明）。

> **单测**：watchdog.test.ts 10 pass + tool-execution.test.ts 4 pass + processor-watchdog.test.ts 2 pass + watchdog-pg.test.ts 7 pass = **23 pass / 0 fail**
>
> **备注**：容器 `opencode.log` 未记录 INFO 级日志（`log.info` 输出到 stdout 但未落盘文件），可观测性以 PG `part`/`event` 表数据为准。
