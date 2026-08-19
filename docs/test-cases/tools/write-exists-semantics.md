# Write 工具 exists 语义修复（空文件误判为新建）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），PG 模式。环境变量 `$BASE $PG_URL $MODEL` 由 `test-env.sh` 提供。

## 背景

对近两周真实 PG 数据与代码的分析发现（2026-08-19）：

- 沙箱 write 分支原以 `const rawOld = await sb.files.readFile(path)` + `exists = !!rawOld` 判定文件是否已存在：
  1. **空文件（内容为 `""`）被误判为新文件**——`metadata.exists=false`、发布 `file.watcher.updated event:"add"` 而非 `"change"`；
  2. readFile 的**网络错误、超时也被吞成"不存在"**——故障被掩盖成正常新建，可能覆盖未知状态文件。

**修复**（`packages/opencode/src/tool/write.ts`）：

- readFile 结果区分三种：成功（含空内容）→ `exists=true`；`SandboxApiException statusCode=404` → `exists=false`；其他错误 → 原样上抛，不写入。

**预期效果**：空文件覆盖时 `exists=true` 且事件为 `change`；传输类故障显式报错而非静默新建。

## 用例

```bash
source docs/test-cases/test-env.sh
source docs/test-cases/test-lib.sh

# ============================================================
# T-WEX.1 覆盖空文件 → exists=true（核心修复）
# ============================================================
SID=$(new_sid -kb)
curl -s --noproxy '*' -m 60 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"touch /workspace/wex-empty.txt"}' > /dev/null

curl -s --noproxy '*' --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 write 工具向 /workspace/wex-empty.txt 写入内容 empty-now-has-content，完成后报告工具的输出\"}],\"model\":$MODEL}" \
  > /dev/null

ROW=$(pgval "SELECT data->'state'->>'status' || '|' ||
  coalesce(data->'state'->'metadata'->>'exists','-') || '|' ||
  ((data->'state'->'time'->>'end')::bigint-(data->'state'->'time'->>'start')::bigint)
  FROM part WHERE session_id='$SID' AND data->>'tool'='write'
  ORDER BY time_created DESC LIMIT 1")
echo "T-WEX.1 write part: $ROW"
STATUS=${ROW%%|*}; EXISTS=$(echo "$ROW" | cut -d'|' -f2)
[ "$STATUS" = "completed" ] && [ "$EXISTS" = "true" ] \
  && pass "T-WEX.1" || fail "T-WEX.1" "$ROW（修复前空文件 exists=false）"

# 沙箱内文件确实写入
CONTENT=$(curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID/exec" -H 'Content-Type: application/json' \
  -d '{"command":"cat /workspace/wex-empty.txt"}' | jexec "d.get('stdout',d if isinstance(d,str) else '')")
echo "$CONTENT" | grep -q "empty-now-has-content" && pass "T-WEX.1b" || fail "T-WEX.1b" "内容未写入: $CONTENT"

# ============================================================
# T-WEX.2 新建与覆盖已有非空文件（回归）
# ============================================================
SID2=$(new_sid -kb)
curl -s --noproxy '*' -m 30 -X POST "$BASE/session/$SID2/exec" -H 'Content-Type: application/json' \
  -d '{"command":"echo old-content > /workspace/wex-existing.txt"}' > /dev/null

curl -s --noproxy '*' --max-time 180 -X POST "$BASE/session/$SID2/message" -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"两次用 write 工具：先创建 /workspace/wex-new.txt 内容 new-file；再把 /workspace/wex-existing.txt 覆盖为 new-content\"}],\"model\":$MODEL}" \
  > /dev/null

ROWS=$(pgval "SELECT data->'state'->'metadata'->>'filepath' || '=' ||
  coalesce(data->'state'->'metadata'->>'exists','-')
  FROM part WHERE session_id='$SID2' AND data->>'tool'='write' AND data->'state'->>'status'='completed'
  ORDER BY time_created")
echo "T-WEX.2 write parts: $ROWS"
echo "$ROWS" | grep -q "wex-new.txt=false" && \
echo "$ROWS" | grep -q "wex-existing.txt=true" \
  && pass "T-WEX.2" || fail "T-WEX.2" "$ROWS"

summary
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-WEX.1 | 覆盖空文件 → `metadata.exists=true`（修复前为 false）、completed |
| T-WEX.1b | 空文件被正确写入目标内容 |
| T-WEX.2 | 新建文件 `exists=false`、覆盖已有非空文件 `exists=true` |

> 注：
> - exists 值来自 write part 的 `metadata.exists`，由服务端基于 readFile/404 判定，与模型行为无关，断言稳定。
> - 传输错误上抛路径（socket 断开时 write 显式失败）依赖故障注入，可参照 `read-fast-timeout.md` 的 kill-sandbox 场景覆盖，不在本篇重复。

## 复测记录

| 日期 | 镜像 tag | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-WEX.1 | ✅ PASS | 空文件覆盖 exists=true |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-WEX.1b | ✅ PASS | 内容写入正确 |
| 2026-08-19 | `7da2f4d43d-perf1` + 沙箱 `opencode-opensandbox:local`（组合 3：本地 PG + 本地 OpenSandbox，daemon 含 500ms 修复） | T-WEX.2 | ✅ PASS | new=false / existing=true |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含格式化同步执行改动） | T-WEX.1 | ✅ PASS | 空文件覆盖 exists=true，1333ms |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含格式化同步执行改动） | T-WEX.1b | ✅ PASS | 内容写入正确 |
| 2026-08-19 | `files-api-test` + 沙箱 `opencode-opensandbox:local`（组合 3，含格式化同步执行改动） | T-WEX.2 | ✅ PASS | new=false / existing=true |
| 2026-08-19 | `perf-rft`（组合 2：本地 PG + 远端沙箱，LSP 修复已撤销） | T-WEX.1 | ✅ PASS | 空文件覆盖 exists=true，1146ms |
| 2026-08-19 | `perf-rft`（组合 2） | T-WEX.1b | ✅ PASS | 内容写入正确 |
| 2026-08-19 | `perf-rft`（组合 2） | T-WEX.2 | ✅ PASS | new=false / existing=true |
