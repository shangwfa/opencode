# 并发安全验证（P0 修复回归）

> 验证 `fix(sandbox): fix 5 P0 concurrency risks` 的 5 项修复。

## ⚠️ V1 路径已全部改写为 V2（2026-09-29）

原文档使用 V1 路径（`$BASE/session`、`/message`、`/prompt_async`、`/abort`），**V2 无兼容层**。已按下表改写：

| V1 调用 | V2 调用 | 差异 |
|---|---|---|
| `POST /session` | `POST /api/session` | 请求体需 `location.directory`；返回 `{data: session}` |
| `POST /session/:id/message` | `POST /api/session/:id/prompt` + `POST /api/experimental/session/:id/wait` | prompt 是**异步接纳**，不等模型回复 |
| `POST /session/:id/prompt_async` | `POST /api/session/:id/prompt` | V2 一律异步，返回 HTTP 200 + user message |
| `POST /session/:id/abort` | `POST /api/session/:id/interrupt` | 返回 `{interrupted: boolean}` |
| `POST /session/:id/kill-sandbox` | 同名，仅加 `/api` 前缀 | 语义不变 |
| PG 表 `message` | PG 表 **`session_message`** | V1 的 `message` 表不存在 |

> V1 请求不会报 404，而是命中 **SPA fallback 返回 HTML 200**。判定端点存在必须看 `content-type`。

## 公共环境

> 运行前先加载环境：`source test-env.sh 3`。用例直接用 `$BASE` `$PG_URL` `$MODEL`，不重复定义。
>
> V2 工具名是 `shell` 不是 `bash`；工具调用结果从 `GET /api/session/:id/message` 的
> `.data[].content[] | select(.type=="tool")` 读，状态在 `.state.status`。

```bash
export BASE="${BASE:-http://localhost:14096}"
export PG_URL="${PG_URL:-postgresql://local@127.0.0.1:5432/opencode-v2-up}"
export MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
api(){ curl --fail-with-body -sS --noproxy '*' "${CURL_AUTH[@]}" "$@"; }
pgval(){ psql "$PG_URL" -t -A -c "$1"; }

new_session(){
  jq -nc --argjson m "$MODEL" '{location:{directory:"/workspace"}, model:$m}' \
    | api -X POST "$BASE/api/session" -H 'Content-Type: application/json' --data-binary @- \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['id'])"
}

# 发 prompt（异步接纳）后等会话空闲
send_prompt(){ # $1=SID $2=text  [$3=是否等待，默认等待]
  jq -nc --arg t "$2" '{text:$t,metadata:{},delivery:"queue"}' \
    | api -X POST "$BASE/api/session/$1/prompt" -H 'Content-Type: application/json' --data-binary @- >/dev/null
  [ "${3:-wait}" = "wait" ] && curl -s --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null \
    -X POST "$BASE/api/experimental/session/$1/wait" -H 'Content-Type: application/json' -d '{}'
  return 0
}

# 取该会话最后一次 assistant 文本
last_text(){ api "$BASE/api/session/$1/message?order=asc&limit=200" \
  | jq -r '[.data[] | select(.type=="assistant") | .content[]? | select(.type=="text") | .text] | last // ""'; }

# 取该会话工具调用列表
tools_of(){ api "$BASE/api/session/$1/message?order=asc&limit=200" \
  | jq -r '.data[] | select(.type=="assistant") | .content[]? | select(.type=="tool") | "\(.name)(\(.state.status))"'; }
```

---

## P0-1: sbCache TOCTOU 竞态 — getCachedSandbox 在 lock 内

### T39.1.1 并发 destroy + 长命令不崩溃

**场景**：长命令执行中调 kill-sandbox，应优雅失败而非使用已死 sandbox；随后新命令应能重建。

```bash
SID=$(new_session); echo "SID=$SID"
# 异步发起长命令（不等待）
send_prompt "$SID" '用 shell 工具执行 sleep 20 && echo long-done' nowait
sleep 6
# 并发 destroy
curl -s --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/kill-sandbox" \
  -H 'Content-Type: application/json' -d '{}' | jq -c .
sleep 2
# 再次发消息，sandbox 应重建
send_prompt "$SID" '用 shell 工具执行 echo rebuilt-ok'
echo "回复: $(last_text "$SID")"
tools_of "$SID"
```

**期望**：最后一条 assistant 文本包含 `rebuilt-ok`；服务无崩溃（`docker logs` 无 panic/`runInSession failed`）。

### T39.1.2 连续 kill-sandbox + 工具调用

**场景**：destroyById 时正好有工具在使用缓存 sandbox。

