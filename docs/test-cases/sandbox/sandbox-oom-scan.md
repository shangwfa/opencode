# 沙箱 OOM 采样与内存水位预警（SaaS / PG）

> **V2 状态（2026-10-02 已实现）**：周期 OOM 采样已在 V2 落地，行为对齐 V1 语义、落库改为 V2 durable session 事件：
>
> - 实现：`packages/core/src/sandbox/oom-sample.ts`（采样命令 / `parseOomSample` / `classifyOomSample` 纯函数 / `sampleSandbox` 一次性命令会话执行）+ `packages/core/src/sandbox/provider.ts` 采样 fiber（扫 `state=running`、按 `time_updated desc` 批量、仅采样本进程持有句柄的沙箱、基准含 sandboxID 跨世代不互吞、销毁/失效时清基准）+ `packages/schema/src/session-event.ts` 的 `session.sandbox.oom` / `session.sandbox.pressure` durable 事件。
> - env（`packages/core/src/sandbox/config.ts`）：`OPENCODE_SANDBOX_OOM_SCAN_ENABLED`（默认开，`0/false` 关）、`OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC`（60）、`OPENCODE_SANDBOX_OOM_SCAN_BATCH`（50）、`OPENCODE_SANDBOX_OOM_PRESSURE_RATIO`（0.85）。
> - 归因：`oom_kill` 差值 >0 → `session.sandbox.oom`（含 delta/total/usage/limit）；无 OOM 且 usage/limit ≥ ratio → `session.sandbox.pressure`（每沙箱 5 分钟窗口一条）；首轮只立基准；负差值（重建）静默重置；OOM 优先于 pressure。
> - 审计读取：`GET /api/experimental/session/:id/log` 回放，或查 event 表 `type='session.sandbox.oom'`；V1 的 `exec_log(source="sandbox-oom")` 不存在于 V2。
> - 采样不 touch 心跳（不影响 idle-reap），被动诊断（proxy 502 时读 cgroup，`proxy-rewrite.ts`）保留作互补。
> - 单测：`packages/core/test/sandbox-oom-sample.test.ts`（parse/classify 全语义 + 命令 cgroup v1/v2 兼容 + 一次性会话清理）。
>
> 正文其余内容为 V1 历史记录（`packages/opencode/src/tool/sandbox-provider.ts` 已移除），保留作背景；不要按 V1 命令执行。

> **仅适用于 opencode SaaS（PostgreSQL）**。
> 公共测试环境和配置请参考 `docs/local-test-env.md`。

## V2 验收用例（T61.V2）

自动化脚本：`docs/test-cases/scripts/sandbox-oom-v2.mjs`（128Mi 会话 + 后台炸弹 + event 断言；实例需 `OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC=5`，2026-10-02 实测 4/4 轮 PASS）。

公共 helper 见 `sandbox-watchdog.md` 的 V2 执行约定。低内存沙箱经会话级资源配置创建（`"sandbox":{"cpu":"1","memory":"128Mi"}`，见 [`session-sandbox-resource.md`](./session-sandbox-resource.md)）。

### T61.V2.1 正常运行不误报

`OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC` 默认 60 的实例上跑几轮正常命令，等待 ≥3 个采样周期后：

```bash
psql "$PG_URL" -At -c "select count(*) from event where aggregate_id='$SID' and type='session.sandbox.oom'"
# 期望 0；且沙箱未被采样行为保活（非 keep-alive 会话照常 idle-reap，T61.V2.5）
```

### T61.V2.2 后台进程 OOM 归因（核心：invisible OOM kill）

专用实例设 `OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC=5`；创建 128Mi 会话，warmup 后**先等待 ≥1 个采样周期让采样器立基准**（否则首轮采样可能已包含全部 kill，基准即峰值、后续 delta 恒 0——2026-10-02 实测踩坑），再启动后台内存炸弹（接口层不可见）：

```bash
run_shell "$SID" 'cat /sys/fs/cgroup/memory.events'      # 基准 oom_kill
run_shell "$SID" '(nohup sh -c "a=x; while :; do a=$a$a; done" >/tmp/bomb.log 2>&1 </dev/null &); echo started'
sleep 15                                                    # ≥2 个采样周期
run_shell "$SID" 'cat /sys/fs/cgroup/memory.events'      # oom_kill 增长
psql "$PG_URL" -At -c "select type, data from event where aggregate_id='$SID' and type like 'session.sandbox.%' order by seq"
```

