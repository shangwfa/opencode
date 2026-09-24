# Read 非超时错误不销毁沙箱（错误分类修复）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），PG 模式。环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供。

## 背景

read 快速超时改造（`docs/test-cases/tools/read-fast-timeout.md`）最初的兜底实现中，`readTextPage` 失败统一走"重试 + destroy 沙箱 + 报 Read timed out"。这会把**用户输入类错误**（offset 越界、二进制内容、非 UTF-8）误当成沙箱故障：

- 销毁整个沙箱（工作区状态丢失、后续命令需等重建）
- 错误信息被伪装成 `Read timed out`，误导 agent 和排障

**修复**（`packages/opencode/src/tool/read.ts`）：超时改用 tagged error `SandboxReadTimeout`，仅该错误参与重试与 destroy；offset 越界/二进制/UTF-8 等错误原样传播，沙箱不受影响。附带优化：文件 ≤64KB 时直接复用 header 读取结果做文本分页，省去第二次 `readBytesStream` 往返。

## 用例

```bash
source docs/test-cases/test-env.sh
source docs/test-cases/test-lib.sh

# ============================================================
# T-RDX.1 offset 越界报原始错误，沙箱不销毁不重建
# ============================================================
SID=$(new_sid -kb)
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"printf \"line1\\nline2\\nline3\\n\" > /workspace/rdx.txt"}' > /dev/null

SBX_ID_BEFORE=$(pgval "SELECT id FROM sandbox WHERE session_id='$SID'")

# 引导 agent 用 read 带 offset=99999（越界）
curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 read 工具读取 /workspace/rdx.txt，必须带参数 offset=99999 和 limit=10，报告结果\"}],\"model\":$MODEL}" \
  > /dev/null

ROW=$(pgval "SELECT data->'state'->>'status' || '|' ||
  coalesce(left(data->'state'->>'error',100),'')
  FROM part WHERE session_id='$SID' AND data->>'tool'='read'
  ORDER BY time_created DESC LIMIT 1")
echo "T-RDX.1 read part: $ROW"
STATUS=${ROW%%|*}; ERR=$(echo "$ROW" | cut -d'|' -f2-)
# 模型若未传 offset 导致 read 成功，标记 SKIP 提示复测
if [ "$STATUS" = "completed" ] && [ -z "$ERR" ]; then
  echo "⚠ T-RDX.1 模型未按引导传 offset，SKIP（建议复测）"
else
  echo "$ERR" | grep -qi "out of range" && ! echo "$ERR" | grep -qi "timed out" \
    && pass "T-RDX.1" "错误分类正确" || fail "T-RDX.1" "$ROW（应报 out of range 而非 timed out）"
fi

# 沙箱未销毁重建：id 未变 + 后续 bash 毫秒级（若被销毁需等重建 10s+）
SBX_ID_AFTER=$(pgval "SELECT id FROM sandbox WHERE session_id='$SID'")
BASH_ROW=$(curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo rdx-alive"}')
echo "T-RDX.1b sandbox id: $SBX_ID_BEFORE -> $SBX_ID_AFTER"
[ -n "$SBX_ID_BEFORE" ] && [ "$SBX_ID_BEFORE" = "$SBX_ID_AFTER" ] \
  && pass "T-RDX.1b" "沙箱未重建" || fail "T-RDX.1b" "沙箱被销毁重建: $SBX_ID_BEFORE -> $SBX_ID_AFTER"
echo "$BASH_ROW" | grep -q "rdx-alive" && pass "T-RDX.1c" || fail "T-RDX.1c" "exec 未恢复: $BASH_ROW"

# ============================================================
# T-RDX.2 小文件读取内容完整（header 单飞路径回归）
# ============================================================
SID2=$(new_sid -kb)
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID2/exec" -H 'Content-Type: application/json' \
  -d '{"command":"printf \"alpha\\nbeta\\ngamma\\n\" > /workspace/rdx-small.txt"}' > /dev/null

curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID2/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 read 工具读取 /workspace/rdx-small.txt（不要传 offset/limit），原样告诉我每一行内容\"}],\"model\":$MODEL}" \
  > /dev/null

ROW2=$(pgval "SELECT data->'state'->>'status' || '|' ||
  ((data->'state'->'time'->>'end')::bigint-(data->'state'->'time'->>'start')::bigint)
  FROM part WHERE session_id='$SID2' AND data->>'tool'='read'
  ORDER BY time_created DESC LIMIT 1")
# text part 无 role 字段（role 在 message 级），关联 message 表取 assistant 文本
ASSIST=$(pgval "SELECT left(p.data->>'text',400) FROM part p
  JOIN message m ON m.id = p.message_id
  WHERE p.session_id='$SID2' AND p.data->>'type'='text' AND m.data->>'role'='assistant'
  ORDER BY p.time_created ASC LIMIT 1")
echo "T-RDX.2 read part: $ROW2, 回复: ${ASSIST:0:120}"
STATUS2=${ROW2%%|*}; DUR2=$(echo "$ROW2" | cut -d'|' -f2)
echo "$ASSIST" | grep -q "alpha" && echo "$ASSIST" | grep -q "gamma" && [ "$STATUS2" = "completed" ] && [ "$DUR2" -lt 15000 ] \
  && pass "T-RDX.2" || fail "T-RDX.2" "status=$STATUS2 dur=${DUR2}ms 回复缺内容"

summary
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-RDX.1 | read 报 `Offset ... out of range`（原始错误），**不含** `timed out`；模型未传 offset 时 SKIP |
| T-RDX.1b/1c | 错误后 `sandbox.id` 不变、exec 立即恢复——沙箱未被销毁 |
| T-RDX.2 | 小文件（<64KB）read completed、内容完整、<15s（header 单飞路径回归） |

> 注：T-RDX.1 依赖模型按引导传 `offset=99999`，配合度不稳定，故设计为"成功即 SKIP、报错则必须正确分类"的不对称断言；复测多次争取命中越界路径。

## 复测记录

| 日期 | 镜像 tag | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-RDX.1 | ✅ PASS | 报 Offset 99999 is out of range，无 timed out |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-RDX.1b/1c | ✅ PASS | sandbox id 未变，exec 立即恢复 |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-RDX.2 | ✅ PASS | 66ms completed，内容完整；用例 SQL 初版误用 part.role（不存在），修正为 JOIN message 取 assistant 文本 |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含 header 单飞改动） | T-RDX.1 | ✅ PASS | 报 Offset 99999 is out of range (3 lines)，无 timed out |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含 header 单飞改动） | T-RDX.1b/1c | ✅ PASS | sandbox id 未变，exec 立即恢复 |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含 header 单飞改动） | T-RDX.2 | ✅ PASS | 60ms completed，内容完整（header 单飞路径回归） |
| 2026-08-19 | `perf-rft`（组合 2：本地 PG + 远端沙箱，LSP 修复已撤销） | T-RDX.1 | ✅ PASS | 报 Offset 99999 is out of range (3 lines)，无 timed out |
| 2026-08-19 | `perf-rft`（组合 2） | T-RDX.1b/1c | ✅ PASS | sandbox id 未变，exec 立即恢复 |
| 2026-08-19 | `perf-rft`（组合 2） | T-RDX.2 | ✅ PASS | 48ms completed，内容完整 |

### V2 全量回归（2026-09-24）

**环境**：容器 `opencode-saas-test`（`127.0.0.1:14096`，镜像 `opencode-saas-sandbox-test:9aa68014be-rg-guard`），本地 PG `opencode-v2-up`（V2 架构 `session_v2`/`session_message`），sandbox 镜像 `opencode-opensandbox:local`，模型 `Yd-DeepSeek/deepseek-v4-flash`。

**V1→V2 接口映射**（同 read-fast-timeout.md）：`exec` → `POST /api/session/:id/shell`（注意：shell 端点产出独立 `type='shell'` 消息，`data.time.completed` 标记完成，**不进** assistant content[]——轮询必须查 `type='shell'`）；`message` → `prompt`+`wait`；PG `part` → `session_message.content[]`；assistant 文本取 `type='assistant'` 消息 content 的最后一条 text（V2 模型可能拆多条消息，取首条会漏掉正文）。

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-09-24 | T-RDX.1 | ⚠ SKIP×4 | 模型（deepseek-v4-flash）四次均未按引导传 `offset=99999`，read 成功（文档预设的不对称断言分支）。**错误分类本身有单测兜底**：`tool-read-filesystem.test.ts` 断言 `Offset 2 is out of range` 原文传播、`tool-read.test.ts` 断言 `OffsetOutOfRangeError` 不被包装 |
| 2026-09-24 | T-RDX.1b | ✅ PASS×3 | 越界引导未命中期间 read 均正常，sandbox id 三次全程未变（无销毁重建） |
| 2026-09-24 | T-RDX.1c | ✅ PASS×2（修正后） | shell 端点立即恢复。首跑 FAIL 系用例脚本轮询误查 assistant content[] 所致（shell 消息在 `type='shell'`），修正后通过 |
| 2026-09-24 | T-RDX.2 | ✅ PASS×2（修正后） | read completed 194~485ms，内容完整（alpha/beta/gamma）。首跑 FAIL 系断言取首条 assistant text（模型拆多条消息时为"I'll read the file."），改取最后一条后通过 |

**结论**：`PASS=3 FAIL=0`（T-RDX.1 按预设 SKIP）。V2 的 read 路径全程无 destroy 调用（沙箱销毁自愈是 V1 的 `SandboxReadTimeout` 分支，V2 不存在），错误分类与"不销毁"语义天然满足；offset 越界分类由单测精确断言。待换配合度高的模型时可复测 T-RDX.1 主断言。

