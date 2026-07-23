# 空闲沙箱定期回收（Idle Reap）

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
> 设计方案详见 [`../sandbox-idle-reap.md`](../sandbox-idle-reap.md)。

## 背景

会话执行任务时可能创建沙箱。现有沙箱销毁机制有三层，但对 `keep_alive=true` 的沙箱存在回收缺口：

| 机制 | 触发时机 | 阈值 | 覆盖 keep_alive? |
|------|---------|------|-----------------|
| `onIdle` 即时销毁 | Runner 转入 idle | 即时 | ❌ 跳过 |
| 僵尸清理 | 后台周期扫描 | 默认 60 min 扫描 / 120 min 判定（flag 可配；测试环境 `OPENCODE_SANDBOX_IDLE_KILL_SEC=30`） | ❌ 只扫 `keep_alive=false` |
| Session 删除 | 显式调用 | 即时 | ✅ |

**缺口**：`keep_alive=true` 的沙箱（`background=true` 的 bash 命令触发），在会话 idle 后不会被即时销毁，也不会被僵尸清理扫描。需要新增一轮 **30 分钟无活跃即销毁** 的后台扫描，覆盖所有存活沙箱。

## 改动清单

| 文件 | 改动 | 防御层 |
|------|------|--------|
| `packages/opencode/src/flag/flag.ts` | 新增 `OPENCODE_SANDBOX_IDLE_REAP_SEC`（默认 1800） | 可配置阈值 |
| `packages/opencode/src/tool/sandbox-provider.ts` | `SandboxConfig` 新增 `idleReapMs` + `idleReapIntervalMs`；新增 `dbTouchSandbox`；pgLayer 新增 idle reap 扫描循环 | 活跃刷新 + 时间兜底（资源回收） |

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. PG 记录 | 查 `sandbox.state` | 超时记录从 `running` 变为 `destroyed` |
| 2. PG 记录 | 查 `sandbox.keep_alive` | `keep_alive` 保持不变（不修改会话状态） |
| 3. 容器日志 | `docker logs` 含 `--print-logs` | 能看到 `idle sandbox reap scan ... count=` |
| 4. 环境变量 | `OPENCODE_SANDBOX_IDLE_REAP_SEC` | 覆盖默认 30 分钟阈值 |
| 5. 活跃刷新 | 执行使用沙箱的 API/工具后查 `time_updated` | `time_updated` 被刷新，活跃沙箱不被误杀 |

## 通用变量

```bash
# 环境变量 $BASE $PG_URL $MODEL 由 test-env.sh 全局提供（source test-env.sh [1|2|3]）

# 启动容器时务必加 --print-logs 才能看到 log.info 输出
# docker run ... opencode-saas-sandbox-test:v2fix serve --hostname 0.0.0.0 --port 4096 --print-logs
```

---

## 三十、空闲沙箱定期回收

### T30.1 超时沙箱被自动回收

**验证点**：idle reap 每 `idleReapIntervalMs`（默认 60s）扫描一次 `SandboxTable`，发现 `state=running` 且 `time_updated` 超过 `idleReapMs`（默认 30 分钟）的记录后，直接销毁沙箱并标记 `state=destroyed`。不修改 `keep_alive` 标志（用户重启会话继续时仍需要该状态）。

```bash
# 1. 向 PG 插入一个"超时"的沙箱记录（time_updated 设为 31 分钟前）
psql "$PG_URL" <<'SQL'
INSERT INTO sandbox (id, session_id, host, state, keep_alive, command_session_id, time_created, time_updated)
VALUES (
  'sb_test_reap_basic',
  'ses_test_reap_basic',
  'http://10.0.0.1:9999',
  'running',
  false,
  NULL,
  (extract(epoch from now()-interval '32 minute')*1000)::bigint,
  (extract(epoch from now()-interval '31 minute')*1000)::bigint
)
ON CONFLICT (session_id) DO UPDATE SET
  state = 'running',
  keep_alive = false,
  time_updated = (extract(epoch from now()-interval '31 minute')*1000)::bigint;
SQL

echo "插入超时沙箱记录（keep_alive=false, time_updated=31min ago）"
echo ""
echo "等 idle reap 扫描（最多 70s）..."

# 2. 轮询 sandbox 状态
for i in $(seq 1 14); do
  sleep 5
  STATE=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='ses_test_reap_basic'" | tr -d '[:space:]')
  echo "  [$((i*5))s] state=$STATE"
  if [ "$STATE" = "destroyed" ]; then
    echo ""
    echo "✅ T30.1 PASS: 超时沙箱已被 idle reap 回收"
    break
  fi
done

# 3. 清理
psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='ses_test_reap_basic'" >/dev/null
```

