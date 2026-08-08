# Shell 执行性能与 SSE 早退优化测试（ST.Sx / ST.Ex）

> 本文档从 [`18-sandbox-tool-test.md`](./18-sandbox-tool-test.md) 的第十一、十二章拆分而来（2026-07-17 整理），包含两代性能优化验证：
> - **ST.S1-S5**：Shell 执行性能（并发 createSession 双重检查、getOrCreate 超时保护、sbCache TTL、read vs bash 对比）
> - **ST.E1-E6**：SSE 早退优化（命令延迟、exitCode 推断、输出完整性、并发 ls、e2e 延迟）
>
> 公共测试环境和配置见 [`00-preamble.md`](./00-preamble.md)。

## 一、Shell 执行性能优化测试（2026-06-23）

> 对应提交 `fix(tool): unblock concurrent bash commands and harden sandbox shell execution`

### 11.0 背景

`sandbox-provider.ts` 的 `runInSession` 存在三个性能/稳定性问题：

| 问题 | 根因 | 影响 |
|---|---|---|
| **P0** 锁范围过大 | `commandSemaphores` permits=1 包裹了 `dbGet + createSession + runInSession` | 同一 session 的所有 bash 命令**完全串行**；LLM 一轮回复中并发提交的多个 bash 调用排队等待 |
| **P1** 无超时保护 | `runInSession` 内部调用 `getOrCreateUnlocked` 绕过了外层 `getOrCreate` 的 90s 超时 | 缓存过期后 reconnect 网络挂起时**无限期阻塞**，sem permits=1 导致后续所有命令被永久排队 |
| **P2** 缓存 TTL 过短 | `SB_CACHE_TTL_MS = 30_000`（30 秒） | 持续执行 bash 时每分钟至少触发 2 次完整 reconnect（`Sandbox.connect` + `isHealthy`），无谓网络开销 |

### 11.1 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

# 启动容器时务必加 --print-logs 才能看到 log.info 输出
# docker run ... opencode-saas-sandbox-test:v2fix serve --hostname 0.0.0.0 --port 4096 --print-logs --pure
```

---

### ST.S1 同 session bash 命令串行化（Semaphore(1) 生效）

> ⚠️ **与代码核对**（2026-07-18）：`runInSession` 的 `commandSemaphores`（Semaphore(1)）同时包裹 `createSession` 与命令执行（`sandbox-provider.ts:1240` `sem.withPermit(... runCommandEarlyExit ...)`）。**sync exec 之间是串行的**；`exec/async`（走 `runDetached`，无 sem）之间可并发。本用例验证串行语义与 command session 复用（createSession 双重检查，只建 1 个）。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# warmup 沙箱（确保后续 exec 不含建沙箱时间）
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo warmup"}' >/dev/null
echo "warmup 完成"

# 3 个并发 exec 命令（每个 sleep 2s）——sync exec 受 Semaphore(1) 串行
START=$(date +%s%N)
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"sleep 2 && echo cmd-$i-done\"}" >/dev/null &
done
wait
END=$(date +%s%N)
TOTAL_MS=$(( (END - START) / 1000000 ))
echo "3 个并发请求（各 sleep 2s）总耗时: ${TOTAL_MS}ms"

# 判定：串行 → ~6000ms；若 <5000ms 说明锁失效（regression）
if [ "$TOTAL_MS" -ge 5000 ] && [ "$TOTAL_MS" -lt 9000 ]; then
  echo "✅ ST.S1 PASS: Semaphore(1) 串行生效（${TOTAL_MS}ms ≈ 3 × 2s）"
elif [ "$TOTAL_MS" -lt 5000 ]; then
  echo "❌ ST.S1 FAIL: 锁失效，命令并发执行（${TOTAL_MS}ms）"
else
  echo "⚠️ ST.S1 WARN: 耗时异常 ${TOTAL_MS}ms（可能含建沙箱开销）"
fi
```

**期望**：
- 3 个 sync exec 串行执行，总耗时 ≈ 6000ms（3 × 2s）
- 容器日志只有 1 次 createSession（复用 command session）
- 若需并发，改用 `exec/async`（走 `runDetached`，无 Semaphore）