```bash
SID=$(new_session); echo "SID=$SID"
send_prompt "$SID" '用 shell 工具执行 echo warmup'
SB_ID=$(pgval "SELECT id FROM sandbox WHERE session_id='$SID' AND state='running'")
echo "sandbox=$SB_ID"
# 并发：kill-sandbox + 新工具调用
curl -s --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/kill-sandbox" \
  -H 'Content-Type: application/json' -d '{}' >/dev/null &
send_prompt "$SID" '用 shell 工具执行 echo concurrent-test'
wait
echo "回复: $(last_text "$SID")"
```

**期望**：工具调用正常完成（sandbox 重建）或优雅报错，服务不异常退出。

---

## P0-2: commandSemaphores 永不删除 — 串行化不失效

### T39.2.1 interrupt 后立即发新命令

**场景**：interrupt 中断长命令后立即发新命令，新命令不应卡死。

```bash
SID=$(new_session); echo "SID=$SID"
send_prompt "$SID" '用 shell 工具执行 sleep 30 && echo long-done' nowait
sleep 4
# 等会话进入 active 再中断
for _ in $(seq 1 50); do
  api "$BASE/api/session/active" | jq -e --arg s "$SID" '.data[$s]' >/dev/null 2>&1 && break
  sleep 0.2
done
curl -s --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/interrupt" \
  -H 'Content-Type: application/json' -d '{}' | jq -c .
# 立即发新命令
send_prompt "$SID" '用 shell 工具执行 echo after-interrupt'
echo "回复: $(last_text "$SID")"
```

**期望**：`after-interrupt` 正常返回，无输出混乱；服务日志无 execd panic。

### T39.2.2 多次 kill-sandbox 后命令仍可用

```bash
SID=$(new_session); echo "SID=$SID"
for i in 1 2 3; do
  send_prompt "$SID" "用 shell 工具执行 echo round-$i"
  curl -s --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/kill-sandbox" \
    -H 'Content-Type: application/json' -d '{}' >/dev/null
  sleep 2
done
send_prompt "$SID" '用 shell 工具执行 echo final-check'
echo "回复: $(last_text "$SID")"
```

**期望**：每次 kill 后重建 sandbox，`final-check` 正常返回。

---

## P0-3: sandbox 创建互斥

### T39.3.1 同 session 并发只创建一个 sandbox

**场景**：同一 session 并发发 3 条消息，只应有一个 sandbox。

```bash
SID=$(new_session); echo "SID=$SID"
for i in 1 2 3; do
  send_prompt "$SID" "回复 $i" nowait
done
wait
sleep 25
echo "sandbox running count: $(pgval "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND state='running'")"
echo "sandbox 全部记录:"
pgval "SELECT id||' '||state FROM sandbox WHERE session_id='$SID'"
```

**期望**：`count=1`；容器层面无孤儿（`docker ps` 中该 session 只对应 1 个 sandbox 容器）。

### T39.3.2 不同 session 并发各自独立

```bash
SIDS=()
for i in 1 2 3; do
  S=$(new_session); SIDS+=("$S")
  send_prompt "$S" "回复 session-$i" nowait
done
wait
sleep 25
for S in "${SIDS[@]}"; do
  echo "$S: running=$(pgval "SELECT count(*) FROM sandbox WHERE session_id='$S' AND state='running'")"
done
```

**期望**：每个 session 各 1 个 running sandbox。

---

## P0-4: destroyById invalidate 在 lock 内

### T39.4.1 kill-sandbox + 并发命令不使用已死 sandbox

```bash
SID=$(new_session); echo "SID=$SID"
send_prompt "$SID" '用 shell 工具执行 echo create'
SB_ID=$(pgval "SELECT id FROM sandbox WHERE session_id='$SID' AND state='running'")
echo "sandbox=$SB_ID"
curl -s --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$SID/kill-sandbox" \
  -H 'Content-Type: application/json' -d '{}' >/dev/null &
sleep 1
send_prompt "$SID" '用 shell 工具执行 echo after-destroy'
wait
echo "回复: $(last_text "$SID")"
```

**期望**：消息正常返回（sandbox 重建），不卡死在 "sandbox is not available"。

---

## P0-5: session.remove 联动 cancel + destroy

### T39.5.1 删除 session 后 sandbox 被销毁

```bash
SID=$(new_session); echo "SID=$SID"
send_prompt "$SID" '用 shell 工具执行 echo create-sandbox'
echo "before delete: state=$(pgval "SELECT state FROM sandbox WHERE session_id='$SID'")"
curl -s --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" -o /dev/null -w 'delete HTTP %{http_code}\n'
sleep 4
echo "after delete: state=$(pgval "SELECT state FROM sandbox WHERE session_id='$SID'")"
```

**期望**：`before=running`，`after=destroyed`，delete 返回 HTTP 204。

### T39.5.2 删除正在 LLM 调用的 session，不再写入新消息

```bash
SID=$(new_session); echo "SID=$SID"
send_prompt "$SID" '写一首 500 字的诗' nowait
sleep 3
BEFORE=$(pgval "SELECT count(*) FROM session_message WHERE session_id='$SID'")
echo "before_delete=$BEFORE"
curl -s --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" -o /dev/null
sleep 20
AFTER=$(pgval "SELECT count(*) FROM session_message WHERE session_id='$SID'")
echo "after_20s=$AFTER"
```