期望：cgroup `oom_kill` 增长；event 表出现 `session.sandbox.oom`，`data` 含 `oomKillDelta ≥ 1`、`oomKillTotal`、`usageBytes/limitBytes`；所有 shell 命令本身仍 `exited`（接口层无异常——这正是 invisible 的含义）。

### T61.V2.3 水位预警

128Mi 会话内 `run_shell` 分配 ~120Mi（`head -c 120000000 /dev/zero | tail -c 1` 类占用），保持存活跨过一个采样周期：期望 `session.sandbox.pressure`（`pct ≥ 85`），且 5 分钟窗口内不重复。

### T61.V2.4 关闭开关

`OPENCODE_SANDBOX_OOM_SCAN_ENABLED=0` 的实例上重复 T61.V2.2：期望无任何 `session.sandbox.*` 事件。

### T61.V2.5 采样不影响 idle-reap

非 keep-alive 会话在 `OPENCODE_SANDBOX_IDLE_REAP_SEC` 缩短的实例上照常被回收（采样命令走一次性会话、不 touch 心跳）。

## 以下为 V1 历史记录

> **与其他文档的关系**：
> - 沙箱生命周期与空闲回收见 [`sandbox-lifecycle.md`](./sandbox-lifecycle.md)（T12/T30）
> - proxy 502 端口诊断（按需读 cgroup OOM 累计值）见 `src/server/sandbox-proxy.ts` 的 `diagnosePort`
> - Part Watchdog（tool 超时兜底）见 [`sandbox-watchdog.md`](./sandbox-watchdog.md)（T28）

## 背景

dev server 等后台进程被 OOM kill 时**沙箱容器仍 running**（"invisible OOM kill"），任何接口层都不可见：`setsid nohup` 脱离的进程，exec 拿不到退出码；子进程被杀不改变容器状态，K8s/proxy 全部无感。之前只能靠人工进沙箱 `cat` cgroup 文件排查。

解法（2026-09）：sandbox-provider 内新增周期采样任务——每 60s 扫描 PG 中 `state=running` 的沙箱，进沙箱读 cgroup `oom_kill` 累计计数与内存水位：

- **delta 归因**：相邻两次采样差值 >0 → 该周期内发生 OOM，落 `exec_log(source="sandbox-oom", status="failed")`
- **水位预警**：usage/limit ≥ 85% → 落 `exec_log(source="sandbox-oom", status="completed")`，5 分钟窗口一条
- **幂等**：主键 id 含 oom_kill 总数 / 时间桶（`oom-<session>-<total>`、`oom-pressure-<session>-<bucket>`），多实例共享 PG 不重不漏
- **不 touch 心跳**：走临时 command session（`runEphemeralCommand`），不延长沙箱活跃时间，不阻断 idle-reap

## 改动清单

| 文件 | 改动 |
|------|------|
| `packages/opencode/src/tool/sandbox-provider.ts` | `OOM_SAMPLE_COMMAND` / `parseOomSample` / `classifyOomSample`（纯判定）+ layer 内周期采样任务；幂等 id 含 sandboxID（跨世代不互吞）；destroySandbox 清理采样基准 |
| `packages/opencode/src/session/exec-log.pg.ts` | `ExecLogSource` 新增 `"sandbox-oom"` |
| `packages/opencode/src/flag/flag.ts` | 新增 `OPENCODE_SANDBOX_OOM_SCAN_ENABLED`（默认开；`INTERVAL_SEC` 的 number() 不接受 0，禁用走此开关） |
| `packages/opencode/src/server/sandbox-proxy.ts` | diagCommand 的 awk 多文件 busybox 兼容修复（同病同修） |
| `packages/opencode/test/server/sandbox-diag.test.ts` | `parseOomSample` + `classifyOomSample` 单测（20 用例） |

## 关键常量与采样命令

