# Grep 沙箱端结果截断（rg 全局 -m 管道）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），PG 模式。环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供。

## 背景

对近两周真实 PG 数据的诊断发现（2026-08-19）：

- grep p50 191ms，但 p90 5.0s、p99 29.8s；`metadata.truncated=true`（超 100 条）的调用 p50 2.74s、p90 12.4s。
- 原实现 `rg --json <pattern> <path>` 全量扫描并把全部 stdout 跨网络回传，服务端解析后才 `slice(0, 100)`——100 条上限完全没有减少扫描量、序列化量和传输量，宽匹配耗时随仓库规模线性恶化。

**修复**（`packages/opencode/src/tool/grep.ts`）：

- 命令追加管道 `| rg -m <limit+1> '"type":"match"'`——第二个 rg 从单一 stdin 流读取，`-m` 为**全局**上限，达到 101 条后关闭管道使第一个 rg 提前终止（SIGPIPE），扫描/传输量收敛到 ~101 条。
- 副作用：begin/end/summary 等非 match JSON 行被过滤（解析端本来也只取 `type === "match"`，行为等价）。

**预期效果**：宽匹配 p90 显著下降且不随匹配总数线性增长；截断语义与输出格式不变。

## 用例

```bash
source docs/test-cases/test-env.sh
source docs/test-cases/test-lib.sh

# ============================================================
# T-GTR.1 超 100 条匹配正确截断（语义回归）
# ============================================================
SID=$(new_sid -kb)
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/gtr && for i in $(seq 1 300); do echo \"gtr-needle line $i\" >> /workspace/gtr/big.txt; done"}' > /dev/null

curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 grep 工具在 /workspace/gtr 目录搜索 pattern gtr-needle，报告找到多少条、是否被截断\"}],\"model\":$MODEL}" \
  > /dev/null

ROW=$(pgval "SELECT data->'state'->>'status' || '|' ||
  coalesce(data->'state'->'metadata'->>'matches','-') || '|' ||
  coalesce(data->'state'->'metadata'->>'truncated','-') || '|' ||
  ((data->'state'->'time'->>'end')::bigint-(data->'state'->'time'->>'start')::bigint)
  FROM part WHERE session_id='$SID' AND data->>'tool'='grep'
  ORDER BY time_created DESC LIMIT 1")
echo "T-GTR.1 grep part: $ROW"
STATUS=${ROW%%|*}; MATCHES=$(echo "$ROW" | cut -d'|' -f2); TRUNC=$(echo "$ROW" | cut -d'|' -f3)
[ "$STATUS" = "completed" ] && [ "$MATCHES" = "100" ] && [ "$TRUNC" = "true" ] \
  && pass "T-GTR.1" || fail "T-GTR.1" "$ROW"

# ============================================================
# T-GTR.2 大目录宽匹配性能（核心耗时断言）
# ============================================================
# 造 500 文件 × 100 行 = 5 万匹配，修复前需全量扫描+回传
SID2=$(new_sid -kb)
curl -s --noproxy '*' -m 120 -X POST "$BASE/session/$SID2/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/gtr-wide && for f in $(seq 1 500); do for l in $(seq 1 100); do echo \"import wide-$f-$l\" >> /workspace/gtr-wide/f$f.ts; done; done && echo done"}' > /dev/null

curl -s --noproxy '*' --max-time 180 -X POST "$BASE/session/$SID2/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 grep 工具在 /workspace/gtr-wide 目录搜索 pattern import（会超过 100 条），只报告 grep 是否完成及耗时感受\"}],\"model\":$MODEL}" \
  > /dev/null

ROW2=$(pgval "SELECT data->'state'->>'status' || '|' ||
  coalesce(data->'state'->'metadata'->>'truncated','-') || '|' ||
  coalesce(data->'state'->>'error','') || '|' ||
  ((data->'state'->'time'->>'end')::bigint-(data->'state'->'time'->>'start')::bigint)
  FROM part WHERE session_id='$SID2' AND data->>'tool'='grep'
  ORDER BY time_created DESC LIMIT 1")
echo "T-GTR.2 grep part: $ROW2"
STATUS2=${ROW2%%|*}; TRUNC2=$(echo "$ROW2" | cut -d'|' -f2); DUR2=$(echo "$ROW2" | cut -d'|' -f4)
# 5 万匹配截断到 101 条即停；修复前该形态 p90 12s+。阈值 10s，留余量
[ "$STATUS2" = "completed" ] && [ "$TRUNC2" = "true" ] && [ "$DUR2" -lt 10000 ] \
  && pass "T-GTR.2" "${DUR2}ms（截断形态两周基线 p90 12.4s）" \
  || fail "T-GTR.2" "$ROW2"

# ============================================================
# T-GTR.3 窄匹配无回归（独立目录 + 唯一串，避免模型简化 pattern）
# ============================================================
SID3=$(new_sid -kb)
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID3/exec" -H 'Content-Type: application/json' \
  -d '{"command":"mkdir -p /workspace/gtr-narrow && echo common-line >> /workspace/gtr-narrow/a.txt && echo common-line >> /workspace/gtr-narrow/b.txt && echo zqx-unique-7f3k9 >> /workspace/gtr-narrow/c.txt"}' > /dev/null

curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID3/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 grep 工具在 /workspace/gtr-narrow 目录搜索 pattern zqx-unique-7f3k9（必须逐字符使用这个 pattern，不要修改），报告匹配到的内容\"}],\"model\":$MODEL}" \
  > /dev/null

ROW3=$(pgval "SELECT data->'state'->>'status' || '|' ||
  coalesce(data->'state'->'metadata'->>'matches','-') || '|' ||
  coalesce(data->'state'->'metadata'->>'truncated','-')
  FROM part WHERE session_id='$SID3' AND data->>'tool'='grep'
  ORDER BY time_created DESC LIMIT 1")
echo "T-GTR.3 grep part: $ROW3"
STATUS3=${ROW3%%|*}; MATCHES3=$(echo "$ROW3" | cut -d'|' -f2); TRUNC3=$(echo "$ROW3" | cut -d'|' -f3)
[ "$STATUS3" = "completed" ] && [ "$MATCHES3" = "1" ] && [ "$TRUNC3" = "false" ] \
  && pass "T-GTR.3" || fail "T-GTR.3" "$ROW3"

summary
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-GTR.1 | 300 匹配 → `matches=100`、`truncated=true`、completed（截断语义不变） |
| T-GTR.2 | 5 万匹配宽匹配 completed、`truncated=true`、耗时 <10s（修复前同形态 p90 12.4s，且随匹配数线性恶化） |
| T-GTR.3 | 唯一匹配 → `matches=1`、`truncated=false`（窄匹配无回归） |

> 注：T-GTR.2 的 10s 阈值含远端沙箱调度余量；管道截断生效时 rg 扫描在 101 条后即停，耗时主要取决于沙箱启动/命令往返（~200ms 量级）。若失败先查沙箱创建是否占了主要耗时（exec_log 中 createSandbox 记录）。

## 复测记录

| 日期 | 镜像 tag | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-GTR.1 | ✅ PASS | 300 匹配 → 100|true，145ms |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-GTR.2 | ✅ PASS | 5 万匹配 89ms completed（原形态 p90 12.4s） |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-GTR.3 | ✅ PASS | 首跑模型自行简化 pattern 致误判，改独立目录+唯一串后 1|false；工具行为始终正确 |
| 2026-08-19 | `perf-rft`（组合 2：本地 PG + 远端沙箱，LSP 修复已撤销） | T-GTR.1 | ✅ PASS | 300 匹配 → 100|true，142ms |
| 2026-08-19 | `perf-rft`（组合 2） | T-GTR.2 | ✅ PASS | 5 万匹配 186ms completed，truncated=true |
| 2026-08-19 | `perf-rft`（组合 2） | T-GTR.3 | ✅ PASS | 1|false 窄匹配无回归 |