**期望**：`after_20s=0`（级联删除），即删除后不再有消息写入 —— LLM 已被取消。

### T39.5.3 删除 session 后 PG 无孤儿 sandbox

```bash
SID=$(new_session); echo "SID=$SID"
send_prompt "$SID" '用 shell 工具执行 echo orphan-test'
echo "before delete: running=$(pgval "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND state='running'")"
curl -s --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" -o /dev/null
sleep 5
echo "orphan running: $(pgval "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND state='running'")"
```

**期望**：`orphan running=0`。

---

## 结果汇总

### 2026-09-29 V2 实测

环境：SaaS 镜像 `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱镜像 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG `opencode-v2-up`、本地 OpenSandbox（Docker runtime）、`Yd-DeepSeek/deepseek-v4-flash`。**共 15 条断言 PASS，0 FAIL。**

| 用例 | P0 项 | 结果 | 实际观察 |
|---|---|---|---|
| T39.1.1 | sbCache TOCTOU | ✅ | `sleep 20` 执行中 kill-sandbox（HTTP 200）后，新命令 `echo rebuilt-ok` 正常返回；`shell(completed)` × 4 |
| T39.1.2 | sbCache TOCTOU | ✅ | kill-sandbox 与新命令并发，回复「已执行,输出为 `concurrent-test`(退出码 0)」 |
| T39.2.1 | commandSemaphores | ✅ | `interrupt` 返回 `{"interrupted":true}`；新命令正常，模型明确说明「上一个 sleep 30 被中断」 |
| T39.2.2 | commandSemaphores | ✅ | 3 轮「命令 + kill-sandbox」后 `final-check` 正常返回 |
| T39.3.1 | 创建互斥 | ✅ | 同 session 并发 3 条消息，PG 中 `running` sandbox **count=1**，无孤儿记录 |
| T39.3.2 | 创建互斥 | ✅ | 3 个 session 并发，各自 `running=1`，互不干扰 |
| T39.4.1 | destroyById invalidate | ✅ | kill-sandbox 与命令并发，`after-destroy` 正常输出 |
| T39.5.1 | session.remove 联动 | ✅ | `before=running` → delete HTTP 204 → `after=destroyed` |
| T39.5.2 | session.remove 联动 | ✅ | 删除前 `session_message=2`，20s 后 `=0`（级联删除，LLM 已取消） |
| T39.5.3 | session.remove 联动 | ✅ | 删除前 `running=1`，删除后孤儿 `running=0` |

**服务稳定性**：每组都检查了 `docker logs` 中新增日志，全部无 `runInSession failed` / `sandbox is not available` / `panic` / `ECONNRESET`。

**清理**：本轮 11 个会话及其 sandbox 已全部删除。

> ⚠️ **本条记录曾一度不准确**：首次清理用了 `for s in $SIDS`（zsh 下不分词，只迭代一次），而验证查询又用同样的字符串拼接生成 `IN ('a,b,c')` —— 这是个字符串字面量，永远匹配不到任何行，于是返回 `0` 并被误读为「已清理干净」。事后复查发现实际残留 9 个会话，已用正确写法（`while IFS= read -r` + 直接 `count`）重新清理。详见 [concurrency-isolation.md 的「清理陷阱」](./concurrency-isolation.md#️-清理陷阱zsh-下-for-s-in-sids-只迭代一次)。
>
> T39.5.1–T39.5.3 三个用例在测试过程中自身会 `DELETE` 会话，这部分与清理脚本无关。

### V1 → V2 改写要点

原文档全部使用 V1 路径，V2 无兼容层。改写时踩到的坑：

| 坑 | V1 写法 | V2 实际 | 现象 |
|---|---|---|---|
| 消息发送 | `POST /session/:id/message` **同步返回** AI 回复 | `POST /api/session/:id/prompt` 仅**异步接纳**，需另调 `wait` | 沿用 V1 写法拿不到 assistant 文本，会误判为 FAIL |
| 工具名 | `bash` | `shell` | 工具列表断言需按 V2 名 |
| 中断 | `POST /session/:id/abort` | `POST /api/session/:id/interrupt` → `{interrupted:bool}` | — |
| PG 表 | `message` | `session_message` | V1 的 `message` 表在 V2 PG 中不存在 |

> ⚠️ **并发用例必须用 `nowait` 方式发 prompt**（不等 `wait`），否则第一个命令跑完才发第二个，**根本构不成并发**，用例会假通过。这是改写并发用例时最容易出错的地方。

### 历史记录

> 原文档基于 V1 API（`$BASE/session`、`/message`、`prompt_async`、`abort`），在 V2 下不可直接执行。
