# 沙箱创建后台化与销毁竞态（creationScope + destroyById Deferred）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），PG 模式。环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供。本篇用例需远端沙箱（K8s），创建耗时真实（非本地 stub）。

## 背景

`packages/opencode/src/tool/sandbox-provider.ts` 的两项改动（PG 层，单测无法覆盖）：

1. **创建后台化**：`getOrCreateUnlocked` 的创建主体 fork 到 layer 级 `creationScope`。等待方 90s 超时放弃后，创建在后台继续完成并写入缓存/sbCache——重试请求通过 `createRef`/Deferred 或缓存命中在建沙箱，而不是从零再建一个。
2. **destroyById 补 Deferred fail**：`idle-reaper`/zombie 清理（`destroyById`）在创建进行中移除 `createRef` 条目时，此前未 fail 对应 Deferred，等待方会一直挂到 90s 超时；现在立即 `Deferred.fail`，等待方快速失败并可立刻发起重试。

**风险**：创建期销毁竞态可能导致等待方长挂（90s）或重复建沙箱。

## 用例

```bash
source docs/test-cases/test-env.sh
source docs/test-cases/test-lib.sh

# ============================================================
# T-SBG.1 并发首消息去重（两条消息共享一次创建）
# ============================================================
SID=$(new_sid -k)
# 两条消息几乎同时到达，沙箱创建中都会经过 createRef/Deferred
curl -s --noproxy '*' --max-time 300 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 echo sbg1，报告输出\"}],\"model\":$MODEL}" > /tmp/sbg1.json &
PID1=$!
sleep 1
curl -s --noproxy '*' --max-time 300 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 echo sbg2，报告输出\"}],\"model\":$MODEL}" > /tmp/sbg2.json &
PID2=$!
wait $PID1 $PID2

BOTH=$(pgval "SELECT count(*) FROM part WHERE session_id='$SID' AND data->>'tool'='bash' AND data->'state'->>'status'='completed'")
SBX=$(pgval "SELECT state FROM sandbox WHERE session_id='$SID'")
echo "T-SBG.1 并发 bash completed=$BOTH sandbox=$SBX"
[ "$BOTH" = "2" ] && [ "$SBX" = "running" ] \
  && pass "T-SBG.1" || fail "T-SBG.1" "completed=$BOTH sandbox=$SBX"

# ============================================================
# T-SBG.2 创建窗口内 kill-sandbox：等待方快速失败/恢复，不挂 90s
# ============================================================
SID2=$(new_sid -k)
# 立即发消息触发创建，随即 kill（命中创建进行中的窗口）
curl -s --noproxy '*' --max-time 300 -X POST "$BASE/session/$SID2/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 pwd，报告输出\"}],\"model\":$MODEL}" > /tmp/sbg3.json &
PID3=$!
sleep 2
curl -s --noproxy '*' -m 10 -X POST "$BASE/session/$SID2/kill-sandbox" > /dev/null
wait $PID3
START=$(date +%s)
# kill 后立刻再发一条：等待方应快速失败（Deferred.fail）或经重建快速成功，不允许挂 90s
curl -s --noproxy '*' --max-time 300 -X POST "$BASE/session/$SID2/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 echo sbg-recovered，报告输出\"}],\"model\":$MODEL}" > /dev/null
DUR=$(( $(date +%s) - START ))

FINAL=$(pgval "SELECT string_agg(DISTINCT data->'state'->>'status', ',') FROM part
  WHERE session_id='$SID2' AND data->>'tool'='bash'")
echo "T-SBG.2 消息2 耗时 ${DUR}s, bash 状态聚合: $FINAL"
# 允许快速失败后模型重试成功，也允许直接重建成功；核心是不挂死
[ "$DUR" -lt 100 ] && echo "$FINAL" | grep -q "completed" \
  && pass "T-SBG.2" "${DUR}s 内恢复" || fail "T-SBG.2" "dur=${DUR}s statuses=$FINAL（疑似 90s 挂死）"

# ============================================================
# T-SBG.3 正常会话全链路回归
# ============================================================
SID3=$(new_sid -kb)
sleep 5
curl -s --noproxy '*' --max-time 180 -X POST "$BASE/session/$SID3/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"依次：bash 执行 echo ok > /workspace/sbg.txt；read 读它；报告结果\"}],\"model\":$MODEL}" \
  > /dev/null
OKS=$(pgval "SELECT count(*) FROM part WHERE session_id='$SID3' AND data->>'type'='tool'
  AND data->'state'->>'status'='completed'")
echo "T-SBG.3 completed 工具数: $OKS"
[ "$OKS" -ge 2 ] && pass "T-SBG.3" || fail "T-SBG.3" "completed=$OKS"

summary
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-SBG.1 | 同 session 并发两条消息，bash 均 completed、沙箱单实例 running（共享创建，无重复建箱） |
| T-SBG.2 | 创建窗口 kill 后，下一条消息 <100s 内完成（含模型重试/重建），无 90s 长挂形态 |
| T-SBG.3 | 正常会话 bash+read 全链路 completed |

> 注：
> - T-SBG.2 的 `sleep 2` 试图命中"创建进行中"窗口；远端 K8s 创建通常 5~30s，命中率较高。若 kill 落在创建完成后，则退化为 kill-sandbox 常规恢复路径（由 T-LRCV.1 覆盖），建议复测多次。
> - 90s 挂死形态的判定依据：消息总耗时 ≈ 90s+ 且工具 part 无终态；`waitForSessionLock` 本身无超时，勿与工具执行混淆。

## 复测记录

| 日期 | 镜像 tag | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-SBG.1 | ✅ PASS | 并发两消息 bash 均 completed |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-SBG.2 | ✅ PASS | 创建窗口 kill 后 5s 恢复 |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-SBG.3 | ✅ PASS | bash+read 2 工具 completed |
| 2026-08-19 | `perf-rft`（组合 2：本地 PG + 远端沙箱，K8s 真实创建耗时，LSP 修复已撤销） | T-SBG.1 | ✅ PASS | 并发两消息 bash 均 completed，sandbox 单实例 running |
| 2026-08-19 | `perf-rft`（组合 2） | T-SBG.2 | ✅ PASS | 创建窗口 kill 后 3s 恢复，无 90s 挂死 |
| 2026-08-19 | `perf-rft`（组合 2） | T-SBG.3 | ✅ PASS | bash+read 2 工具 completed |