| 常量 | 默认值 | 说明 |
|------|--------|------|
| `OPENCODE_SANDBOX_OOM_SCAN_ENABLED` | true | 采样开关；设 0/false 禁用 |
| `OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC` | 60 | 采样周期（秒） |
| `OOM_SCAN_BATCH` | 50 | 每轮最多采样沙箱数（按 `time_updated` desc，活跃优先） |
| `OOM_PRESSURE_RATIO` | 0.85 | 水位预警阈值（usage/limit） |
| `OOM_PRESSURE_WINDOW_MS` | 300_000 | 水位预警去重窗口 |
| 采样命令超时 | 8s | 单沙箱 `runEphemeralCommand` 超时 |

采样命令（cgroup v2/v1 双兼容，`cat` 多路径 + `head -1` 取先存在者）：

```sh
printf 'OOM='; awk '$1=="oom_kill"{print $2}' /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null | head -1
printf 'USAGE='; cat /sys/fs/cgroup/memory/memory.current /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null | head -1
printf 'LIMIT='; cat /sys/fs/cgroup/memory/memory.max /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null | head -1
```

> ⚠️ **重建镜像**：本功能涉及 Go/Bun 服务端代码，验证前需 `docker build -t opencode-saas-sandbox-test:<tag> -f Dockerfile .` 后按 `docs/local-test-env.md` 重启容器。
> ⚠️ **首轮盲区**：服务重启/沙箱新建后首轮采样只立基准不告警，首个周期内发生的 OOM 不可归因（见 T61.7）。

## 通用变量

```bash
source docs/test-cases/test-env.sh [1|2|3]
source docs/test-cases/test-lib.sh

# 手动读当前沙箱 cgroup 计数（与采样命令一致，用于对账）
OOM_READ='printf "OOM="; awk '"'"'$1=="oom_kill"{print $2}'"'"' /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory/memory.oom_control 2>/dev/null | head -1; printf "\n"'

# 查询 sandbox-oom 记录
OOM_LOGS() { psql "$PG_URL" -t -A -c "SELECT id, status, command, error FROM exec_log WHERE session_id='$1' AND source='sandbox-oom' ORDER BY time_created"; }
```

---

## 六十一、沙箱 OOM 采样与内存水位预警

### T61.1 正常运行不误报

**验证点**：无 OOM 的健康沙箱，采样若干轮后不产生任何 `sandbox-oom` 记录（首轮立基准 + 后续 delta=0 + 水位低于 85%）。

```bash
SID=$(new_sid -kb)
echo "SID: $SID"

# 正常命令跑几轮（制造活跃度）
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo ok","timeoutSeconds":10}' >/dev/null

# 等待 ≥3 个采样周期（默认 60s/轮）
sleep 180

OOM_LOGS "$SID" | wc -l
# 期望：0

curl -s "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo alive","timeoutSeconds":10}' | jexec "d['exitCode']"
# 期望：0（沙箱未被误伤）
```

**期望**：
- `exec_log` 中 `source='sandbox-oom'` 记录数为 0
- 沙箱仍存活可执行命令

---

### T61.2 后台进程 OOM 归因（核心场景：invisible OOM kill）

**验证点**：`setsid nohup` 脱离的后台进程被 OOM kill 时，exec 接口层**完全无感知**（无 failed 记录），但采样任务能检测 cgroup `oom_kill` 计数增长并落 `exec_log(source="sandbox-oom", status="failed")`，error 含结构化 `SandboxOOM`（oomKillDelta/oomKillTotal/usageBytes/limitBytes）。

```bash
# 低内存沙箱（128Mi），OOM 秒级触发
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"100m","memory":"128Mi"}}' | jexec "d['id']")
echo "SID: $SID"

# warmup（建沙箱）
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo ready","timeoutSeconds":30}' | jexec "d['exitCode']"

# 采样前基准（应无 oom_kill 或为已知值）
curl -s -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d "{\"command\":\"$OOM_READ\",\"timeoutSeconds\":10}" | jexec "d['stdout']"

# 后台内存炸弹：shell 变量倍增，毫秒级吃满 128Mi；setsid 脱离后 exec 立即返回 0
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo launched","timeoutSeconds":15}' | jexec "d['exitCode']"
# 期望：0（接口层看不到任何异常——这正是"invisible"的含义）

sleep 10
# 确认炸弹已被 OOM kill（exec_log 无 failed 记录 = 接口层无感知）
psql "$PG_URL" -t -A -c "SELECT status, count(*) FROM exec_log WHERE session_id='$SID' AND source IN ('exec','exec-async') GROUP BY status"

# 等待 ≥2 个采样周期
sleep 120

OOM_LOGS "$SID"
```

