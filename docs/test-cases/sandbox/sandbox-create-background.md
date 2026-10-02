# V2 沙箱并发创建与销毁生命周期验收

> 本文针对当前 `packages/core/src/sandbox/provider.ts`。环境按 [`local-test-env.md`](../../local-test-env.md) 启动 SaaS + PG + OpenSandbox。接口 `$BASE` 包含 `/api` 前缀；准备 `$PG_URL`、`$OPENCODE_PASSWORD`。

## 当前语义与覆盖边界

- 单个 SaaS 进程内，`getOrCreate` 以 session ID 合并并发创建请求；这不是多副本分布式锁。
- 创建超时/调用中断会标记为 abandoned；若 OpenSandbox 随后才返回创建结果，Provider 会尝试销毁该实例。
- `kill-sandbox` 只在 `sandboxId` 已可查询时调用 `destroy`。创建尚未完成时返回 `destroyed:false`，不会取消远端创建，也不会唤醒创建等待者。
- `destroy` 更新 sandbox 行状态为 `destroyed`，不清除 `keep_alive` 意愿。`release` 则先关闭保活，再销毁。
- **已发现的产品语义缺口**：若需求是“创建中 kill 必须取消创建/快速结束等待者”，当前实现不满足。本文按现有契约验收，不把竞态无操作误判为取消成功。
- PG 模式下查询 `sandbox` 表；本地非 PG 模式才使用 SQLite。

## 准备

```bash
export BASE=http://127.0.0.1:14101/api
export PG_URL='postgresql://local@127.0.0.1:5432/opencode-v2-up'
export OPENCODE_PASSWORD='填写本地服务密码'
AUTH="$(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64)"
H=(-H "Authorization: Basic $AUTH" -H 'Content-Type: application/json')
pgval() { psql "$PG_URL" -X -A -t -v ON_ERROR_STOP=1 -c "$1" | tr -d '[:space:]'; }
cleanup() {
  for id in "${SID3:-}" "${SID2:-}" "${SID:-}"; do
    [ -n "$id" ] || continue
    curl -sS "${H[@]}" -X POST "$BASE/api/experimental/session/$id/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}' >/dev/null || true
    curl -sS "${H[@]}" -X DELETE "$BASE/api/session/$id" >/dev/null || true
  done
}
trap cleanup EXIT
```

确认 SaaS 使用 PG、`OPENCODE_SANDBOX_ENABLED=1`、OpenSandbox 可达。建议在隔离测试环境操作；命令会创建并销毁远端 sandbox。shell API 返回前会等待命令终态。

## T-SBG.1：同 session 并发首执行

```bash
SID=$(curl -fsS "${H[@]}" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
curl -fsS "${H[@]}" -X POST "$BASE/api/experimental/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}'

curl -sS -o /tmp/sbg-a.json -w '%{http_code}\n' "${H[@]}" -X POST "$BASE/api/session/$SID/shell" \
  -H 'Content-Type: application/json' -d '{"id":"msg_sbg_a","command":"echo sbg-a"}' & A=$!
curl -sS -o /tmp/sbg-b.json -w '%{http_code}\n' "${H[@]}" -X POST "$BASE/api/session/$SID/shell" \
  -H 'Content-Type: application/json' -d '{"id":"msg_sbg_b","command":"echo sbg-b"}' & B=$!
wait "$A"; wait "$B"

curl -fsS "${H[@]}" "$BASE/api/session/$SID/sandbox" > /tmp/sbg-sandbox.json
curl -fsS "${H[@]}" "$BASE/api/session/$SID/message?order=asc" > /tmp/sbg-messages.json
python3 - <<'PY'
import json
messages = json.load(open('/tmp/sbg-messages.json'))['data']
expected = {'echo sbg-a', 'echo sbg-b'}
shells = [m for m in messages if m.get('type') == 'shell' and m.get('command') in expected]
assert len(shells) == 2, shells
assert all(m.get('status') == 'exited' and m.get('exit') == 0 for m in shells), shells
sandbox = json.load(open('/tmp/sbg-sandbox.json'))
assert sandbox.get('sandboxId'), sandbox
print('shells:', [(m['command'], m['status'], m.get('exit')) for m in shells])
print('sandboxId:', sandbox['sandboxId'])
PY
psql "$PG_URL" -X -c "SELECT session_id, id, state, keep_alive FROM sandbox WHERE session_id='$SID'"
test "$(pgval "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND state='running' AND keep_alive=1")" = 1
```

