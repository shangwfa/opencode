# Read 工具快速超时（files API 挂死快速失败）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），PG 模式。环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供。

## 背景

对最近一周 `exec_log` / `part` 数据的诊断发现（2026-08-19）：

- 全部 11 条 60s+ 的 `read` 工具调用均为 `Tool execution timed out after 120s (watchdog)` 错误——即 files API（`sb.files.getFileInfo` / `readBytes`）挂死后无自身超时，只能等外层 watchdog 120s 兜底，实际记录耗时 170~229s（120s 超时 + 最多 60s 扫描间隔 + 落库延迟）。
- 同会话同期的 exec 命令通道全部毫秒级正常，排除排队/锁/PVC I/O 假说。
- 观测到 agent 自救有效：read 超时后换宿主机路径重试 27ms 成功——只要快速失败，agent 能立即恢复。

**修复**（`packages/opencode/src/tool/read.ts`）：

- `getFileInfo` / `readBytes`(header) / `readTextPage`(正文) 三处 files API 调用改为 **15s 超时 + 重试 1 次**，仍失败则快速返回错误（header/正文路径保留 destroy 沙箱自愈）。
- `watchdog.ts` 扫描间隔 60s → 15s（`OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC` 可配），卡死工具标记落库延迟收敛。

**预期效果**：read 挂死场景从 170~230s 收敛到最多 ~30s（15s×2）。

## 用例