**期望**：
- 70s 内 `sandbox.state` 从 `running` 变为 `destroyed`
- 容器日志含 `service=sandbox-provider ... idle sandbox reap scan ... count=1`

---

### T30.2 keep_alive=true 的沙箱也被回收

**验证点**：idle reap 不区分 `keep_alive`，即使沙箱被标记为 `keep_alive=true`（后台 bash 任务触发），超过 `idleReapMs` 阈值后同样被回收。直接销毁沙箱，不修改 `keep_alive` 标志（用户重启会话继续时仍需要该状态）。

```bash
# 1. 插入 keep_alive=true 的超时记录
psql "$PG_URL" <<'SQL'
INSERT INTO sandbox (id, session_id, host, state, keep_alive, command_session_id, time_created, time_updated)
VALUES (
  'sb_test_reap_ka',
  'ses_test_reap_ka',
  'http://10.0.0.1:9999',
  'running',
  true,
  NULL,
  (extract(epoch from now()-interval '32 minute')*1000)::bigint,
  (extract(epoch from now()-interval '31 minute')*1000)::bigint
)
ON CONFLICT (session_id) DO UPDATE SET
  state = 'running',
  keep_alive = true,
  time_updated = (extract(epoch from now()-interval '31 minute')*1000)::bigint;
SQL

echo "插入超时沙箱记录（keep_alive=true, time_updated=31min ago）"
echo ""
echo "等 idle reap 扫描（最多 70s）..."

for i in $(seq 1 14); do
  sleep 5
  STATE=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='ses_test_reap_ka'" | tr -d '[:space:]')
  KEEP=$(psql "$PG_URL" -t -c "SELECT keep_alive FROM sandbox WHERE session_id='ses_test_reap_ka'" | tr -d '[:space:]')
  echo "  [$((i*5))s] state=$STATE keep_alive=$KEEP"
  if [ "$STATE" = "destroyed" ]; then
    echo ""
    if [ "$KEEP" = "t" ]; then
      echo "✅ T30.2 PASS: keep_alive=true 的沙箱也被回收，且 keep_alive 未被修改"
    else
      echo "❌ T30.2 FAIL: keep_alive 被 idle reap 修改为 $KEEP"
    fi
    break
  fi
done

psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='ses_test_reap_ka'" >/dev/null
```

**期望**：
- 70s 内 `sandbox.state` 变为 `destroyed`
- `sandbox.keep_alive` 仍为 `true`（不因 idle reap 而修改）
- 与 T30.1 行为一致（不因 `keep_alive=true` 而跳过）

> **对比**：现有僵尸清理（`zombie sandbox cleanup`）条件含 `keep_alive=false`，会跳过此记录。idle reap 填补了这个缺口。

---

### T30.3 未超时沙箱不被误杀

**验证点**：`time_updated` 在 `idleReapMs` 阈值内的沙箱不被回收。