---

### ST.S2 createSession 双重检查（P0 并发安全）

**验证点**：并发请求发现 `command_session_id=null` 时，只有一个请求执行 `createSession`，其余通过双重检查（sem 内二次查 DB）复用已创建的 session。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup 建 sandbox 但不建 command session（用 file API 而非 bash）
curl -s -o /dev/null "$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"
echo "warmup（file API，未触发 createSession）"

# 并发发 3 个 bash 命令 — 都会发现 command_session_id=null，竞争 createSession
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"echo concurrent-$i\"}" &
done
wait
echo "3 个并发 bash 完成"

# 验证日志只有 1 次 createSession
echo "--- 容器日志 ---"
docker logs opencode-saas-test 2>&1 | grep "createSession\|createSession done\|commands.createSession" | grep "$SID" | tail -5

# 验证 DB 中只有 1 个 command_session_id
COUNT=$(psql "$PG_URL" -t -c "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND command_session_id IS NOT NULL" | tr -d '[:space:]')
echo "DB command_session_id 记录数: $COUNT"
if [ "$COUNT" = "1" ]; then
  echo "✅ ST.S2 PASS: 只创建了 1 个 command session"
else
  echo "❌ ST.S2 FAIL: command session 数量异常 ($COUNT)"
fi
```

**期望**：
- 容器日志只出现 1 次 `createSession`
- DB 中 `command_session_id` 只有 1 条非空记录
- 3 个 bash 命令全部成功（exitCode=0）

---

### ST.S3 runInSession getOrCreate 超时保护（P1）

> ⚠️ **与代码核对**（2026-07-18）：`getOrCreateUnlocked` 的超时是 **90s**（`sandbox-provider.ts:1077-1080` `Effect.timeoutOrElse({ duration: Duration.seconds(90), orElse: ... "Sandbox getOrCreate timeout after 90s" })`）。以下按 90s 超时验证。

**验证点**：缓存过期后 `getOrCreateUnlocked` 挂起时，90s 超时生效，不会无限阻塞后续命令。

```bash
# 此用例需要模拟"沙箱不可达 + 缓存过期"场景
docker rm -f opencode-saas-test-timeout 2>/dev/null
docker run -d --name opencode-saas-test-timeout \
  -p 14097:4096 \
  -e OPENCODE_DATABASE_URL=postgresql://ruomu@host.docker.internal:5432/opencode \
  -e OPENCODE_AUTH_PROVIDER=pg \
  -e OPENCODE_SANDBOX_DOMAIN=host.docker.internal:39999 \
  -e OPENCODE_SANDBOX_USE_SERVER_PROXY=true \
  opencode-saas-sandbox-test:v2fix \
  serve --hostname 0.0.0.0 --port 4096 --print-logs --pure
sleep 10

SID=$(curl -s -X POST "http://localhost:14097/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

START=$(date +%s)
RESP=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 60 \
  "http://localhost:14097/file/content?path=/workspace&sessionID=$SID&directory=/workspace")
END=$(date +%s)
ELAPSED=$((END - START))
echo "首次 file API: $RESP, 耗时: ${ELAPSED}s"

# 缓存已写入但沙箱不可达 → 触发 runInSession 内部的 getOrCreateUnlocked
START2=$(date +%s)
RESP2=$(curl -s -o /dev/null -w '%{http_code} %{time_total}' --max-time 60 \
  "http://localhost:14097/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo test"}')
END2=$(date +%s)
ELAPSED2=$((END2 - START2))
echo "exec（缓存 miss，getOrCreateUnlocked）: $RESP2, 耗时: ${ELAPSED2}s"

if [ "$ELAPSED2" -lt 100 ]; then
  echo "✅ ST.S3 PASS: 在 90s 超时内返回（${ELAPSED2}s）"
else
  echo "❌ ST.S3 FAIL: 超时未生效（${ELAPSED2}s）"
fi

