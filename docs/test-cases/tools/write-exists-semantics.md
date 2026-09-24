# Write 工具 exists/existed 语义（空文件不得误判为新建）

> **2026-09-24 重写为 V2 API 版本**。原 V1 用例基于 `/session`、`/session/:id/exec`、`/session/:id/message` 与 `part` 表 `metadata.exists`，V2 已不提供这些接口/字段；本文全部映射到 V2：
> - 创建会话：`POST /api/session`（带 `model` / `location` / `permissions`）
> - 预置文件：`POST /api/session/:sessionID/shell`（成功 HTTP 204，结果经消息读取）
> - 触发 AI：`POST /api/session/:sessionID/prompt` + `POST /api/experimental/session/:sessionID/wait`
> - PG 断言：`session_message` 表 `data->content[]` 中 `type=tool`、`name=write` 的 part
>
> 公共环境见 [`docs/local-test-env.md`](../../local-test-env.md)：服务 `http://localhost:14096`（容器 `opencode-saas-test`）、本地 PG `opencode-v2-up`、本地 OpenSandbox `:8080`。服务需设置 `OPENCODE_PASSWORD`，全部请求带 Basic Auth。

## 背景

对近两周真实 PG 数据与代码的分析发现（2026-08-19，V1 时代）：

- 沙箱 write 分支原以 `const rawOld = await sb.files.readFile(path)` + `exists = !!rawOld` 判定文件是否已存在：
  1. **空文件（内容为 `""`）被误判为新文件**——`metadata.exists=false`、发布 `file.watcher.updated event:"add"` 而非 `"change"`；
  2. readFile 的**网络错误、超时也被吞成"不存在"**——故障被掩盖成正常新建，可能覆盖未知状态文件。

**V1 修复**（`packages/opencode/src/tool/write.ts`，历史）：readFile 结果区分三种：成功（含空内容）→ `exists=true`；`SandboxApiException statusCode=404` → `exists=false`；其他错误 → 原样上抛，不写入。

## V2 语义对照

V2 的 write 位于 `packages/core/src/tool/plugin/write.ts`，沙箱实现委托 `SandboxTools.write`（`packages/core/src/sandbox/tools.ts`）：

| V1 | V2 | 说明 |
|---|---|---|
| `metadata.exists`（part metadata 落盘） | `state.metadata.existed`（`Schema.Boolean`，2026-09-24 起随 write 一起落盘） | `packages/core/src/tool/plugin/write.ts` 在 execute 返回 `metadata: { existed }`，Session runner 的 output bounding 会 merge `truncated`，最终 part 为 `metadata: { existed, truncated }`。断言直接读该字段 |
| 模型文本（辅助） | "Wrote/Created file successfully" | `toModelContent` 按 `existed` 生成：`true` → **Wrote**、`false` → **Created**。可与 metadata 字段交叉校验 |
| `readFile` 内容判定 `!!rawOld` | `fileStat` 元数据判定 `stat !== null` | 空文件 stat 非 null → `existed=true`，**空文件误判在 V2 天然规避** |
| 404 → 不存在；其他错误上抛 | `isNotFound(cause)` → 返回 null；其他错误 → `Error` 上抛（`SandboxProvider.fileStat`） | 传输类故障显式报错而非静默新建，语义保持 |

## 用例（V2）