```bash
source docs/test-cases/test-env.sh
source docs/test-cases/test-lib.sh

# ============================================================
# T-RFT.1 正常 read 回归（不受快速超时影响）
# ============================================================
SID=$(new_sid)
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo fast-timeout-ok > /workspace/rft.txt"}' > /dev/null

START=$(date +%s)
curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 read 工具读取 /workspace/rft.txt 并原样告诉我内容，不要用 bash\"}],\"model\":$MODEL}" \
  | jexec "d['info'] if 'info' in d else d" > /dev/null
DUR=$(( $(date +%s) - START ))

# 查 read part 的状态与耗时
READ_ROW=$(psql "$PG_URL" -t -A -c "
  SELECT data->'state'->>'status' || '|' ||
    ((data->'state'->'time'->>'end')::bigint - (data->'state'->'time'->>'start')::bigint)
  FROM part WHERE session_id='$SID' AND data->>'tool'='read'
  ORDER BY time_created DESC LIMIT 1")
echo "T-RFT.1 read part: $READ_ROW, 消息总耗时 ${DUR}s"

STATUS=${READ_ROW%%|*}; RDUR=${READ_ROW##*|}
[ "$STATUS" = "completed" ] && [ "$RDUR" -lt 15000 ] && pass "T-RFT.1" || fail "T-RFT.1" "status=$STATUS dur=${RDUR}ms"

# ============================================================
# T-RFT.2 沙箱失联后 read 快速失败（核心用例）
# ============================================================
# kill-sandbox 制造 files API 不可达/半开窗口，read 应在 ~35s 内
# 返回明确错误（而非修复前挂 170~230s 等 watchdog）。
SID2=$(new_sid)
curl -s --noproxy '*' -m 90 -X POST "$BASE/session/$SID2/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo x > /workspace/rft2.txt"}' > /dev/null
curl -s --noproxy '*' -m 10 -X POST "$BASE/session/$SID2/kill-sandbox" > /dev/null

START=$(date +%s)
curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID2/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 read 工具读取 /workspace/rft2.txt，只报告成功或失败及原因\"}],\"model\":$MODEL}" \
  > /dev/null
DUR=$(( $(date +%s) - START ))

READ_ROW=$(psql "$PG_URL" -t -A -c "
  SELECT coalesce(data->'state'->>'status','(pending)') || '|' ||
    coalesce(((data->'state'->'time'->>'end')::bigint - (data->'state'->'time'->>'start')::bigint)::text,'-') || '|' ||
    coalesce(left(data->'state'->>'error',60),'')
  FROM part WHERE session_id='$SID2' AND data->>'tool'='read'
  ORDER BY time_created DESC LIMIT 1")
echo "T-RFT.2 read part: $READ_ROW, 消息总耗时 ${DUR}s"

STATUS2=${READ_ROW%%|*}; RDUR2=$(echo "$READ_ROW" | cut -d'|' -f2)
# 无论成功（沙箱快速重建）还是失败，都必须快速出结果；不允许出现 watchdog 超时错误
echo "$READ_ROW" | grep -q "watchdog" && fail "T-RFT.2" "出现 watchdog 超时：$READ_ROW"
if [ "$RDUR2" != "-" ] && [ "$RDUR2" -lt 60000 ]; then
  pass "T-RFT.2" "read 快速返回 (${RDUR2}ms, status=$STATUS2)"
else
  fail "T-RFT.2" "read 未在 60s 内返回: $READ_ROW"
fi

# ============================================================
# T-RFT.3 watchdog 扫描间隔（观察项）
# ============================================================
# 若环境中存在任一被 watchdog 标记的 part，其 (end-start) 与
# OPENCODE_WATCHDOG_TIMEOUT_SEC(默认120) 之差应 ≤ 扫描间隔+余量(~25s)
MAXGAP=$(psql "$PG_URL" -t -A -c "
  SELECT max((data->'state'->'time'->>'end')::bigint - (data->'state'->'time'->>'start')::bigint)
  FROM part
  WHERE data->>'type'='tool' AND data->'state'->>'error' LIKE '%watchdog%'
    AND time_created > (extract(epoch from now())-86400)*1000")
if [ -n "$MAXGAP" ] && [ "$MAXGAP" -gt 0 ]; then
  echo "T-RFT.3 近24h watchdog part 最大耗时 ${MAXGAP}ms（修复前观测 170000~229000）"
  [ "$MAXGAP" -le 150000 ] && pass "T-RFT.3" || fail "T-RFT.3" "gap=${MAXGAP}ms 超 150s"
else
  echo "T-RFT.3 近24h 无 watchdog part，跳过（无卡死样本）"
fi

summary
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-RFT.1 | read `completed` 且耗时 <15s（正常路径无回归） |
| T-RFT.2 | read 在 60s 内返回（成功或明确 error），**不出现** `timed out ... (watchdog)` |
| T-RFT.3 | 新产生的 watchdog part 耗时 ≤150s（120s 超时 + 15s 扫描 + 余量），修复前为 170~229s |

> 注：T-RFT.2 依赖 kill-sandbox 后沙箱重建窗口期能命中 files API 挂死路径；若沙箱重建足够快导致 read 直接成功，也算 PASS（快速出结果即可），但建议复测多次争取命中重建窗口。

## 复测记录

| 日期 | 镜像 tag | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `9b9a352b5a-rft2`（本地 PG + 远端沙箱） | T-RFT.1 | ✅ PASS | read completed，86ms |
| 2026-08-19 | `9b9a352b5a-rft2`（本地 PG + 远端沙箱） | T-RFT.2 | ✅ PASS | kill-sandbox 后 read 4390ms 完成（沙箱快速重建），无 watchdog 错误，消息总耗时 10s |
| | | T-RFT.3 | | 近 24h 无 watchdog part，待后续观察 |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含 header 单飞改动） | T-RFT.1 | ✅ PASS | read completed 70ms，消息总耗时 8s |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含 header 单飞改动） | T-RFT.2 | ✅ PASS | kill-sandbox 后 read 1847ms completed（沙箱快速重建），无 watchdog 错误，消息总耗时 7s |
| 2026-08-19 | `files-api-test`（组合 3） | T-RFT.3 | — | 近 24h 无 watchdog part，继续观察 |
| 2026-08-19 | `perf-rft`（组合 2：本地 PG + 远端沙箱，LSP 修复已撤销） | T-RFT.1 | ✅ PASS | read completed 52ms |
| 2026-08-19 | `perf-rft`（组合 2） | T-RFT.2 | ✅ PASS | kill-sandbox 后 read 4364ms completed（远端沙箱快速重建），无 watchdog |
| 2026-08-19 | `perf-rft`（组合 2） | T-RFT.3 | — | 近 24h 无 watchdog part，继续观察 |