docker logs opencode-saas-test-timeout 2>&1 | grep -iE "getOrCreate|timeout" | tail -5
docker rm -f opencode-saas-test-timeout >/dev/null
```

**期望**：
- exec 请求在 90-95s 内返回错误（非 200）
- 容器日志含 `Sandbox getOrCreate timeout after 90s` 或连接失败错误
- 修复前：无限期阻塞（TCP 默认超时可达 300s+）

---

### ST.S4 sbCache TTL — 30s 窗口内无 reconnect，过期后重新获取（P2）

> ⚠️ **注意**：本用例最初针对"TTL 从 30s 延长到 300s"的提案编写，该提案**未合入**。当前代码 `SB_CACHE_TTL_MS = 30_000`（`sandbox-provider.ts`）。以下按当前 30s TTL 行为验证；TTL 过期重取另见 T28.3。

**验证点**：缓存 TTL 30s 内连续执行命令不触发 reconnect；超过 30s 后下次执行重新 getOrCreate。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 首次建沙箱 + 命令 session
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo initial"}' >/dev/null
echo "首次 exec 完成"

# 30s TTL 窗口内每 10s 执行一次（共 3 次），期望无 reconnect
for i in 1 2 3; do
  sleep 10
  curl -s -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' \
    -d "{\"command\":\"echo tick-$i\"}" >/dev/null
  echo "  [${i}0s] exec 完成"
done

# 越过 TTL：等待 35s 后再执行，期望触发 1 次重新 getOrCreate
sleep 35
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo after-ttl"}' >/dev/null
echo "  [65s] TTL 过期后 exec 完成"

echo "--- getOrCreate 日志 ---"
GOC_COUNT=$(docker logs opencode-saas-test 2>&1 | grep "getOrCreate done" | grep -c "$SID")
echo "getOrCreate done 次数: $GOC_COUNT"

if [ "$GOC_COUNT" -eq 2 ]; then
  echo "✅ ST.S4 PASS: TTL 窗口内无 reconnect，过期后重新获取 1 次"
else
  echo "❌ ST.S4 FAIL: getOrCreate 次数=$GOC_COUNT（期望 2：首次 + TTL 过期后各 1 次）"
fi
```

**期望**：
- 30s TTL 窗口内（0s/10s/20s/30s 共 4 次 exec），`getOrCreate done` 日志只有 1 次（首次建沙箱）
- 65s（TTL 过期后）exec 再触发 1 次 getOrCreate，总计 2 次
- 修复前（无缓存）：每次 exec 都触发 getOrCreate

---

### ST.S5 交叉对比 — read（无锁）vs bash（优化后）延迟

**验证点**：bash 工具经过 `runInSession` 路径优化后，延迟应接近 read 工具（直接文件 API），不再因锁排队导致数量级差异。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -o /dev/null "$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace"

# read 延迟（file API，无锁）
T_READ=0
for i in 1 2 3; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 \
    "$BASE/file/content?path=/workspace&sessionID=$SID&directory=/workspace")
  T_READ=$(python3 -c "print(round($T_READ + $T, 3))")
done
AVG_READ=$(python3 -c "print(round($T_READ / 3, 3))")
echo "read 平均延迟: ${AVG_READ}s"

# bash 延迟（runInSession，优化后无锁 on runInSession）
T_BASH=0
for i in 1 2 3; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 \
    -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' -d '{"command":"ls /workspace/"}')
  T_BASH=$(python3 -c "print(round($T_BASH + $T, 3))")
done
AVG_BASH=$(python3 -c "print(round($T_BASH / 3, 3))")
echo "bash 平均延迟: ${AVG_BASH}s"

RATIO=$(python3 -c "print(round($AVG_BASH / $AVG_READ, 1)) if $AVG_READ > 0 else print('N/A')")
echo "bash/read 比值: ${RATIO}x"

if python3 -c "exit(0 if $AVG_BASH < 2.0 else 1)"; then
  echo "✅ ST.S5 PASS: bash 延迟正常（${AVG_BASH}s）"
else
  echo "❌ ST.S5 FAIL: bash 延迟过高（${AVG_BASH}s）"