**期望**：
- exec/exec-async 记录中**无** failed/137（接口层不可见）
- `sandbox-oom` 记录 ≥1 条，`status='failed'`
- `command` 含 `sandbox-oom-scan oom_kill_total=N delta=M`（M ≥ 1）
- `error` JSON 含 `"name":"SandboxOOM"`、`oomKillDelta=M`、`oomKillTotal=N`、`usageBytes`、`limitBytes`
- 容器日志（`--print-logs`）含 `WARN ... service=sandbox-provider ... sandbox OOM detected`

---

### T61.3 同一 OOM 幂等去重 + 再次 OOM 产生新记录

**验证点**：`oom_kill` 累计计数不变时，多个采样周期只落一条记录（主键 `oom-<session>-<total>` 去重，多实例同样生效）；计数再次增长时产生新记录。

```bash
# 接 T61.2：炸弹进程可能已被 kill，再放一个继续吃内存 → 再次 OOM
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo relaunched","timeoutSeconds":15}' >/dev/null

# 再等 ≥3 个采样周期
sleep 180

psql "$PG_URL" -t -A -c "SELECT id FROM exec_log WHERE session_id='$SID' AND source='sandbox-oom' ORDER BY time_created"
```

**期望**：
- 每个 `oom_kill_total` 值最多一条记录（id 无重复）
- 第二次 OOM 的 `oom_kill_total` 严格大于第一次
- 两个周期之间无 OOM 时不会追加记录

> **多实例验证（可选）**：两个容器实例共享同一 PG 时重复 T61.2，期望每个 total 仍只有一条记录（另一实例的主键冲突写入被吞）。

---

### T61.4 内存水位预警（MemoryPressure）

**验证点**：稳态内存占用 ≥85% limit（未触发 OOM）时，采样落 `exec_log(source="sandbox-oom", status="completed")`，error 含 `MemoryPressure`；同 5 分钟窗口内不重复。

```bash
# 256Mi 沙箱 + python 稳态占用 ~240MB（>85%×256Mi=228MB，距 OOM 有余量）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"0.5","memory":"256Mi"}}' | jexec "d['id']")
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo ready","timeoutSeconds":30}' >/dev/null

curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"setsid nohup python3 -c \"import time; b=bytearray(240*1024*1024); time.sleep(600)\" >/dev/null 2>&1 & echo ok","timeoutSeconds":15}' >/dev/null

sleep 120   # ≥2 个采样周期

OOM_LOGS "$SID"
```

**期望**：
- 出现 `status='completed'` 的 `sandbox-oom` 记录
- `command` 形如 `memory-pressure pct=9X%`（≥85%）
- `error` JSON 含 `"name":"MemoryPressure"`、`usageBytes`、`limitBytes`、`pct`
- 同 5 分钟窗口内最多 1 条（id 含时间桶 `oom-pressure-<session>-<bucket>`）
- python 进程存活期间（600s）跨窗口后会再出现一条新 bucket 记录（每窗口一条，不刷表）

> **边界**：python3 分配 240MB 若在内存紧张的宿主上意外触发 OOM，用例退化为 T61.2 场景（出现 `status='failed'`）——视为环境问题重跑，不是产品缺陷。

---

### T61.5 采样不 touch 心跳（不阻断 idle-reap）【关键回归】

**验证点**：OOM 采样走临时 command session，**不得**延长沙箱活跃时间。否则开启采样后所有 running 沙箱永远不过 idle-reap 阈值（regression）。

```bash
# 需短阈值环境变量重启容器：
#   OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC=60（采样开着）
#   OPENCODE_SANDBOX_IDLE_REAP_SEC=120 OPENCODE_SANDBOX_IDLE_KILL_SEC=60
SID=$(new_sid)
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo ready","timeoutSeconds":30}' >/dev/null

# detached 长命令（模拟 dev server；detached 不维持心跳）
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec/async" -H 'Content-Type: application/json' \
  -d '{"command":"setsid nohup sleep 600 >/dev/null 2>&1 & echo started","timeoutSeconds":15}' >/dev/null

# 之后完全不操作，等 idleReapMs + 采样若干轮
sleep 240

psql "$PG_URL" -t -A -c "SELECT id, state FROM sandbox WHERE session_id='$SID'"
```