**通过条件**：两次 HTTP 状态均为 204；两个 shell message 均 `exited/0`；sandbox API 返回 ID；PG 恰有一条该 session 的 `running/keep_alive=true` 行。另在服务日志中按 session ID 确认只有一次 `sandbox creating` 和 `sandbox created`。PG 唯一行会被后创建覆盖，单看 PG 无法发现重复创建/远端实例泄漏；该用例只证明单进程并发，不覆盖多 SaaS 副本。

## T-SBG.2：创建中 kill 的真实语义、创建后销毁与重建

等待 Provider 明确记录 `sandbox creating` 后再调用 kill，避免用固定 sleep 猜测是否处于创建窗口。请确保日志未轮转，且 SaaS 容器名为 `opencode-saas-test`。

```bash
SID2=$(curl -fsS "${H[@]}" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
curl -fsS "${H[@]}" -X POST "$BASE/api/session/$SID2/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}'
rm -f /tmp/sbg-creating.log
docker logs -f opencode-saas-test 2>&1 | grep --line-buffered "$SID2.*sandbox creating" > /tmp/sbg-creating.log & LOG_PID=$!
curl -sS -o /tmp/sbg-first.json -w '%{http_code}\n' "${H[@]}" -X POST "$BASE/api/session/$SID2/shell" \
  -H 'Content-Type: application/json' -d '{"id":"msg_sbg_first","command":"pwd"}' & FIRST=$!
for i in $(seq 1 120); do [ -s /tmp/sbg-creating.log ] && break; sleep 0.25; done
test -s /tmp/sbg-creating.log
curl -fsS "${H[@]}" -X POST "$BASE/api/session/$SID2/kill-sandbox" -H 'Content-Type: application/json' -d '{}' > /tmp/sbg-kill-pending.json
kill "$LOG_PID" 2>/dev/null || true
wait "$FIRST"
python3 - <<'PY'
import json
result = json.load(open('/tmp/sbg-kill-pending.json'))
assert result.get('destroyed') is False, result
PY

curl -fsS "${H[@]}" -X POST "$BASE/api/session/$SID2/kill-sandbox" -H 'Content-Type: application/json' -d '{}' > /tmp/sbg-kill-ready.json
python3 - <<'PY'
import json
assert json.load(open('/tmp/sbg-kill-ready.json')).get('destroyed') is True
PY
OLD_ID=$(psql "$PG_URL" -X -A -t -c "SELECT id FROM sandbox WHERE session_id='$SID2'")
test "$(pgval "SELECT count(*) FROM sandbox WHERE session_id='$SID2' AND state='destroyed' AND keep_alive=1")" = 1

curl -sS -o /tmp/sbg-retry.json -w '%{http_code}\n' "${H[@]}" -X POST "$BASE/api/session/$SID2/shell" \
  -H 'Content-Type: application/json' -d '{"id":"msg_sbg_retry","command":"echo recovered"}'
NEW_ID=$(curl -fsS "${H[@]}" "$BASE/api/session/$SID2/sandbox" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sandboxId"])')
test -n "$OLD_ID" && test -n "$NEW_ID" && test "$OLD_ID" != "$NEW_ID"
curl -fsS "${H[@]}" "$BASE/api/session/$SID2/message?order=asc" > /tmp/sbg2-messages.json
python3 - <<'PY'
import json
messages = json.load(open('/tmp/sbg2-messages.json'))['data']
expected = {'pwd', 'echo recovered'}
shells = [m for m in messages if m.get('type') == 'shell' and m.get('command') in expected]
assert len(shells) == 2 and all(m.get('status') == 'exited' and m.get('exit') == 0 for m in shells), shells
PY
```