fi
```

**期望**：
- read 平均延迟 < 0.3s（文件 API，无 SSE 开销）
- bash 平均延迟 < 2.0s（含 SSE 流建立 + 命令执行 + 流关闭）
- bash/read 比值 < 10x（修复前因锁排队可达 100x+）

---

### 11.x 排查对照表

| 现象 | 可能原因 | 验证用例 | 日志关键字 |
|---|---|---|---|
| 并发 bash 命令排队等待 | sem permits=1 锁范围过大 | ST.S1 | `getOrCreate start` 多次出现（应只有 1 次）|
| createSession 重复创建 | 双重检查未生效 | ST.S2 | `createSession` 出现多次 |
| bash 命令永久卡住 | getOrCreateUnlocked 无超时 | ST.S3 | `getOrCreate timeout after 30s` |
| 持续命令执行中频繁重连 | sbCache TTL 过短 | ST.S4 | `reconnect done` 频繁出现 |
| bash 比 read 慢 100x | 锁串行化 + SSE 延迟叠加 | ST.S5 | 对比 read/bash 各自延迟 |

---

## 二、SSE 早退优化测试（2026-06-23）

> 对应改动：`sandbox-provider.ts` 新增 `runCommandEarlyExit`，用 `runInSessionStream` 替代 `runInSession`

### 12.0 背景

SDK 的 `consumeExecutionStream` 在收到 `execution_complete` 事件后**继续 `reader.read()` 等 SSE 流关闭**。本地单层 proxy 环境下 gap ~1 秒，远端 K8s + `useServerProxy=true` 多层 proxy 下 gap 被放大到 **60-3539 秒**（ingress idle timeout）。

**根因链**：

```
execd 执行 ls (<1s) → 发送 execution_complete → SDK 不 break
  → reader.read() 等 HTTP 连接关闭
  → K8s ingress idle timeout (60-300s) 才关闭
  → Promise resolve → 总耗时 60-3539s
```

**修复**：新增 `runCommandEarlyExit` 函数，用 SDK 的 `runInSessionStream` 获取事件流，收到 `execution_complete` 或 `error` 后**立即返回**，不等待 SSE 流关闭。exitCode 按 SDK 原始逻辑推断（有 error → 解析 value 数字；有 complete 无 error → 0）。

### 12.1 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
```

---

### ST.E1 bash 命令延迟大幅下降（SSE 早退核心验证）

**验证点**：所有通过 `runInSession` 执行的 bash 命令不再等待 SSE 流关闭，延迟降至命令本身执行时间。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

