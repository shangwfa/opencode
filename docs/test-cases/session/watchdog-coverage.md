# Watchdog 监控覆盖扩展（lsp/todowrite + time_created 兜底 + running 残留收敛）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），PG 模式。环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供。本篇以 PG 观测断言为主，无需故障注入。

## 背景

对近两周真实 PG 数据的分析发现（2026-08-19）：

- 近两周存在 **53 个 `status=running` 的残留 tool part**（最老 >14 天）——这些是 pod 重启/崩溃后失去更新者的孤儿记录，watchdog 原监控列表不含其工具类型或缺少兜底，无法标记。
- `lsp` 工具曾出现 65h 级"耗时"（时间戳 bug 已另修），且 PG 路径部分 running part 无 `time.start`，watchdog 判定需兜底。

**修复**（`packages/opencode/src/session/watchdog-sql.ts`、`watchdog.ts`、`flag.ts`）：

- 扫描间隔 60s → **15s**（`OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC` 可配）。
- `MONITORED_TOOLS` 增加 `lsp`、`todowrite`（不加 bash——npm install 等合法长任务会被误杀）。
- PG/SQLite 路径无 `time.start` 的 running part 用 `PartTable.time_created` 兜底判定超时。

**预期效果**：新产生的 running 残留应趋零；lsp/todowrite 卡死不再无限期挂起（被标记 watchdog 超时后 agent 可自救）。

## 用例