```bash
# 1. 插入"新鲜"记录（time_updated=now，未超时）
psql "$PG_URL" <<'SQL'
INSERT INTO sandbox (id, session_id, host, state, keep_alive, command_session_id, time_created, time_updated)
VALUES (
  'sb_test_reap_fresh',
  'ses_test_reap_fresh',
  'http://10.0.0.1:9999',
  'running',
  false,
  NULL,
  (extract(epoch from now())*1000)::bigint,
  (extract(epoch from now())*1000)::bigint
)
ON CONFLICT (session_id) DO UPDATE SET
  state = 'running',
  keep_alive = false,
  time_updated = (extract(epoch from now())*1000)::bigint;
SQL

echo "等待 70s（超过一个完整扫描周期 + buffer）..."
sleep 70

STATE=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='ses_test_reap_fresh'" | tr -d '[:space:]')

if [ "$STATE" = "running" ]; then
  echo "✅ T30.3 PASS: 未超时沙箱保持 running"
else
  echo "❌ T30.3 FAIL: 未超时沙箱被误杀（state=$STATE）"
fi

psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='ses_test_reap_fresh'" >/dev/null
```

**期望**：
- `sandbox.state` 保持 `running`
- 容器日志中 idle reap scan 的 `count=0`（或不含此 session_id）

---

### T30.4 CAS 保护：扫描期间 time_updated 被更新则跳过

**验证点**：idle reap 查询到候选记录后，在 `lock` 内重新读取 `current` 并校验 `current.time_updated <= threshold`。如果扫描后沙箱又被活跃使用（`time_updated` 被更新），CAS 校验不命中，跳过不误杀。

```bash
# 1. 插入超时记录
psql "$PG_URL" <<'SQL'
INSERT INTO sandbox (id, session_id, host, state, keep_alive, command_session_id, time_created, time_updated)
VALUES (
  'sb_test_reap_cas',
  'ses_test_reap_cas',
  'http://10.0.0.1:9999',
  'running',
  false,
  NULL,
  (extract(epoch from now()-interval '32 minute')*1000)::bigint,
  (extract(epoch from now()-interval '31 minute')*1000)::bigint
)
ON CONFLICT (session_id) DO UPDATE SET
  state = 'running',
  keep_alive = false,
  time_updated = (extract(epoch from now()-interval '31 minute')*1000)::bigint;
SQL

echo "插入超时记录，开始持续刷新 time_updated..."

# 2. 持续刷新 time_updated（每 20s 一次，覆盖至少一个扫描周期）
for i in $(seq 1 6); do
  psql "$PG_URL" -c "UPDATE sandbox SET time_updated = (extract(epoch from now())*1000)::bigint WHERE session_id='ses_test_reap_cas'" >/dev/null
  sleep 20
done

STATE=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='ses_test_reap_cas'" | tr -d '[:space:]')

if [ "$STATE" = "running" ]; then
  echo "✅ T30.4 PASS: 持续活跃的沙箱未被误杀（CAS 保护生效）"
else
  echo "❌ T30.4 FAIL: 持续活跃的沙箱被误杀（state=$STATE）"
fi

psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='ses_test_reap_cas'" >/dev/null
```

**期望**：
- `sandbox.state` 保持 `running`
- 每次刷新 `time_updated` 后，idle reap 的 CAS 校验（`current.time_updated > threshold`）不命中，跳过销毁

---

### T30.5 沙箱使用会刷新 time_updated

**验证点**：`getOrCreate` 缓存命中、健康重连、`get`、`runInSession`、`runDetached` 等使用沙箱的路径会调用 `dbTouchSandbox` 刷新 `sandbox.time_updated`。这样 idle reap 使用 `time_updated` 判断空闲时，不会误杀仍在使用的沙箱。

