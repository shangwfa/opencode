# 会话锁超时 + PG 语句超时修复验证

> 验证两项防挂死修复：`waitForSessionLock` 超时返回 503 + PG `statement_timeout` 兜底。
>
> **背景**（2026-08-21 线上事故 `ses_fdde248abffeCC7VIONSebVhdg`）：容器 → 远端 PG 瞬时网络抖动 → `edit` 工具写回状态报 `write CONNECT_TIMEOUT 172.18.32.14:5432`（挂 ~10s）→ Runner 下一轮 PG 写入挂死 → run 永不结束 → `withSessionLock` 计数永不归零 → 后续 `prompt`/`prompt_async`/`command` 全部卡在 `waitForSessionLock` 的无限 50ms 轮询（`session-lock.ts`，无超时无日志）→ 请求无限 padding、user 消息无法落库。pod 重启能临时恢复，但根因未除。
>
> 修复内容：
> 1. `packages/opencode/src/server/routes/instance/httpapi/handlers/session-lock.ts` — `waitForSessionLock` 改为 deadline 循环，超过 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC`（默认 60s）失败为 `HttpApiError.ServiceUnavailable`（HTTP 503）并 logError；`prompt`/`prompt_async`/`command` 三个 endpoint 的 error 声明已加 `ServiceUnavailable`。
> 2. `packages/opencode/src/storage/db.pg.ts` — postgres.js `connection` startup params 加 `statement_timeout` + `lock_timeout`（值取 `OPENCODE_PG_STATEMENT_TIMEOUT_MS`，默认 30000ms），池内所有连接生效；任何单语句挂超即被 PG 服务端 cancel → run 快速失败 → 锁快速释放。
> 3. `packages/opencode/src/flag/flag.ts` — 新增 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC`、`OPENCODE_PG_STATEMENT_TIMEOUT_MS` 两个开关。
>
> 防护闭环：网络抖动 → PG 语句超时兜底 run 失败释放锁；即便 run 因他因挂死 → 等待方 60s 收到 503，不再无限 padding。

## 公共环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。

### 单测（改动自带，`packages/opencode` 目录下运行）

```bash
bun test test/server/session-lock.test.ts test/storage/db-pg-config.test.ts test/flag/flag-timeouts.test.ts
```

覆盖：
- `session-lock.test.ts`（13 例）— 锁正常获取/释放/嵌套/独立；新增：锁被挂死 run 持有超时 → `ServiceUnavailable`（503）、锁释放后超时内正常通过
- `db-pg-config.test.ts`（3 例，纯单测不连 PG）— `statement_timeout`/`lock_timeout` 注入 postgres.js `connection` startup params；既有 pool 参数（max/connect_timeout/idle_timeout/max_lifetime）未被破坏
- `flag-timeouts.test.ts`（2 例）— 新 flag 默认值（60 / 30000），env 已设置时跳过默认值断言

以下为 HTTP 层集成用例（需重建 SaaS 镜像后执行）。

---

## SP-1: 会话锁超时（503 不再无限 padding）

### T41.1.1 幽灵 run 持锁时 prompt 在超时后返回 503

**场景**：复现事故形态——第一条消息的 run 挂死持有锁，随后发第二条消息。修复前第二条无限 padding；修复后应在 `OPENCODE_SESSION_LOCK_TIMEOUT_SEC`（默认 60s，可设短值加快观测）后返回 503。

```bash
# 1. server 以短锁超时启动（容器场景：docker run -e 传入；宿主机直跑见 llm-stall-recovery.md T40.1.1）
env OPENCODE_SESSION_LOCK_TIMEOUT_SEC=10 \
  OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:15432/opencode' \
  bun run --conditions=browser ./src/index.ts serve --hostname 127.0.0.1 --port 14097 --print-logs --pure &

# 2. 制造幽灵 run：第一条消息挂住（stall provider，见 llm-stall-recovery.md T40.1.1，或长挂工具）
source test-env.sh && source test-lib.sh
SID=$(new_sid)
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hang me"}],"model":{"providerID":"stall-mock","modelID":"m1"}}'
sleep 2

# 3. 第二条消息：应 ~10s 后返回 503（修复前：无限挂起 curl 28 超时）
time curl -s --max-time 60 -o /tmp/sp1-body.txt -w "HTTP %{http_code}\n" \
  -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"recovery check"}],"model":$MODEL}'
cat /tmp/sp1-body.txt
```