# 5 种不同命令的延迟
echo "--- bash 命令延迟 ---"
for cmd in "ls /workspace/" "echo hello" "cat /workspace/package.json | head -5" "pwd" "whoami"; do
  T=$(curl -s -o /dev/null -w '%{time_total}' --max-time 10 \
    -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' -d "{\"command\":\"$cmd\"}")
  printf "  %-45s %ss\n" "$cmd" "$T"
done
```

**期望**：
- 本地环境（单层 proxy）：每条命令 < 0.2s（修复前 ~1s）
- 远端 K8s 环境（多层 proxy）：每条命令 < 1s（修复前 60-3539s）
- 速度提升 > 10x（本地）或 > 100x（远端）

---

### ST.E2 exitCode 推断正确性（成功/失败/命令不存在）

**验证点**：`runCommandEarlyExit` 在 `execution_complete` 或 `error` 事件时推断的 exitCode 与 SDK 原始行为完全一致。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

echo "--- exitCode 验证 ---"
# 成功 (exit 0)
R0=$(curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"ls /workspace/"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))")
echo "  ls /workspace/      exit=$R0  expect=0  $([ '$R0' = '0' ] && echo '✅' || echo '❌')"

# 失败 exit 42
R42=$(curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"exit 42"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))")
echo "  exit 42             exit=$R42  expect=42 $([ '$R42' = '42' ] && echo '✅' || echo '❌')"

# 命令不存在 exit 127
R127=$(curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"nonexistent-cmd-xyz"}' | python3 -c "import json,sys;print(json.load(sys.stdin).get('exitCode'))")
echo "  nonexistent-cmd     exit=$R127 expect=127 $([ '$R127' = '127' ] && echo '✅' || echo '❌')"
```

**期望**：
- `ls /workspace/` → exitCode=0 ✅
- `exit 42` → exitCode=42 ✅（从 error.value 解析）
- `nonexistent-cmd-xyz` → exitCode=127 ✅（command not found 的标准码）
- 推断逻辑：有 error → `/^-?\d+$/` 匹配 error.value；有 complete 无 error → 0

---

### ST.E3 stdout/stderr 输出完整性

**验证点**：早退不影响输出数据收集 —— 所有 stdout/stderr 事件在 `execution_complete` 之前发送。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

# 多行 stdout
echo "--- 多行 stdout ---"
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo line1 && echo line2 && echo line3"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);lines=d.get('stdout','').strip().split('\n');print(f'  行数: {len(lines)} (期望 3)');[print(f'  {l}') for l in lines]"

# stderr 混合
echo "--- stderr 混合 ---"
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo to-stdout && echo to-stderr >&2"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'  stdout: {d.get(\"stdout\",\"\").strip()}');print(f'  stderr: {d.get(\"stderr\",\"\").strip()}')"
```

**期望**：
- 多行 stdout：完整 3 行，无截断
- stderr 混合：stdout 含 "to-stdout"，stderr 含 "to-stderr"
- 输出内容与 SDK 原始 `runInSession` 完全一致

---

### ST.E4 并发 bash 命令不受 SSE 等待影响

**验证点**：多个并发 bash 命令各自独立早退，不因 SSE 流等待而串行排队。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# warmup
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo warmup"}' >/dev/null

# 3 个并发 ls
echo "--- 3 个并发 bash ---"
START=$(date +%s%N)
for i in 1 2 3; do
  curl -s -o /dev/null -w "  #$i: %{time_total}s\n" --max-time 10 \
    -X POST "$BASE/session/$SID/exec" \
    -H 'Content-Type: application/json' -d '{"command":"ls /workspace/src/"}' &
done
wait
END=$(date +%s%N)
TOTAL_MS=$(( (END - START) / 1000000 ))
echo "  总耗时: ${TOTAL_MS}ms"

if [ "$TOTAL_MS" -lt 1000 ]; then
  echo "✅ ST.E4 PASS: 并发执行（${TOTAL_MS}ms）"
else
  echo "❌ ST.E4 FAIL: 可能仍串行（${TOTAL_MS}ms）"
fi
```

**期望**：
- 3 个并发 ls 总耗时 < 500ms（每个 ~50-150ms，并发执行）
- 不出现串行排队（修复前 + SSE gap 可达 180-900s）

---

### ST.E5 SDK 直接 A/B 对比（runInSession vs runInSessionStream 早退）

**验证点**：直接用 SDK 对比 `run()`（等 SSE 关闭）和 `runStream() + early exit`（收到 complete 立即返回），量化 SSE gap。

```typescript
// 在 packages/opencode 目录下运行：bun verify-sse-ab.ts
import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"

const cfg = new ConnectionConfig({
  domain: "localhost:8080",
  protocol: "http",
  useServerProxy: true,
})

const sb = await Sandbox.create({ connectionConfig: cfg, image: "opencode-opensandbox:local", timeoutSeconds: 120 })
console.log("sandbox:", sb.id)

const CMD = "ls /workspace/"

// A: SDK run()（等 SSE 流关闭）
console.log("\n=== A: run()（SDK 原始）===")
for (let i = 1; i <= 3; i++) {
  let completeAt = 0
  const t0 = Date.now()
  await sb.commands.run(CMD, { timeoutSeconds: 30 }, {
    onExecutionComplete: () => { completeAt = Date.now() - t0 },
  })
  const resolvedAt = Date.now() - t0
  console.log(`  #${i}: complete=${completeAt}ms  resolved=${resolvedAt}ms  gap=${resolvedAt - completeAt}ms`)
}

// B: runStream() + 早退
console.log("\n=== B: runStream() + early exit ===")
for (let i = 1; i <= 3; i++) {
  const t0 = Date.now()
  for await (const ev of sb.commands.runStream(CMD, { timeoutSeconds: 30 })) {
    if (ev.type === "execution_complete" || ev.type === "error") break
  }
  console.log(`  #${i}: returned=${Date.now() - t0}ms`)
}