**期望**：
- ~2-4 分钟后 `sandbox.state` 变为 `killed`（或 `destroyed`）——idle-reap 正常回收
- 若 state 长期 `running`：**FAIL**，说明采样路径 touch 了心跳
- 回归对照：关闭采样（`OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC=0`）重跑，回收时间应一致

---

### T61.6 开关禁用（OPENCODE_SANDBOX_OOM_SCAN_ENABLED=0）

**验证点**：采样开关关闭（`OPENCODE_SANDBOX_OOM_SCAN_ENABLED=0`）时任务不启动，触发 OOM 也不产生 `sandbox-oom` 记录。

```bash
# 重启容器加 OPENCODE_SANDBOX_OOM_SCAN_ENABLED=0，然后重复 T61.2 的触发步骤
# ⚠️ 共享 PG 多实例环境下，其他开启采样的实例仍会归因该 OOM——判定看本容器日志无 "oom scan task started"，而非记录数为 0
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"100m","memory":"128Mi"}}' | jexec "d['id']")
curl -s --max-time 60 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo launched","timeoutSeconds":15}' >/dev/null

sleep 180
OOM_LOGS "$SID" | wc -l
# 期望：0
```

**期望**：本容器日志无 `oom scan task started`（任务未启动）。
> 共享 PG 下其他实例的采样任务仍可能扫描到该 OOM 并落记录（多实例设计的预期行为），不能以记录数判定。

---

### T61.7 服务重启后首轮立基准（不误报历史 OOM）

**验证点**：采样基准（`lastOomKill`）是进程内存态，服务重启后清零。首轮对 `oom_kill>0` 的存量沙箱只立基准，不把历史计数误报成新 OOM。

```bash
# 前置：接 T61.2/61.3 的沙箱（oom_kill ≥ 1），保持沙箱 running
# 重启服务容器（保留 PG），等待启动 + ≥2 个采样周期
docker restart opencode-saas-test
sleep 180

BEFORE=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM exec_log WHERE session_id='$SID' AND source='sandbox-oom'")
sleep 60
AFTER=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM exec_log WHERE session_id='$SID' AND source='sandbox-oom'")
echo "before=$BEFORE after=$AFTER"
```

**期望**：
- `after == before`（重启后首轮未追加任何记录）
- 若重启后再次发生新 OOM（delta>0），新记录的 `oom_kill_total` 与重启前一致（计数器属于沙箱 cgroup，不随服务重启清零）

---

### T61.8 沙箱重建后计数器归零静默重置（delta<0）

**验证点**：`oom_kill` 计数属于沙箱 cgroup，沙箱销毁重建（或快照恢复出新沙箱）后从 0 重新计数。采样基准若还停留在旧值（prev=6，新沙箱读数 0），delta=-6 必须静默重置基准，**不得**误报，且后续新 OOM 恢复正常归因。

```bash
# 前置：接 T61.2/61.3 的沙箱（已发生 ≥1 次 OOM，采样基准 >0）
psql "$PG_URL" -t -A -c "SELECT command FROM exec_log WHERE session_id='$SID' AND source='sandbox-oom' AND command LIKE '%sandbox-oom-scan%' ORDER BY time_created DESC LIMIT 1"
# 确认最新记录 oom_kill_total=N（N>0）

# 销毁并重建沙箱（同 session 快照模式下会从快照恢复全新 cgroup）
curl -s -X POST "$BASE/session/$SID/kill-sandbox" -H 'Content-Type: application/json' -d '{}' >/dev/null
curl -s --max-time 90 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"cat /sys/fs/cgroup/memory/memory.oom_control | tail -1","timeoutSeconds":60}' | jexec "'重建后基准:', d['stdout'].strip()"
# 期望：oom_kill 0（全新 cgroup）

sleep 60   # ≥2 个采样周期（默认 60s）

# 无新 OOM 时不得产生任何新记录
B=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM exec_log WHERE session_id='$SID' AND source='sandbox-oom' AND command LIKE '%sandbox-oom-scan%'")
# 再触发一次 OOM，验证新基准下归因恢复
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo go","timeoutSeconds":15}' >/dev/null
sleep 90
OOM_LOGS "$SID"
A=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM exec_log WHERE session_id='$SID' AND source='sandbox-oom' AND command LIKE '%sandbox-oom-scan%'")
[ "$A" -gt "$B" ] && pass "T61.8 重建后静默重置且归因恢复" || fail "T61.8" "before=$B after=$A"
```