**通过条件**：创建中 kill 返回 `destroyed:false`，首个 shell 完成；创建后 kill 返回 `destroyed:true`，PG 为 `destroyed/keep_alive=true`；随后 shell `exited/0`，产生不同的新 sandbox ID。该用例验证当前“不取消创建”的实现语义，不代表创建中 kill 有中断效果。如果业务要求创建中取消，需将此处的预期改为期望行为并先修复 Provider/handler。

## T-SBG.3：release、状态持久化和会话隔离

```bash
# release 关闭保活并销毁
curl -fsS "${H[@]}" -X POST "$BASE/api/session/$SID2/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":false}'
curl -fsS "${H[@]}" "$BASE/api/session/$SID2/keep-alive"
curl -fsS "${H[@]}" "$BASE/api/session/$SID2/sandbox"
test "$(pgval "SELECT count(*) FROM sandbox WHERE session_id='$SID2' AND state='destroyed' AND keep_alive=0")" = 1

# 新 session 不得复用 SID2 的 sandbox
SID3=$(curl -fsS "${H[@]}" -X POST "$BASE/api/session" -H 'Content-Type: application/json' -d '{}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["id"])')
curl -sS -o /dev/null -w '%{http_code}\n' "${H[@]}" -X POST "$BASE/api/session/$SID3/shell" \
  -H 'Content-Type: application/json' -d '{"id":"msg_sbg_isolation","command":"echo isolated"}'
ID3=$(curl -fsS "${H[@]}" "$BASE/api/session/$SID3/sandbox" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sandboxId"])')
test -n "$ID3" && test "$ID3" != "$NEW_ID"
```

**通过条件**：release 后 API 报 `keepAlive=false`、sandbox ID 为空，PG 行 `destroyed/keep_alive=false`；新 session 创建出的 sandbox ID 与旧 session 不同，PG 分别归属各自 session。

## 自动化覆盖与已知空白

```bash
cd packages/core
bun run test -- sandbox-provider.test.ts session-shell.test.ts session-owned.test.ts
bun run typecheck
```

上述单测目前**不模拟 OpenSandbox 创建/销毁竞态**；它们不能替代 T-SBG.1/T-SBG.2。要稳定覆盖创建超时、创建被中断后迟到实例清理、并发请求只 create 一次以及 destroy 与 create 交错，需要给 Provider 的 OpenSandbox client/创建函数增加可注入边界，并用 Deferred 控制创建时序。当前尚无该类确定性测试；外部 OpenSandbox E2E 只能补充，不能保证每次重现竞态。

| 场景                   | 当前验证方式            | 证据                                            |
| ---------------------- | ----------------------- | ----------------------------------------------- |
| 同进程并发首建         | T-SBG.1 + Provider 日志 | 两个 shell 终态、一次 create、单行 PG           |
| 创建中 kill            | T-SBG.2                 | 明确验证 `destroyed:false`，不声称取消成功      |
| 创建后销毁及重建       | T-SBG.2                 | kill 响应、不同 sandbox ID、shell 终态、PG 状态 |
| release 与 keep-alive  | T-SBG.3                 | API 和 PG 状态                                  |
| 超时/中断/迟到创建清理 | 缺确定性自动化测试      | 需注入可控 OpenSandbox client                   |
| 多 SaaS 副本并发创建   | 当前不保证              | `creates` 仅进程内 Ref，不是分布式锁            |

> 清理：上方 `trap` 会在 shell 退出时对 SID/SID2/SID3 关闭 keep-alive 并删除 session；仍需确认 OpenSandbox 中无遗留实例。若手动分段运行脚本，应手动执行相同清理，失败退出也不要跳过。