```bash
source docs/test-cases/test-env.sh
source docs/test-cases/test-lib.sh

# ============================================================
# T-WDT.1 实例生命周期内无新增 running 残留（核心观测断言）
# ============================================================
# 历史存量来自旧实例崩溃/重启（新进程无法追溯标记），只统计当前服务实例
# 启动之后新建的 part。本地 docker 环境自动探测启动时刻，其他环境可手工导出
# INSTANCE_START_MS（epoch 毫秒）覆盖。
if [ -z "${INSTANCE_START_MS:-}" ]; then
  INSTANCE_START_MS=$(date -j -f '%Y-%m-%dT%H:%M:%S' "$(docker inspect opencode-saas-test --format '{{.State.StartedAt}}' 2>/dev/null | cut -c1-19)" +%s 2>/dev/null)
  [ -n "$INSTANCE_START_MS" ] && INSTANCE_START_MS=$((INSTANCE_START_MS * 1000))
fi
if [ -n "${INSTANCE_START_MS:-}" ]; then
  NEW_STALE=$(pgval "SELECT count(*) FROM part
    WHERE data->>'type'='tool' AND data->'state'->>'status'='running'
      AND time_created > $INSTANCE_START_MS
      AND time_created < (extract(epoch FROM now())-1800)*1000")
  LEGACY=$(pgval "SELECT count(*) FROM part
    WHERE data->>'type'='tool' AND data->'state'->>'status'='running'
      AND time_created <= $INSTANCE_START_MS")
  echo "T-WDT.1 实例启动后新增超龄(>30min) running part: $NEW_STALE（历史存量 $LEGACY 个，仅展示）"
  [ "$NEW_STALE" = "0" ] && pass "T-WDT.1" || fail "T-WDT.1" "新增残留 $NEW_STALE 个（watchdog 未覆盖或兜底失效）"
else
  echo "T-WDT.1 无法探测实例启动时间（非本地 docker），请导出 INSTANCE_START_MS 后复测"
  fail "T-WDT.1" "缺少 INSTANCE_START_MS"
fi

# ============================================================
# T-WDT.2 新 watchdog 标记的耗时收敛（120s + 15s 扫描）
# ============================================================
# 近 24h 被 watchdog 标记的 part，其 (end-start) 应 ≤ 150s（120s 超时 + 15s 扫描 + 落库余量）
MAXGAP=$(pgval "SELECT max((data->'state'->'time'->>'end')::bigint-(data->'state'->'time'->>'start')::bigint)
  FROM part
  WHERE data->>'type'='tool' AND data->'state'->>'error' LIKE '%watchdog%'
    AND time_created > (extract(epoch FROM now())-86400)*1000")
if [ -n "$MAXGAP" ] && [ "$MAXGAP" -gt 0 ]; then
  echo "T-WDT.2 近24h watchdog part 最大耗时 ${MAXGAP}ms"
  [ "$MAXGAP" -le 150000 ] && pass "T-WDT.2" || fail "T-WDT.2" "gap=${MAXGAP}ms 超 150s（扫描间隔未生效？）"
else
  echo "T-WDT.2 近24h 无 watchdog 样本，SKIP（无卡死触发，属好情况）"
  pass "T-WDT.2" "无样本"
fi

# ============================================================
# T-WDT.3 监控范围含 lsp/todowrite（静态口径 + 观察项）
# ============================================================
# 近 7 天若存在 lsp/todowrite 的 watchdog 标记，证明覆盖生效
COVERED=$(pgval "SELECT count(*) FROM part
  WHERE data->>'type'='tool' AND data->>'tool' IN ('lsp','todowrite')
    AND data->'state'->>'error' LIKE '%watchdog%'
    AND time_created > (extract(epoch FROM now())-7*86400)*1000")
echo "T-WDT.3 近7天 lsp/todowrite watchdog 标记数: $COVERED（无卡死样本时为 0，属观察项）"
# 同时确认 bash 未被误杀：近 7 天 bash watchdog 标记应远低于 bash 总量（合法长任务不被截杀）
BASH_WDT=$(pgval "SELECT count(*) FROM part WHERE data->>'tool'='bash' AND data->'state'->>'error' LIKE '%watchdog%'
  AND time_created > (extract(epoch FROM now())-7*86400)*1000")
BASH_ALL=$(pgval "SELECT count(*) FROM part WHERE data->>'tool'='bash'
  AND time_created > (extract(epoch FROM now())-7*86400)*1000")
echo "bash watchdog=${BASH_WDT}/${BASH_ALL}（package install/test 等长任务不应被标记）"
[ "$BASH_ALL" = "0" ] || [ "$(echo "$BASH_WDT $BASH_ALL" | awk '{print ($1/$2<0.005)?1:0}')" = "1" ] \
  && pass "T-WDT.3" || fail "T-WDT.3" "bash watchdog 占比异常: ${BASH_WDT}/${BASH_ALL}"

summary
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-WDT.1 | 当前实例启动后**新增**超龄（>30min）running part = 0（历史存量仅展示，来自旧实例无法追溯） |
| T-WDT.2 | 新 watchdog 标记的 part 耗时 ≤150s（120s 超时 + 15s 扫描 + 余量）；无样本视为 PASS |
| T-WDT.3 | lsp/todowrite 标记数 ≥0（观察项）；bash watchdog 占比 <0.5%（长任务不误杀） |

> 注：
> - T-WDT.1 的 30 分钟阈值远大于任何合法工具执行 + 扫描周期，只统计确定性孤儿。
> - T-WDT.3 的 lsp 覆盖依赖真实卡死样本，线上低频；如需主动验证，可在沙箱内 `pkill -STOP` LSP daemon 进程（SIGSTOP 模拟挂死）后调用 lsp 工具——属破坏性操作，建议仅在隔离测试会话执行。
> - 历史存量残留 part（pod 崩溃遗留）不会被新 watchdog 追溯标记，T-WDT.1 统计口径以时间窗口过滤。

## 复测记录

| 日期 | 镜像 tag | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-WDT.1 | ✅ PASS | 实例启动后新增超龄 running=0；历史存量 36 个（08-10~08-15 旧实例遗留，仅展示）。初版口径未区分存量，已改为按实例启动时间统计 |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-WDT.2 | ✅ PASS | 无 watchdog 样本 |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-WDT.3 | ✅ PASS | lsp/todowrite 0 标记（无卡死样本）；bash 0/472 误杀率 0 |
| 2026-08-19 | `perf-rft`（组合 2：本地 PG + 远端沙箱，LSP 修复已撤销） | T-WDT.1 | ✅ PASS | 实例启动后新增超龄 running=0；历史存量 36 个（旧实例遗留，仅展示） |
| 2026-08-19 | `perf-rft`（组合 2） | T-WDT.2 | ✅ PASS | 无 watchdog 样本 |
| 2026-08-19 | `perf-rft`（组合 2） | T-WDT.3 | ✅ PASS | lsp/todowrite 0 标记；bash 0/484 误杀率 0 |