**期望**：
- 重建后静置期**无**新记录（delta<0 静默，不误报 "负 OOM"）
- 新 OOM 产生新记录，`oom_kill_total` 从小值重新开始（如 total=1），与重建前记录（total=N）并存且 id 不同
- 单测对照：`classifyOomSample` 的 "negative delta is silent" 用例

---

### T61.9 沙箱不可达静默降级与自愈

**验证点**：扫描到 `state=running` 但实际不可达的沙箱（PG 与现实漂移）时：reconnect 失败 → 输出 `WARN oom scan reconnect failed` → **清理该 session 采样基准**（防重建后旧基准误判）→ 任务不崩、同轮其他沙箱不受影响、沙箱恢复后归因能力自动恢复。

```bash
# 造数：PG 行标 running 但沙箱实际已销毁（模拟 pod crash 后的对账窗口）
BOGUS_SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jexec "d['id']")
echo "$BOGUS_SID" > /tmp/t61-sid-bogus
psql "$PG_URL" -c "UPDATE sandbox SET state='running', host='http://host.invalid:1' WHERE session_id='$BOGUS_SID'"

sleep 90   # ≥1-2 个采样周期（默认 60s）

docker logs opencode-saas-test 2>&1 | grep "oom scan reconnect failed" | grep "$BOGUS_SID" | tail -1

# 自愈：修正 host 并让真实沙箱接管（kill 掉假行重新走正常创建）
psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='$BOGUS_SID'" >/dev/null
curl -s --max-time 60 -X POST "$BASE/session/$BOGUS_SID/exec" \
  -H 'Content-Type: application/json' -d '{"command":"echo recovered","timeoutSeconds":30}' | jexec "'恢复后 exit:', d['exitCode']"
```

**期望**：
- 日志出现 `WARN ... oom scan reconnect failed sessionID=$BOGUS_SID`（每轮一条，不刷屏级别）
- 任务持续运行：同轮其他沙箱的采样不受影响（对照 T61.1 沙箱仍零误报）
- 清理假行后日志不再增长；真实沙箱创建后恢复常规采样
- 单测对照：`parseOomSample` 空输出全 null → 静默跳过（同属降级路径）

---

### T61.10 多沙箱同轮归因 + 审计 API 可读

**验证点**：同一采样轮内多个沙箱各自发生 OOM 时**逐 session 独立归因**（批量路径 `Effect.forEach` 单候选失败不串扰）；且 `GET /session/:id/execs` 审计接口能读到 `sandbox-oom` 记录（排查规范走 API 而非直连 PG）。

```bash
# 两个独立低内存沙箱，同一时间窗内先后触发 OOM
S1=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"100m","memory":"128Mi"}}' | jexec "d['id']")
S2=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' \
  -d '{"sandbox":{"cpu":"100m","memory":"128Mi"}}' | jexec "d['id']")
for S in $S1 $S2; do
  curl -s -X POST "$BASE/session/$S/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' >/dev/null
  curl -s --max-time 90 -X POST "$BASE/session/$S/exec" \
    -H 'Content-Type: application/json' -d '{"command":"echo ready","timeoutSeconds":60}' >/dev/null
  curl -s --max-time 30 -X POST "$BASE/session/$S/exec" -H 'Content-Type: application/json' \
    -d '{"command":"setsid nohup sh -c '\''X=A; while :; do X=$X$X$X$X$X$X$X$X$X$X; done'\'' >/dev/null 2>&1 & echo go","timeoutSeconds":15}' >/dev/null
done

sleep 120  # ≥2 个采样周期

# PG 视角：两个 session 各自独立记录
psql "$PG_URL" -t -A -c "SELECT session_id, command FROM exec_log WHERE session_id IN ('$S1','$S2') AND source='sandbox-oom' AND command LIKE '%sandbox-oom-scan%'"

# 审计 API 视角（排查规范路径）
curl -s "$BASE/session/$S1/execs" | jexec "n=[d] if isinstance(d,dict) else d; [r['source']+':'+r['command'][:60] for r in (n if isinstance(n,list) else n.get('execLogs',[])) if r.get('source')=='sandbox-oom']"
```

