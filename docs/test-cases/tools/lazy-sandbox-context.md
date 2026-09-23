# Lazy sandbox 上下文与 touch 语义（工具自取沙箱 + 单次 touch）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），PG 模式。环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供。

## 背景

本轮性能优化改造了工具调用获取沙箱的方式（`packages/opencode/src/session/tools.ts`、`packages/opencode/src/tool/sandbox-provider.ts`）：

- `Tool.Context.sandbox` 从"构造上下文时立即 `getOrCreate`（预热）"改为 **lazy getter**：首次访问才创建，且本次调用内 memoize。grep/glob/list 等只通过 provider 执行命令的工具不再多一次预取；`resolveTools` 内父子上下文继承改用 `Object.create` 原型链，避免 spread 触发 getter。
- `runInSession` / `runDetached` 移除了入口处重复的 `dbTouchSandbox`（`getOrCreateUnlocked` 命中缓存路径已 touch）。

**风险**：① 部分工具此前隐式依赖上下文预热，lazy 化后需自行获取——遗漏会导致 "Sandbox is not available"；② touch 去重后，`sandbox.time_updated` 刷新语义必须保留，否则 idle-reaper 会误回收活跃沙箱。

## 用例

```bash
source docs/test-cases/test-env.sh
source docs/test-cases/test-lib.sh

# ============================================================
# T-LZY.1 冷会话首条消息用 glob/grep（不经 bash 预热）
# ============================================================
# 不带 -b（不预启动沙箱），沙箱完全由工具内 lazy getOrCreate 创建
SID=$(new_sid -k)
curl -s --noproxy '*' --max-time 240 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 glob 工具在 /workspace 下匹配 *.json（pattern 填 *.json），报告找到的文件名，不要用 bash\"}],\"model\":$MODEL}" \
  > /dev/null

ROW=$(pgval "SELECT data->'state'->>'status' || '|' ||
  coalesce(data->'state'->'metadata'->>'count','-') || '|' ||
  coalesce(left(data->'state'->>'error',80),'')
  FROM part WHERE session_id='$SID' AND data->>'tool'='glob'
  ORDER BY time_created DESC LIMIT 1")
echo "T-LZY.1 glob part: $ROW"
STATUS=${ROW%%|*}; ERR=$(echo "$ROW" | cut -d'|' -f3-)
[ "$STATUS" = "completed" ] && ! echo "$ERR" | grep -qi "not available" \
  && pass "T-LZY.1" || fail "T-LZY.1" "$ROW"

# 沙箱最终建立（lazy 创建生效）
SBX_STATE=$(pgval "SELECT state FROM sandbox WHERE session_id='$SID'")
[ "$SBX_STATE" = "running" ] && pass "T-LZY.1b" || fail "T-LZY.1b" "sandbox state=$SBX_STATE"

# ============================================================
# T-LZY.2 连续 bash 后 sandbox.time_updated 仍在刷新
# ============================================================
SID2=$(new_sid -kb)
# 等沙箱就绪
sleep 5
T0=$(pgval "SELECT time_updated FROM sandbox WHERE session_id='$SID2'")
sleep 2  # 确保 T0 落后于当前时间，给 touch 留出可观测增量
for i in 1 2 3; do
  curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID2/exec" -H 'Content-Type: application/json' \
    -d '{"command":"echo lzy-touch"}' > /dev/null
done
T1=$(pgval "SELECT time_updated FROM sandbox WHERE session_id='$SID2'")
echo "T-LZY.2 time_updated: $T0 -> $T1"
[ -n "$T0" ] && [ -n "$T1" ] && [ "$T1" -gt "$T0" ] \
  && pass "T-LZY.2" "touch 语义保留（增量 $((T1-T0))ms）" \
  || fail "T-LZY.2" "time_updated 未刷新: $T0 -> $T1（idle-reaper 会误回收）"

# ============================================================
# T-LZY.3 混合工具链回归（read/write/bash 同会话）
# ============================================================
curl -s --noproxy '*' --max-time 240 -X POST "$BASE/session/$SID2/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"依次执行：1) bash 执行 echo lzy3 > /workspace/lzy3.txt；2) read 读取 /workspace/lzy3.txt；3) write 覆盖 /workspace/lzy3.txt 为 done。报告每步结果\"}],\"model\":$MODEL}" \
  > /dev/null

STATS=$(pgval "SELECT string_agg(DISTINCT data->'state'->>'status', ',') FROM part
  WHERE session_id='$SID2' AND data->>'type'='tool' AND data->>'tool' IN ('bash','read','write')
    AND time_created > (extract(epoch FROM now())-600)*1000")
echo "T-LZY.3 工具状态聚合: $STATS"
[ "$STATS" = "completed" ] && pass "T-LZY.3" || fail "T-LZY.3" "存在非 completed: $STATS"

summary
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-LZY.1/1b | 冷会话首条 glob 消息 completed、无 "not available"，沙箱最终 running（lazy 创建生效） |
| T-LZY.2 | 3 次 exec 后 `sandbox.time_updated` 严格递增（touch 去重未破坏 idle-reaper 依赖的活跃信号） |
| T-LZY.3 | bash → read → write 混合链路全部 completed |

> 注：T-LZY.2 的观测前提是该实例处理了这几次 exec（多实例共享 PG 时，确保请求打到同一入口）；`time_updated` 为毫秒时间戳。

## 复测记录

| 日期 | 镜像 tag | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-LZY.1 | ✅ PASS | 冷会话首条 glob completed（空目录 count=0 属正常） |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-LZY.1b | ✅ PASS | sandbox running |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-LZY.2 | ✅ PASS | time_updated 递增 |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-LZY.3 | ✅ PASS | bash→read→write 全 completed |
| 2026-08-19 | `perf-rft`（组合 2：本地 PG + 远端沙箱，LSP 修复已撤销） | T-LZY.1/1b | ✅ PASS | 冷会话首条 glob completed，sandbox running |
| 2026-08-19 | `perf-rft`（组合 2） | T-LZY.2 | ✅ PASS | time_updated 递增（增量 7343ms） |
| 2026-08-19 | `perf-rft`（组合 2） | T-LZY.3 | ✅ PASS | bash→read→write 全 completed |