**期望**：
- 第二条消息 ~10s 返回 `HTTP 503`（`ServiceUnavailable`），body 含对应错误
- server 日志出现 `waitForSessionLock timed out`
- 幽灵 run 结束后（stall 断流/接管），同会话再发消息恢复正常（锁已释放）

### T41.1.2 正常串行会话不受影响（锁未占用时不超时）

**场景**：锁空闲或快速释放时，`waitForSessionLock` 应立即通过——确认加超时没引入回归。

```bash
SID=$(new_sid)
# 正常单条消息（无并发），应正常返回 assistant，无 503、无额外延迟
time curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":$MODEL}' | jexec "d['info']['role']"
```

**期望**：正常返回 `assistant`，请求耗时与修复前一致（无超时等待）；server 日志**无** `waitForSessionLock timed out`。

### T41.1.3 command / prompt_async 同样受 503 保护

**场景**：确认三个入口（prompt / prompt_async / command）都受锁超时保护，不遗漏。

```bash
# 幽灵 run 持锁期间（复用 T41.1.1 步骤 2 的状态）：
# prompt_async：应 ~10s 返回 503，而非无限 padding
time curl -s --max-time 60 -o /dev/null -w "prompt_async: HTTP %{http_code}\n" \
  -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"async check"}],"model":$MODEL}'
# command：同理
time curl -s --max-time 60 -o /dev/null -w "command: HTTP %{http_code}\n" \
  -X POST "$BASE/session/$SID/command" -H 'Content-Type: application/json' \
  -d '{"prompt":"echo check"}'
```

**期望**：两个入口均在 ~10s 返回 `HTTP 503`；日志各有 `waitForSessionLock timed out`。

---

## SP-2: PG 语句超时（run 快速失败释放锁）

### T41.2.1 statement_timeout 经 startup params 在 PG 服务端生效

**场景**：验证 `db.pg.ts` 注入的 `statement_timeout`/`lock_timeout` 确实到达 PG 服务端（而非仅客户端选项）。无需故障注入，直接 `SHOW` 验证。

```bash
# 用含修复代码的镜像起容器（或宿主机直跑 server），确认池内连接 GUC 生效：
#   容器内连 PG：docker exec <container> env | grep OPENCODE_DATABASE_URL 后 psql 查
# 最简单方式：在 server 进程内执行任意查询后，用同 URL 起一个 psql 验证是服务端默认，
# 再对比修复镜像下 server 发起的连接——但连接是 server 私有，改用 SHOW 经 server 暴露的 SQL？
# 规范做法见下（通过 server 的 exec 或直接用 db.pg init 的脚本验证）：
export OPENCODE_PG_STATEMENT_TIMEOUT_MS=1000
cat > /tmp/verify_pg_timeout.ts <<'EOF'
import { init } from "/abs/path/packages/opencode/src/storage/db.pg"
const { client } = init(process.env.PG_URL!)
const [r1, r2] = await Promise.all([client`SHOW statement_timeout`, client`SHOW lock_timeout`])
console.log("statement_timeout:", r1[0].statement_timeout)
console.log("lock_timeout:", r2[0].lock_timeout)
await client.end()
EOF
bun /tmp/verify_pg_timeout.ts
```

**期望**：输出 `statement_timeout: 1s`、`lock_timeout: 1s`——GUC 已随连接 startup 参数到达服务端（对照组：普通 psql 连接 `SHOW statement_timeout` 为 `0`）。

### T41.2.2 超限语句被服务端 cancel（run 不再无限挂）

**场景**：用超长语句（`pg_sleep`）验证超限即被 cancel，证明 run 内任意挂死 PG 写会在阈值内快速失败。

```bash
# 续 T41.2.1 脚本，在 init 的连接上执行 pg_sleep(5)（阈值为 1000ms）：
# （在 verify_pg_timeout.ts 中追加）
const start = Date.now()
try { await client`SELECT pg_sleep(5)`; console.log("UNEXPECTED: succeeded") }
catch (e) { console.log("cancelled after", Date.now() - start, "ms:", (e as Error).message.split("\n")[0]) }
```

**期望**：`cancelled after ~1000 ms: canceling statement due to statement timeout`——语句在阈值内被 PG 服务端强制取消，promise 拒绝，run 得以失败退出并释放锁（事故中 `edit` 写回挂 10s 后 run 挂死占锁的形态被根除）。

### T41.2.3 默认阈值下正常业务不受影响

**场景**：默认 `OPENCODE_PG_STATEMENT_TIMEOUT_MS=30000` 下，业务查询（毫秒级）与正常 LLM 长 run 不受影响——确认阈值足够宽裕。