**期望**：
- S1、S2 各至少一条 `sandbox-oom-scan` 记录，`oom_kill_total` 互相独立
- 审计 API 返回中能看到 `sandbox-oom` source 的记录（字段与 PG 一致）
- 同 session 多次 OOM 的记录按 `time_created` 有序（对照 T17 排序规范）

---

## 已知限制与环境依赖

| 项 | 说明 | 覆盖方式 |
|------|------|---------|
| **回收竞速盲区** | 非 keep-alive 沙箱在最后一次操作后被 onIdle 回收（约 30-60s），若 OOM 发生在回收前最后一个采样周期之外，delta 永远不会被记录（沙箱行已 destroyed，扫描只扫 running）。**长跑 dev server 的会话必须 keep-alive**（T61.2 用例的前置）。 | 用例前置约定 + 排查对照表 |
| **cgroup v2 未集成验证** | 测试环境沙箱为 cgroup v1；v2（`memory.events`/`memory.max`）路径由单测覆盖（`parseOomSample` v2 用例 + 采样命令 `||` 链）。部署到 v2 节点后建议复测 T61.2。 | 单测 + 部署后复测 |
| **批量截断（OOM_SCAN_BATCH=50）** | running 沙箱 >50 时按 `time_updated` desc 截断，最久未用的不被采样。集成环境难造 51 个沙箱。 | 代码审查（排序方向活跃优先） |
| **首轮盲区** | 服务重启/新沙箱建立后首个采样周期只立基准，该周期内发生的 OOM 不可归因（最长 ~1 个采样间隔）。 | T61.7 |
| **水位无限制不预警** | v1 巨大 limit / v2 `"max"` 视为未设限，水位预警跳过（OOM delta 归因不受影响）。 | 单测 |
| **同轮 OOM+水位只报 OOM** | classifyOomSample OOM 优先返回。 | 单测 |

---

## 排查场景对照表