```bash
# 1. 创建一个真实会话并触发沙箱命令执行
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r '.id')

curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo touch-check"}' >/dev/null

BEFORE=$(psql "$PG_URL" -t -c "SELECT time_updated FROM sandbox WHERE session_id='$SID'" | tr -d '[:space:]')
echo "before=$BEFORE"

# 2. 人为把 time_updated 调旧，模拟快要被 idle reap 扫到
psql "$PG_URL" -c "UPDATE sandbox SET time_updated=(extract(epoch from now()-interval '31 minute')*1000)::bigint WHERE session_id='$SID'" >/dev/null

STALE=$(psql "$PG_URL" -t -c "SELECT time_updated FROM sandbox WHERE session_id='$SID'" | tr -d '[:space:]')
echo "stale=$STALE"

# 3. 再次使用沙箱，验证 time_updated 被 touch 回当前时间
curl -s -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo alive"}' >/dev/null

AFTER=$(psql "$PG_URL" -t -c "SELECT time_updated FROM sandbox WHERE session_id='$SID'" | tr -d '[:space:]')
STATE=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='$SID'" | tr -d '[:space:]')

echo "after=$AFTER state=$STATE"

if [ "$AFTER" -gt "$STALE" ] && [ "$STATE" = "running" ]; then
  echo "✅ T30.5 PASS: 使用沙箱刷新 time_updated，沙箱保持 running"
else
  echo "❌ T30.5 FAIL: time_updated 未刷新或沙箱被误杀"
fi

echo "等待 70s，确认下一轮 idle reap 不会回收刚刚被 touch 的沙箱..."
sleep 70

STATE2=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='$SID'" | tr -d '[:space:]')
if [ "$STATE2" = "running" ]; then
  echo "✅ T30.5 PASS: 扫描周期后沙箱仍保持 running"
else
  echo "❌ T30.5 FAIL: touch 后仍被 idle reap 回收（state=$STATE2）"
fi

# 4. 清理
curl -s -X POST "$BASE/session/$SID/kill-sandbox" >/dev/null || true
psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='$SID'" >/dev/null
```

**期望**：
- 第二次 exec 后 `sandbox.time_updated` 大于人为调旧后的 `STALE`。
- `sandbox.state` 保持 `running`。
- 等待一个扫描周期后仍不应被 idle reap 标记为 `destroyed`。

---

### T30.6 可观测性：扫描日志输出

**验证点**：每次 idle reap 扫描在日志输出 `count`（扫描到的候选数），便于诊断"沙箱未被回收"问题。

```bash
# 前置：执行 T30.1 后检查日志

docker logs opencode-saas-test 2>&1 | grep "idle sandbox reap scan" | tail -3
```

**期望**：
- 至少一行 `idle sandbox reap scan` 日志含 `count=1`（T30.1 的超时记录被扫描到）
- 如果 `count=0` 但 PG 中确实有超时记录，需检查 `time_updated` 计算或查询条件

---

### T30.7 配置注入：OPENCODE_SANDBOX_IDLE_REAP_SEC 覆盖默认阈值

**验证点**：通过环境变量 `OPENCODE_SANDBOX_IDLE_REAP_SEC` 覆盖默认 30 分钟阈值。设为 60（60 秒）后，1 分钟前的记录即被回收。

```bash
# 1. 启动容器时设置 IDLE_REAP_SEC=60
# docker run -e OPENCODE_SANDBOX_IDLE_REAP_SEC=60 ... opencode-saas-sandbox-test:v2fix \
#   serve --hostname 0.0.0.0 --port 4096 --print-logs

# 2. 插入 time_updated=90s ago 的记录（超过 60s 阈值但远小于默认 30min）
psql "$PG_URL" <<'SQL'
INSERT INTO sandbox (id, session_id, host, state, keep_alive, command_session_id, time_created, time_updated)
VALUES (
  'sb_test_reap_cfg',
  'ses_test_reap_cfg',
  'http://10.0.0.1:9999',
  'running',
  false,
  NULL,
  (extract(epoch from now()-interval '95 second')*1000)::bigint,
  (extract(epoch from now()-interval '90 second')*1000)::bigint
)
ON CONFLICT (session_id) DO UPDATE SET
  state = 'running',
  keep_alive = false,
  time_updated = (extract(epoch from now()-interval '90 second')*1000)::bigint;
SQL

echo "插入 time_updated=90s ago 的记录（超过 60s 自定义阈值）"
echo "等 idle reap 扫描（最多 70s）..."

for i in $(seq 1 14); do
  sleep 5
  STATE=$(psql "$PG_URL" -t -c "SELECT state FROM sandbox WHERE session_id='ses_test_reap_cfg'" | tr -d '[:space:]')
  if [ "$STATE" = "destroyed" ]; then
    echo "✅ T30.7 PASS: 自定义阈值生效，90s 前的记录被回收"
    break
  fi
done

psql "$PG_URL" -c "DELETE FROM sandbox WHERE session_id='ses_test_reap_cfg'" >/dev/null
```