```bash
# 默认配置跑一条正常消息（含多次工具调用，涉及大量 PG 写）
SID=$(new_sid)
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"列举当前目录文件"}],"model":$MODEL}' | jexec "d['info']['role']"
# 检查无 statement timeout 相关错误 part
psql "$PG_URL" -t -A -c "
SELECT count(*) FROM part p
WHERE p.session_id='$SID' AND p.data->'state'->>'error' ILIKE '%statement timeout%';"
```

**期望**：消息正常回复；错误计数为 `0`。

---

## SP-3: 回归——事故场景复现 + 恢复

### T41.3.1 事故形态复现与修复后行为对照

**场景**：复现 2026-08-21 事故链路（PG 连接抖动 → run 挂死 → 请求无限 padding），对照修复前后行为。

```bash
# 1. 旧镜像（无修复）：edit 写 PG 挂死（可用 iptables/网络限速制造容器→PG 延迟，或用
#    pg_sleep 伪装的超长工具调用），后续消息 curl --max-time 120 超时 → 事故形态
# 2. 新镜像（含修复）+ 短阈值：同场景后续消息 ~60s 返回 503（锁超时），
#    或 run 内 PG 语句超限快速失败后锁释放、消息正常回复
# 3. 触发语句超时后查 PG event 流确认 run 失败收尾（有失败/结束事件而非戛然而止）：
SID="ses_xxx"
psql "$PG_URL" -P pager=off -c "
SELECT seq, type, substring(data::text,1,80) FROM event
WHERE aggregate_id='$SID' ORDER BY seq DESC LIMIT 5;"
```

**期望**：
- 修复后无「事件流戛然而止 + 请求无限 padding」组合（事故形态）
- 超时/失败均有明确错误返回（503 / 语句超时报错），且 event 流有 run 失败收尾记录
- 同会话可继续交互，无需重启实例

---

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-21 | 单测（session-lock 13 + db-pg-config 3 + flag-timeouts 2） | ✅ 18 pass / 0 fail | `bun test test/server/session-lock.test.ts test/storage/db-pg-config.test.ts test/flag/flag-timeouts.test.ts` |
| 2026-08-21 | typecheck | ✅ | 基线 39 个既有错误，无新增；新增测试文件无类型错误 |
| 2026-08-21 | T41.2.1+T41.2.2 GUC 生效 + 语句超限 cancel（真实 PG 172.18.32.14） | ✅ | `OPENCODE_PG_STATEMENT_TIMEOUT_MS=1000` 下 `SHOW statement_timeout`=`1s`、`lock_timeout`=`1s`；`pg_sleep(5)` 1027ms 被 cancel（`canceling statement due to statement timeout`）。对照组普通连接 `SHOW` 为 `0` |
| 2026-08-21 | httpapi 相关测试回归 | ✅ | `httpapi-session` / `httpapi-promptasync-context` / `session-actions` 失败名单与改动前基线一致（19 个既有环境性失败，无新增） |
| 2026-08-21 | T41.1.x 锁超时 503（容器） | ⬜ 待跑 | 需重建镜像后执行（`OPENCODE_SESSION_LOCK_TIMEOUT_SEC=10` 观测） |
| 2026-08-21 | T41.2.3 默认阈值业务回归（容器） | ⬜ 待跑 | 需重建镜像后执行 |
| 2026-08-21 | T41.3.1 事故复现对照（容器） | ⬜ 待跑 | 需重建镜像后执行 |

## 分层防线（与 llm-stall-recovery.md 的分层发现对应）

「发消息不回」现在有三层防线，按触发先后：

```
HTTP handler: waitForSessionLock（本次修复：加超时，超时 503 + 日志）  ← 第一层，先卡这里
    └── SessionPrompt.prompt → Runner.ensureRunning（stall 断流 + 陈旧 run 接管）  ← 第二层
PG: statement_timeout 兜底（本次修复：run 内任意 PG 语句超限即失败释放锁）  ← 第三层，根除挂死源头
```

- **第一层（本次修复）**：等待方不再无限轮询，幽灵持锁 60s 后收到 503，请求可结束、错误可见。
- **第二层（2026-08-17 修复）**：stall 流 300s 断流、陈旧 run 1800s 接管，兜住 LLM/工具层挂死。
- **第三层（本次修复）**：PG 连接抖动导致的 run 内写挂死由 `statement_timeout` 兜底——run 快速失败而非无限挂，锁自然释放。这是本次事故的根因层。