| 现象 | 可能原因 | 验证用例 | 关键字 |
|------|---------|---------|--------|
| 后台 dev server 挂了但接口全正常 | invisible OOM kill | T61.2 | `exec_log source='sandbox-oom' status='failed'` |
| 预览 502 时不知道是不是 OOM | proxy 诊断（按需累计值）+ 本采样（时间线）互补 | T61.2 + `diagnosePort` | `sandbox OOM detected` / `cgroup oom_kill=` |
| sandbox-oom 记录重复 | 主键幂等失效 | T61.3 | `oom-<session>-<total>` 无重复 |
| 采样把空闲沙箱养活不过期 | 采样误用 runInSession（touch 心跳） | T61.5 | idle-reap 正常回收 |
| 开了采样后 exec 变慢/排队 | 采样占用 command semaphore | T61.1 | 采样走独立临时 session，不应有痕迹 |
| 内存涨到快上限但还没 OOM | 水位预警 | T61.4 | `memory-pressure pct=` |
| 重启后冒出大量历史 OOM 记录 | 首轮未立基准 | T61.7 | 首轮只基准不告警 |
| 沙箱重建后冒出历史 OOM / 负数异常 | delta<0 未静默重置 | T61.8 | 新基准从重建后计数开始 |
| 日志刷 `oom scan reconnect failed` | PG 行与现实漂移（僵尸 running 行） | T61.9 | 行被对账回收后停止 |
| 某沙箱采样失败影响其他沙箱 | 批量候选错误隔离缺失 | T61.10 | `oom scan candidate failed` 不串扰 |
| API 查不到 OOM 记录 | source 未进审计接口 | T61.10 | `GET /session/:id/execs` 含 sandbox-oom |
| 短命会话 OOM 无记录 | 回收竞速（沙箱先于采样被回收） | 已知限制 | 会话需 keep-alive；限制非缺陷 |
| v2 cgroup 节点上无记录 | awk 多文件 busybox 兼容（已修） | 单测 + 部署后复测 T61.2 | `\|\|` 链逐文件探测 |

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|------|------|------|------|
| 2026-09-12 | T61.1 正常运行不误报 | ✅ | 新镜像 oom-scan4，3 周期后 records=0、沙箱存活 |
| 2026-09-12 | T61.2 后台进程 OOM 归因 | ✅ | 128Mi 沙箱 setsid 内存炸弹：接口层全 completed，exec_log 落 `SandboxOOM delta=1 total=5`，usage/limit 解析正确；执行中发现并修复 busybox awk 多文件 bug（见下） |
| 2026-09-12 | T61.3 幂等去重 + 再次 OOM | ✅ | total=5 三周期唯一；第二次 OOM 产生 total=6 新记录；双实例并发只落一条 |
| 2026-09-12 | T61.4 水位预警 | ✅ | 256Mi 沙箱 python 稳态占用：`memory-pressure pct=98%` status=completed，进程存活未 OOM |
| 2026-09-12 | T61.5 采样不阻断 idle-reap | ✅ | idleReap=120s + 采样 15s：detached 长命令后静置 ~4.5min，沙箱正常 destroyed（采样未续命） |
| 2026-09-12 | T61.6 开关禁用 | ✅ | `OPENCODE_SANDBOX_OOM_SCAN_ENABLED=0`：容器日志无 `oom scan task started`；执行中发现 number() 不接受 0，新增 ENABLED 开关（见下） |
| 2026-09-12 | T61.7 重启后首轮立基准 | ✅ | 重启后 3 周期存量沙箱（oom_kill=6）零误报 |
| 2026-09-12 | T61.8 重建后静默重置且归因恢复 | ✅ | 执行中发现**跨世代 id 冲突**（同 session 新旧沙箱 total 相同时 id 相同被幂等吞）与**基准跨世代残留**（delta 假静默），已修复：id 纳入 sandboxID（`oom-<session>-<sandbox>-<total>`）+ destroySandbox 清理采样基准。修复后旧世代 total=1 / 新世代 total=2 两条并存 |
| 2026-09-12 | T61.9 不可达降级与自愈 | ✅ | 假行（不存在的沙箱 id）触发 `oom scan reconnect failed` WARN×N；删除假行后日志停止；任务全程存活 |
| 2026-09-12 | T61.10 多沙箱同轮归因 + 审计 API | ✅ | 双 128Mi 沙箱同轮各自归因（total=1 各一条）；`GET /session/:id/execs` 返回 `execs[].execId` 前缀 `oom-` 可审计 |

> **执行中发现并修复的问题（2026-09-12）**：
> 1. **busybox awk 多文件陷阱**：采样命令原写法 `awk '...' /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory/memory.oom_control`，v1 沙箱无 memory.events，busybox awk 遇第一个文件不存在直接退出（`2>/dev/null` 吞掉报错），采样永远返回空——v1 沙箱功能完全失灵且零痕迹。已改 `||` 链逐文件探测；`sandbox-proxy.ts` 的 diagCommand 同病同修。单测锁定该语义。
> 2. **`number()` Flag 不接受 0**：`OPENCODE_SANDBOX_OOM_SCAN_INTERVAL_SEC=0` 会回落默认 60，无法禁用。新增 `OPENCODE_SANDBOX_OOM_SCAN_ENABLED`（`!falsy` 默认开）。
> 3. **可观测性补齐**：任务增加 started/completed/reconnect failed/insert failed 日志（insert 失败区分主键冲突与真实错误）。首轮排查因任务完全静默耗时较长。
>
> **环境注意事项**：远端测试 PG 的 `exec_log` 表缺 `rule` 列（migration-pg `20260912000000_exec_log_denied` 未执行），导致**所有**走新 schema 的 exec_log insert 失败（不止 OOM 功能）。已手动 `ALTER TABLE "exec_log" ADD COLUMN IF NOT EXISTS "rule" text;`。部署新镜像前务必确认 PG 迁移已执行。