**期望**：
- 70s 内 `sandbox.state` 变为 `destroyed`
- 证明 `OPENCODE_SANDBOX_IDLE_REAP_SEC=60` 覆盖了默认 1800 秒

---

### T30.8 单元测试（bun test）

**验证点**：`packages/opencode/test/tool/sandbox-idle-reap.test.ts` 覆盖核心逻辑，使用短阈值（`idleReapMs=5s`，`idleReapIntervalMs=500ms`）加速测试，并验证 `keep_alive=true` 被回收后仍保持 true。

```bash
# 运行单元测试（需要本地 PG）
OPENCODE_DATABASE_URL=postgresql://ruomu@localhost:5432/opencode_test \
bun test test/tool/sandbox-idle-reap.test.ts
```

**期望**：4 个用例全部通过：

| 用例 | 验证 | 耗时 |
|------|------|------|
| 超时记录被标记为 `destroyed` | 基本回收 | ~6s |
| `keep_alive=true` 的超时记录也被回收 | keepAlive 回收 | ~7s |
| 未超时记录保持 `running` | 阈值边界 | ~3s |
| 持续更新 `time_updated` 不被误杀 | CAS 保护 | ~4s |

---

## 排查场景对照表

| 现象 | 可能原因 | 验证用例 | 日志关键字 |
|------|---------|---------|-----------|
| keep_alive 沙箱长时间不回收 | idle reap 未启动或阈值过大 | T30.2 | `idle sandbox reap scan ... count=` |
| 活跃沙箱被误杀 | CAS 校验未生效 | T30.4 | 销毁前 `current.time_updated > threshold` 应跳过 |
| 使用中的沙箱仍被回收 | 使用路径未刷新 `time_updated` | T30.5 | 检查 `dbTouchSandbox` 调用路径 |
| 新建沙箱立即被回收 | 阈值配置过小 | T30.7 | 检查 `OPENCODE_SANDBOX_IDLE_REAP_SEC` |
| idle reap scan 未执行 | pgLayer 未构建或 fiber 未启动 | T30.6 | 无 `idle sandbox reap scan` 日志 |
| destroyed 记录再次被扫 | 查询条件缺少 `state=running` | T30.1 | `count` 不应包含 `destroyed` 记录 |

---

## 改动文件清单

```
packages/opencode/src/flag/flag.ts              # 新增 OPENCODE_SANDBOX_IDLE_REAP_SEC（默认 1800）
packages/opencode/src/tool/sandbox-provider.ts  # SandboxConfig 新增 idleReapMs + idleReapIntervalMs + dbTouchSandbox + pgLayer 新增扫描循环
packages/opencode/test/tool/sandbox-idle-reap.test.ts  # 单元测试（新建）
```

---

## 防御链路示意

```
会话 idle
  │
  ├─ keep_alive=false → onIdle 即时销毁（现有，L0）
  │
  └─ keep_alive=true  → 沙箱保留
        │
        ▼
  Idle Reap 扫描（每 idleReapIntervalMs，L1）
        │
        ├─ 查 SandboxTable: state=running AND time_updated < now - idleReapMs
        │    （不限 keep_alive，覆盖所有存活沙箱）
        │
        ├─ lock + CAS 校验（current.id/state/time_updated 三重匹配）
        │    └─ 防止误杀扫描后又被活跃使用的沙箱
        │
        └─ reconnect → destroySandbox（kill + close + mark destroyed）
              └─ reconnect 失败 → bestEffortKill + mark destroyed
        │
        ▼
  僵尸清理（每 idleKillMs，L2，现有）
        │
        └─ 处理进程崩溃后遗留的孤儿记录（idle reap 错过的窗口）
```