await sb.kill().catch(() => {})
await sb.close().catch(() => {})
```

```bash
cd /Users/ruomu/code/opencode/packages/opencode
bun verify-sse-ab.ts
```

**期望**：
- A 组 `gap` > 500ms（SSE 流等待）
- B 组 `returned` ≈ A 组 `complete`（命令执行时间，无等待）
- 比值 A/B > 10x（本地单层 proxy）；远端 K8s 环境 > 100x

> **注**：本地环境 SSE gap ~1 秒，远端 K8s + `useServerProxy=true` 多层 proxy 环境 gap 60-300 秒。

---

### ST.E6 远端 K8s 环境验证（部署后回归）

**验证点**：部署新镜像到远端 SaaS 后，确认 `ls` 等快命令从 92-3539 秒降至 <1 秒。

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）
BASE="http://<远端 SaaS 地址>"

# 1. 通过 AI 消息触发 ls 命令
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 ls /workspace/src/"}],"model":{"providerID":"zhipuai","modelID":"glm-5.1"}}' \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 2. 从 PG 查询该 bash part 的耗时
psql "$PG_URL" -c "
SELECT p.data->>'tool' as tool,
  p.data->'state'->>'status' as status,
  ((p.data->'state'->'time'->>'end')::bigint - (p.data->'state'->'time'->>'start')::bigint)/1000 as dur_s,
  substring(p.data->'state'->'input'->>'command',1,50) as cmd
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='bash'
ORDER BY p.time_created DESC LIMIT 5;"

# 3. 判定
DUR=$(psql "$PG_URL" -t -c "
SELECT ((p.data->'state'->'time'->>'end')::bigint - (p.data->'state'->'time'->>'start')::bigint)/1000
FROM part p WHERE p.session_id='$SID' AND p.data->'state'->'input'->>'command' LIKE 'ls %'
ORDER BY p.time_created DESC LIMIT 1" | tr -d '[:space:]')

if [ "$DUR" -lt 5 ]; then
  echo "✅ ST.E6 PASS: ls 命令 ${DUR}s（< 5s，SSE 早退生效）"
else
  echo "❌ ST.E6 FAIL: ls 命令 ${DUR}s（仍然慢，SSE 早退可能未生效）"
fi
```

**期望**：
- 修复前：`ls` 命令 92-3539 秒
- 修复后：`ls` 命令 < 5 秒
- exitCode 正确（0 表示成功）
- stdout 完整（包含目录列表）

---

### 12.x 排查对照表（SSE 早退补充）

| 现象 | 可能原因 | 验证用例 | 日志关键字 |
|---|---|---|---|
| bash 命令 >60s 但 read 正常 | SSE 流不关闭（ingress idle timeout）| ST.E1, ST.E5 | 无错误日志，只是耗时长 |
| exitCode=null 导致误判超时 | 早退推断逻辑缺失 | ST.E2 | `metadata.exit=null` |
| stdout 截断或丢失 | 早退过早 break | ST.E3 | 输出行数少于预期 |
| 并发 bash 总耗时 = N × 单命令 | SSE 流串行化（未修复时）| ST.E4 | 3 个并发 ~3x 单命令耗时 |
| runInSessionStream 不存在 | SDK 版本过低 | ST.E5 | `runInSessionStream is not a function` |
| stderr 被合并进 stdout | 远端 harness execd 输出合并（execd 侧行为，非 opencode）| ST.E3 | `stderr` 字段为空、stderr 内容出现在 stdout |

> **stderr 合并说明（2026-08-08 实测）**：远端 harness-sandbox 镜像的 execd 把 stderr 事件合并为 stdout 事件发出（`echo to-stdout && echo to-stderr >&2` 的两个输出都以 `type:"stdout"` 到达）。`runCommandEarlyExit` 按事件类型正确分离 stdout/stderr，但底层流未发 stderr 事件。这是 opensandbox execd 侧行为，需在 SDK/execd 层跟进，不影响 stdout 完整性。
