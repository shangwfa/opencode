# 会话锁超时 + PG 语句超时（V2 现状：全部已移除）

> 验证防挂死修复：`waitForSessionLock` 超时返回 503 + PG `statement_timeout` 兜底 + 客户端查询超时（半开连接兜底）+ `idle_in_transaction_session_timeout`（废弃事务兜底）。
>
> **背景**（2026-08-21 线上事故 `ses_fdde248abffeCC7VIONSebVhdg`）：容器 → PG 网络抖动 → run 挂死 → `withSessionLock` 计数永不归零 → 后续请求全部卡在无限轮询 → 会话「发消息不回复」。

## ⚠️ 结论：五道超时防线在 V2 中已全部移除（2026-09-29 实测）

这是本文档最重要的结论，**先看这张表**：

| V1 防线 | V1 参数 | V2 实测 |
|---|---|---|
| ① HTTP 层会话锁超时（503） | `OPENCODE_SESSION_LOCK_TIMEOUT_SEC` | **0 个文件引用** |
| ② 陈旧 run 接管 | `OPENCODE_SESSION_STALE_RUN_SEC` | **0 个文件引用** |
| ③ PG 服务端 `statement_timeout` | `OPENCODE_PG_STATEMENT_TIMEOUT_MS` | **0 个文件引用**，且 `postgres()` 无 `connection` startup params |
| ④ 客户端查询超时 `withQueryTimeout` | 同上 | **0 处**，`pg.ts` 中无任何 `Effect.timeout` |
| ⑤ `idle_in_transaction_session_timeout` | `OPENCODE_PG_IDLE_TX_TIMEOUT_MS` | **0 个文件引用** |

**V1 四个单测文件也全部不存在**：`session-lock.test.ts` / `db-pg-config.test.ts` / `flag-timeouts.test.ts` / `db-core-bridge-timeout.test.ts`。

V2 中唯一的 `OPENCODE_SESSION_*` 变量是 `OPENCODE_SESSION_AUTO_KEEPALIVE`（与超时无关）。

### 官方文档核验（2026-09-29）