```bash
BASE=http://localhost:14096
PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'
PW="${OPENCODE_PASSWORD:-pg-e2e-test-password}"
AUTH="$(printf 'opencode:%s' "$PW" | base64)"
H=(-H "Authorization: Basic $AUTH" -H 'Content-Type: application/json')
MODEL='{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}'
PERMS='[{"action":"shell","resource":"*","effect":"allow"},{"action":"edit","resource":"*","effect":"allow"}]'

PASS=0; FAIL=0
pass(){ echo "✅ $1 PASS"; PASS=$((PASS+1)); }
fail(){ echo "❌ $1 FAIL: ${2:-}"; FAIL=$((FAIL+1)); }

new_sid(){ curl -s "${H[@]}" -X POST "$BASE/api/session" -d "{\"title\":\"$1\",\"model\":$MODEL,\"location\":{\"directory\":\"/workspace\"},\"permissions\":$PERMS}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])'; }
shell(){ curl -s -o /dev/null -m 90 "${H[@]}" -X POST "$BASE/api/session/$1/shell" -d "$(CMD="$2" python3 -c 'import json,os;print(json.dumps({"command":os.environ["CMD"]}))')"; }
keepalive(){ curl -s -o /dev/null -m 60 "${H[@]}" -X POST "$BASE/api/experimental/session/$1/keep-alive" -d '{"enabled":true,"boot":true}'; }
prompt(){ curl -s -o /dev/null --max-time 600 "${H[@]}" -X POST "$BASE/api/session/$1/prompt" -d "$(MSG="$2" python3 -c 'import json,os;print(json.dumps({"text":os.environ["MSG"],"resume":True}))')"; }
wait_idle(){ curl -s -o /dev/null --max-time 300 "${H[@]}" -X POST "$BASE/api/experimental/session/$1/wait"; }
# write tool parts: "status<TAB>metadata.existed<TAB>content文本<TAB>input.path"（按创建时间）
writes(){ psql "$PG_URL" -t -A -F'	' -c "
  SELECT p->'state'->>'status', p->'state'->'metadata'->>'existed', coalesce(p->'state'->'content'->0->>'text','-'), p->'state'->'input'->>'path'
  FROM session_message m, jsonb_array_elements(m.data::jsonb->'content') p
  WHERE m.session_id='$1' AND p->>'type'='tool' AND p->>'name'='write'
  ORDER BY (p->'time'->>'created')::bigint"; }
shellout(){ curl -s "${H[@]}" "$BASE/api/session/$1/message?order=asc" | python3 -c '
import json,sys
d=json.load(sys.stdin); sh=[m for m in d.get("data",[]) if m.get("type")=="shell"]
print("NONE" if not sh else "%s\t%s"%(sh[-1].get("exit"),(sh[-1].get("output") or {}).get("output","")))'; }

# ============================================================
# T-WEX.1 覆盖空文件 → existed=true（核心语义，V2 由 fileStat 保证）
# ============================================================
SID=$(new_sid "T-WEX.1"); keepalive "$SID"; sleep 2
shell "$SID" "touch /workspace/wex-empty.txt"

prompt "$SID" "用 write 工具向 /workspace/wex-empty.txt 写入内容 empty-now-has-content，完成后报告工具的输出"
wait_idle "$SID"

ROWS=$(writes "$SID"); echo "T-WEX.1 write parts: $ROWS"
# 期望：completed + metadata.existed=true（修复前/误判时为 false；文案 Wrote 为交叉校验）
echo "$ROWS" | grep -q $'completed\ttrue\tWrote file successfully[^\t]*\t/workspace/wex-empty.txt' \
  && pass "T-WEX.1" || fail "T-WEX.1" "$ROWS"

# ------------------------------------------------------------
# T-WEX.1b 沙箱内文件确实写入
# ------------------------------------------------------------
shell "$SID" "cat /workspace/wex-empty.txt"; sleep 2
CONTENT=$(shellout "$SID" | cut -f2)
echo "$CONTENT" | grep -q "empty-now-has-content" && pass "T-WEX.1b" || fail "T-WEX.1b" "内容未写入: $CONTENT"

# ============================================================
# T-WEX.2 新建与覆盖已有非空文件（回归）
# ============================================================
SID2=$(new_sid "T-WEX.2"); keepalive "$SID2"; sleep 2
shell "$SID2" "echo old-content > /workspace/wex-existing.txt"

prompt "$SID2" "两次用 write 工具：先创建 /workspace/wex-new.txt 内容 new-file；再把 /workspace/wex-existing.txt 覆盖为 new-content"
wait_idle "$SID2"

ROWS2=$(writes "$SID2"); echo "T-WEX.2 write parts: $ROWS2"
echo "$ROWS2" | grep -q $'completed\tfalse\tCreated file successfully[^\t]*\t/workspace/wex-new.txt' && \
echo "$ROWS2" | grep -q $'completed\ttrue\tWrote file successfully[^\t]*\t/workspace/wex-existing.txt' \
  && pass "T-WEX.2" || fail "T-WEX.2" "$ROWS2"

echo ""; echo "===== 结果: PASS=$PASS FAIL=$FAIL ====="
```

## 期望汇总

| 用例 | 期望 |
|---|---|
| T-WEX.1 | 覆盖空文件 → write part `completed` + `metadata.existed=true`（文案 "Wrote file successfully" 交叉校验） |
| T-WEX.1b | 空文件被正确写入目标内容 |
| T-WEX.2 | 新建文件 `metadata.existed=false`（"Created file successfully"）、覆盖已有非空文件 `metadata.existed=true`（"Wrote file successfully"） |

> 注：
> - `existed` 由 `fileStat`（元数据）判定并落盘 tool part `state.metadata`，与模型行为无关，断言稳定；空文件不再依赖 readFile 内容。
> - 传输错误上抛路径（`fileStat`/`fileRead` 非 404 显式失败）依赖故障注入，可参照 `read-fast-timeout.md` 的 kill-sandbox 场景覆盖，不在本篇重复。

## 复测记录

| 日期 | 镜像 | 用例 | 结果 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | `7da2f4d43d-perf1`（V1） | T-WEX.1/1b/2 | ✅×3 | V1 修复验证 |
| 2026-09-06 | merge v1.18.29 后（V1） | T-WEX.1 | ✅ PASS | exec 预置空文件 → `completed\|exists=true` |
| 2026-09-24 | `opencode-saas-sandbox-test:slim`（V2，本地 PG `opencode-v2-up` + 本地 OpenSandbox） | T-WEX.1 | ✅ PASS | `completed` + `Wrote file successfully: wex-empty.txt` |
| 2026-09-24 | 同上 | T-WEX.1b | ✅ PASS | 回读 `empty-now-has-content` 一致 |
| 2026-09-24 | 同上 | T-WEX.2 | ✅ PASS | new → Created(false) / existing → Wrote(true)；过程核验：write 工具直达，无 bash 绕过 |
| 2026-09-24 | `slim-dist`（含 `metadata.existed` 落盘修复，独立容器 @14099） | T-WEX.1 | ✅ PASS | `metadata.existed=true` + Wrote |
| 2026-09-24 | 同上 | T-WEX.1b | ✅ PASS | 内容一致 |
| 2026-09-24 | 同上 | T-WEX.2 | ✅ PASS | `existed=false/true` 与文案一致 |

## 清理

```bash
curl -s -H "Authorization: Basic $AUTH" "$BASE/api/session" | python3 -c '
import json,sys
for s in json.load(sys.stdin).get("data",[]):
    if s.get("title","").startswith("T-WEX"): print(s["id"])' | \
  while read id; do curl -s -o /dev/null -X DELETE "$BASE/api/session/$id" -H "Authorization: Basic $AUTH"; done
```