按 AGENTS.md 指引核对了 [V2 官方配置文档](https://opencode.ai/v2/docs/config) 与 [CLI settings](https://opencode.ai/v2/docs/cli/config)：

- **`opencode.jsonc` 的完整配置面中没有任何 PG / 数据库 / 会话锁超时项** —— 与代码检查结论一致。
- 文档中与超时相关的配置只有三处，且**均不涉及 PG 或会话锁**：`mcp.servers.*.timeout`（MCP 客户端）、`leader.timeout`（TUI 键位）、`compaction`（上下文压缩预算）。
- 本仓库是 SaaS fork，配置面可能超出上游文档；但**上游文档同样没有这些超时项**，说明它们不是 V2 的公开契约。

> 置信度：代码层证据（env 0 引用 + `postgres()` 无 `connection` params）是**决定性**的；官方文档核验是**佐证**。

### 关键代码证据

`packages/core/src/database/pg.ts:197-202` —— postgres.js 的**全部**配置：

```ts
const native = postgres(url, {
  max: 1,
  prepare: false,
  onnotice: () => {},
  types: PG_TYPES,
})
```

`connection` 选项是 postgres.js 传递 startup 参数（`statement_timeout` 等 GUC 到达 PG 服务端的**唯一途径**）的入口，这里**没有**。因此服务端三条 GUC 全为 PG 默认值 `0`（无限制）。

## V2 的替代防线

V2 不依赖超时，而依赖**持久化 execution claim + 串行 drain**：

- `session/store.ts` — `claim()` 在 turn 开始写入，`release()` 由终态事件提交时清除；claim 存活过重启 = 上一进程死在 turn 中途
- `session/execution/restart.ts` — `resumeSuspendedSessions()` 启动时扫描未释放 claim 并恢复，带恢复预算防无限循环

详见 [`llm-stall-recovery.md`](./llm-stall-recovery.md)。对应单测 `packages/core/test/session-execution.test.ts`（35 pass）。

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
```

> ⚠️ **脚本自检**：bash 会把紧跟变量名的全角标点算进变量名（`"$C，耗时"` → `unbound variable`）。本轮再次踩到，已在脚本头部加自动检查。
>
> ⚠️ **清理陷阱**：zsh 下 `for s in $SIDS` 只迭代一次，详见 [e2e.md](./e2e.md#️-清理陷阱zsh-下-for-s-in-sids-只迭代一次)。

### 单测

V1 的四个单测已不存在。V2 数据库层对应的是：

```bash
# 先准备专用测试库（不要用共享开发库 opencode-v2-up，见下方说明）
bash docs/test-cases/provision-pg-test-db.sh

cd packages/core
# ⚠️ database-pg-compat.test.ts 读的是 PG_TEST_URL，不是 OPENCODE_DATABASE_URL。
#    之前文档写错变量名，导致该文件静默 skip（表现为「5 例全部 skip」）。
PG_TEST_URL='postgresql://local@127.0.0.1:5432/opencode-v2-test' \
  bun test --timeout 60000 test/database-pg-compat.test.ts

# 恢复 / claim 类测试走全局重启扫描，必须指向专用测试库：
OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:5432/opencode-v2-test' \
  bun test --timeout 60000 test/session-execution.test.ts
```

> PG 支撑的测试**未设对应连接串环境变量会静默 skip**。
>
> **为什么恢复类测试必须用专用库**：`session-execution.test.ts` 驱动的是**全局**重启扫描（`SessionStore.listSuspended` / `SessionRestart.resumeSuspendedSessions`），作用于整库而非单个 Session。指向共享库 `opencode-v2-up` 时，扫描会捞到真实会话，既有断言（如「只列出 claimed 顶层 Session」）必然失败，还会对真实挂起会话发起恢复、写入 synthetic 消息。实测对照：共享库 31 pass / 4 fail；专用空库连续两次 **35 pass / 0 fail**。

---

## T41.1.1 长 run 期间第二条消息

⛔ **V1 的 503 断言在 V2 不适用**。V2 无会话锁，prompt 是异步接纳接口，**没有同步返回 503 的时机**。

可验证的等价性质：**第二条消息被正常接纳且不被阻塞**。

```bash
SID=$(new_session)
prompt_nowait "$SID" '用 shell 工具执行 sleep 30 && echo holding'
sleep 5
api "$BASE/api/session/active" | jq -c --arg s "$SID" '.data[$s]'    # {"type":"running"}
time curl -s -o /dev/null -w 'HTTP %{http_code}\n' -X POST "$BASE/api/session/$SID/prompt" \
  -H 'Content-Type: application/json' -d '{"text":"second while busy","metadata":{},"delivery":"queue"}'
wait_sid "$SID" 200
```

**期望**：HTTP **200** 且**瞬时返回**（不被阻塞）；两条消息最终都完成（PG `user=2`）。

### T41.1.2 正常串行会话不受影响

```bash
SID2=$(new_session)
time { prompt_nowait "$SID2" '回复 hi 即可'; wait_sid "$SID2" 120; }
last_text "$SID2"     # 含 hi
```

**期望**：正常回复，耗时在秒级（实测 1s），无额外等待。

### T41.1.3 command / prompt_async 受 503 保护

⛔ **不适用**。V2 无锁超时机制，三个入口都不会返回 503。V2 的等价入口是 `prompt`（统一异步接纳）。

## T41.2.1 / T41.2.2 PG GUC 与语句超时

**期望值与 V1 相反**：V1 期望 `SHOW statement_timeout` = `1s`；**V2 实测为 `0`**（PG 默认，无限制）。

```bash
pgval "SELECT 'statement_timeout='||current_setting('statement_timeout')||' lock_timeout='||current_setting('lock_timeout')||' idle_in_tx='||current_setting('idle_in_transaction_session_timeout')"
# 期望: statement_timeout=0 lock_timeout=0 idle_in_tx=0

# 实证：statement_timeout=0 时长语句会真跑满，不会被服务端 cancel
time pgval "SELECT pg_sleep(5)"     # 期望耗时 5s（V1 配置下会在 1s 被 cancel）
```

> **如何验证「服务端连接」的 GUC**：`max: 1` 是 postgres.js 的**连接池上限**，不是 PG 的连接上限 —— 外部客户端永远拿到自己的 backend，**无法读取服务端那条连接的 GUC**（本轮尝试「抢占」失败后才确认这点）。因此上面的 `SHOW` 只能反映**新建连接**的默认值；「服务端连接同样为 0」这一结论的依据是**代码层面 `postgres()` 未配置 `connection` startup params**，这是 startup 参数到达服务端的唯一途径。

### T41.2.3 默认阈值下业务不受影响

```bash
SID3=$(new_session)
prompt_nowait "$SID3" '用 shell 工具执行 pwd，然后列出 /workspace 下的文件'
wait_sid "$SID3" 180
# 断言工具调用数 >= 2，且无 statement timeout 相关错误
```

**期望**：工具调用正常完成（实测 2 次，3s）；错误计数为 0。

### T41.3.1 事故形态复现

⛔ **原用例无法执行**（需要故障注入手段 + 已移除的机制）。V2 下改为验证**并发压力下的服务健壮性**：

```bash
SIDS=(); for i in 1 2 3; do SIDS+=("$(new_session)"); done
for s in "${SIDS[@]}"; do prompt_nowait "$s" '回复 ok 即可' & done; wait
for s in "${SIDS[@]}"; do wait_sid "$s" 180; done
api -o /dev/null -w '%{http_code}\n' "$BASE/api/info"   # 服务仍健康
```

**期望**：3 个并发会话全部正常产出回复；服务仍健康无卡死。

## T41.4 客户端查询超时（半开连接兜底）

⛔ **整节不适用**。`withQueryTimeout` 及其单测 `db-core-bridge-timeout.test.ts` 在 V2 中均不存在；`pg.ts` 中无任何 `Effect.timeout` / `timeoutOrElse` 包装。

原 V1 发现的「半开连接盲区」（postgres.js 无 socket 读写超时，`statement_timeout` 收不到请求时无效）**在 V2 中依然是盲区**，且无客户端兜底。

---

## 2026-09-29 V2 实测记录

环境：SaaS `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG `opencode-v2-up`。**16 条断言 PASS，0 FAIL。**

| 断言 | 结果 | 实际观察 |
|---|---|---|
| 前置：三个 V1 env 确已移除 | ✅ | 各 **0 个文件引用** |
| 前置：`postgres()` 无 `connection` startup params | ✅ | 命中 0 处 |
| 前置：`pg.ts` 无客户端查询 timeout | ✅ | `Effect.timeout`/`timeoutOrElse` 命中 0 处 |
| T41.1.1 第二条消息被接纳 | ✅ | HTTP **200**，耗时 **0s**（无 503 机制、不阻塞）；最终 `user=2` |
| T41.1.2 正常消息 | ✅ | 1s 回复 `hi`，无额外等待 |
| T41.2.1 GUC 为 PG 默认 | ✅ | `statement_timeout=0 lock_timeout=0 idle_in_tx=0` |
| T41.2.2 长语句不被 cancel | ✅ | `pg_sleep(5)` **实际跑满 5s** |
| T41.2.3 业务回归 | ✅ | 2 次工具调用、3s 完成；statement timeout 错误数 0 |
| T41.3.1 并发健壮性 | ✅ | 3 会话并发 3s 全部收敛，3/3 有回复；服务仍健康 |

**不适用**：T41.1.1（原 503 断言）、T41.1.3、T41.3.1（原事故复现）、T41.4 整节。

## 2026-09-30 缺口已复现并修复

上文（09-29）记录的「五道防线全部移除」经实测确认属实，并已完成修复。

### 缺口复现（fake PG，半开连接）

用一个只完成 PG 握手、之后对所有查询保持静默的 fake server 模拟 socket 半开
（TCP 存活但数据不通），配合 **V2 修复前的原始 `postgres()` 配置**：

```
fake PG 确实收到了查询: true
❌ HUNG: 查询 5006ms 未返回 —— V2 配置下无客户端超时兜底
```

同时确认**部署侧也无兜底**（本地 PG 实测）：

| 层级 | 检查 | 结果 |
|---|---|---|
| role 级 GUC | `pg_roles.rolconfig` | `local` / `postgres` 均为空 |
| 全局 GUC | `pg_settings` | `statement_timeout` / `lock_timeout` / `idle_in_transaction_session_timeout` / `idle_session_timeout` **全为 0** |

### 修复内容

参照 `feat/opencode-1.18.31` 的 V1 实现（`packages/opencode/src/storage/db.pg.ts`、`db-core-bridge.ts`），在 `packages/core/src/database/pg.ts` 补回四层：

| 层 | V2 修复前 | V2 修复后 | V1 对应 |
|---|---|---|---|
| 握手 | 无 | `connect_timeout` | `connect_timeout: 10` |
| 服务端 GUC | **无** | `connection: { statement_timeout, lock_timeout, idle_in_transaction_session_timeout }` | 同 |
| 客户端兜底 | **无** | `withQueryTimeout` / `boundQuery` 包裹 `run` 与 `runValues` | `withQueryTimeout` |
| 泄漏回收 | 无 | `idle_timeout` / `max_lifetime` | 同 |

默认值与 V1 对齐：

- `OPENCODE_PG_STATEMENT_TIMEOUT_MS` = 30000（同时用于 `lock_timeout`）
- `OPENCODE_PG_IDLE_TX_TIMEOUT_MS` = 60000
- `OPENCODE_PG_CONNECT_TIMEOUT_MS` = 10000
- `OPENCODE_PG_IDLE_TIMEOUT_MS` = 30000、`OPENCODE_PG_MAX_LIFETIME_MS` = 600000
- 客户端兜底 = `statement_timeout + OPENCODE_PG_QUERY_GRACE_MS`（grace 默认 **0**，即与 V1 一致：PG 能应答的查询一律先由服务端 cancel 并给出真实原因）

> **非法 env 不静默降级为 0**。0 在 PG 里意味着「永不超时」，恰好是这个修复要消灭的形态，因此非正数/不可解析一律回落默认值。

### 关键设计取舍

- **客户端兜底默认等于 statement_timeout 而非更大**：正常慢查询必须由 PG 服务端 cancel（携带真实原因），客户端只兜「请求根本到不了服务端」的半开场景。
- **`idle_in_transaction_session_timeout` 是客户端超时的必要配套**：客户端超时会在事务中途放弃连接，该 GUC 负责回收这个 `idle in transaction` 连接。V2 池上限为 `max: 1`，泄漏一条就会拖垮全部查询。
- **事务路径未加客户端超时**：与 V1 一致（`wrapTransaction` 保持 uninterruptible），避免中断泄漏事务连接。

### 测试

新增 3 个测试文件，**共 16 条用例，全部通过**：

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/database-pg-config.test.ts` | 8 | startup params 注入、connect_timeout、客户端兜底语义、idle/max_lifetime 回收、env 覆盖、非法 env 回落、既有池参数未破坏 |
| `test/database-pg-timeout.test.ts` | 6 | 挂死查询被预算终止、错误信息可定位、正常查询不误杀、接近阈值不提前杀、快速失败保留原错误、预算确实来自配置 |
| `test/database-pg-real.test.ts` | 2 | 真实 PG：`pg_sleep(10)` 在 **1098ms** 被服务端 cancel（statement_timeout=1000）；正常查询 12ms |

**变异测试**（验证用例真能抓退化，非仅变绿）：

| 变异体 | 结果 |
|---|---|
| 移除 `connection` startup params | ✅ 5 fail |
| 客户端兜底设为极大值 | ✅ 4 fail |
| 移除 `connect_timeout` | ✅ 1 fail |
| 移除 `idle_timeout` / `max_lifetime` | ✅ 1 fail |
| 非法 env 静默变 0 | ✅ 1 fail |
| **查询路径不接 `boundQuery`** | ⚠️ **未捕获**（见下） |

> **已知局限**：`run` / `runValues` 是 `layer` 内部的闭包，无法在不重构的前提下注入测试，因此「查询路径确实接上了客户端预算」目前**只能靠代码审查保证**，没有自动化断言。曾尝试过扫描源码文本的断言，但那会随任何重构而失效且只验证文本不验证行为，已主动放弃。
>
> 若要闭合这个缺口，可行做法是把查询执行器作为 `layer` 的参数暴露（可注入），代价是改动 `DatabasePg.layer` 的签名。是否值得请产品/技术决策。

### 回归确认

| 范围 | 结果 |
|---|---|
| `session-shell.test.ts` | 14 pass / 0 fail |
| `database-drizzle.test.ts` | 10 pass / 0 fail |
| `database-migration.test.ts` | 18 pass / 0 fail |
| 新增 3 个文件 | 16 pass / 0 fail（合跑与单跑一致，连跑 3 次稳定） |

> **过程中发现并修复的一个真实回归**：初版把 `Effect.tryPromise({...}).pipe(boundQuery(...))` 写在了 `return` 语句里但缺少 `return` 包裹，导致 `effect.pipe is not a function`，使 `session-shell.test.ts` 14 个用例全 fail。已改为 `boundQuery(Effect.tryPromise({...}), queryTimeoutMs)` 的显式形式。这类错误只有真正跑回归才会暴露。
>
> `session-execution.test.ts` 最初的失败与本次改动**无关**：该测试用固定 session ID（`ses_recover_parent` 等）写入共享库 `opencode-v2-up`，二次运行触发 `duplicate key value violates unique constraint "session_v2_pkey"`；stash 对照显示改动前后同为 4 pass / 31 fail。
>
> **2026-09-30 已定位并修复**，根因有三层（原判断「只差一个 `onConflictDoNothing`」不成立，实测加上后仍失败）：
> 1. **用例间数据污染**：`claims()` 查整张 `session_v2`，却与当前用例创建的少数 Session 做精确比较；同一参数化用例复用固定 ID 也会撞主键。
> 2. **共享库中的真实会话**：全局重启扫描会捞到 `opencode-v2-up` 里的真实挂起会话（实测 `ses_f1044ee8dffeDKyMvP9C99ucL1`）并对其发起恢复。
> 3. 早先新增的 `session-execution-idempotent.test.ts` 重复执行的是自建 SQL，**未覆盖** `seedSessions`，已删除。
>
> 修复：测试 Session ID 加随机后缀、`claims()` 只查本用例 ID、`afterEach` 清理本用例 Session；并把 PG 测试统一指向**专用测试库** `opencode-v2-test`（`bash docs/test-cases/provision-pg-test-db.sh` 一键创建）。实测专用库连续两次 **35 pass / 0 fail**，`packages/core` 类型检查通过。

### 仍需决策

会话锁超时（第一层）与陈旧 run 接管（第二层）**本次未补回**：

- V2 无 `waitForSessionLock`，prompt 是异步接纳接口，**没有同步返回 503 的时机**
- V2 用串行 drain + 持久化 claim 替代（见 `llm-stall-recovery.md`），能处理**进程死亡**但不能处理**进程存活 + 连接半开**

本次修复覆盖了「连接半开」这一层，使 run 能够失败退出而不再永久挂起。是否还需要补会话锁超时（例如给 `wait` 加上限），属于产品决策。

---

## 历史记录（V1 时期，保留备查）

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-21 | 单测（session-lock 13 + db-pg-config 3 + flag-timeouts 2） | ✅ 18 pass / 0 fail | |
| 2026-08-21 | T41.2.1/2 GUC 生效 + 语句超限 cancel | ✅ | `pg_sleep(5)` 1027ms 被 cancel；对照组 `SHOW` 为 `0` |
| 2026-08-22 | T41.1.1 幽灵 run → prompt 503 | ✅ | **60.16s** 返回 HTTP 503 `{"_tag":"ServiceUnavailable"}` |
| 2026-08-22 | 半开连接盲区实验（fake PG） | ⚠️ 发现并补修 | 握手后静默 → 查询 12s 永久挂起 → 补第 4 项修复 |
| 2026-08-22 | T41.4.3 容器内超限语句 | ✅ | `pg_sleep(60)` 3s 被 cancel |
| 2026-09-14 | 全量复测 | ✅ | 单测 20/20 + 集成 11 例全过 |
| 2026-09-14 | T41.1.1 三入口 503 | ✅ | **60.160s / 60.190s / 60.195s** 精确 503 |
| 2026-09-14 | 第五道防线 `idle_in_transaction_session_timeout` | ✅ | 连接 B **3088ms** 获得被 A 阻塞的 advisory lock |
