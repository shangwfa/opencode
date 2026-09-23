# 并发安全验证（P0 修复回归）

> 验证 `fix(sandbox): fix 5 P0 concurrency risks` 的 5 项修复。

## 公共环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL`，不重复定义。

---

## P0-1: sbCache TOCTOU 竞态 — getCachedSandbox 在 lock 内

### T39.1.1 并发 destroy + runInSession 不崩溃

**场景**：Fiber A 执行 runInSession（长命令），Fiber B 调用 destroy。A 应得到错误而非使用已死 sandbox。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 触发 sandbox 创建 + 长命令
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 sleep 20 && echo done"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' &
# 并发 destroy
sleep 5
curl -s -X POST "$BASE/session/$SID/kill-sandbox" | jq .
# 再次发消息，sandbox 应重建而非崩溃
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo rebuilt-ok"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' | jq -r '.parts[] | select(.type=="text") | .text'
```

**期望**：第二条消息正常返回 `rebuilt-ok`，无 "runInSession failed" 或进程崩溃。

### T39.1.2 连续 destroyById + 工具调用

**场景**：zombie cleanup 调 destroyById 时，正好有工具在使用缓存 sandbox。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 创建 sandbox
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo warmup"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' > /dev/null
# 获取 sandbox ID
SB_ID=$(psql "$PG_URL" -t -A -c "SELECT id FROM sandbox WHERE session_id='$SID' AND state='running'")
# 并发：destroyById + 工具调用
curl -s -X POST "$BASE/session/$SID/kill-sandbox" &
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo concurrent-test"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' | jq -r '.parts[] | select(.type=="text") | .text'
wait
```

**期望**：工具调用正常完成或优雅报错（sandbox 重建），不出现进程异常。

---

## P0-2: commandSemaphores 永不删除 — 串行化不失效

### T39.2.1 abort 后立即发新命令，命令串行执行

**场景**：abort 中断长命令后，立即发新命令。新命令应等待旧命令的 semaphore 释放（而非绕过）。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 启动长命令
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 sleep 30 && echo long-done"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
sleep 3
# abort
curl -s -X POST "$BASE/session/$SID/abort" | jq .
# 立即发新命令
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo after-abort"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' | jq -r '.parts[] | select(.type=="text") | .text'
```

**期望**：`after-abort` 正常返回，无输出混乱或 execd panic。

### T39.2.2 多次 kill-sandbox 后命令仍串行

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行 echo round-$i\"}],\"model\":{\"providerID\":\"Yd-DeepSeek\",\"modelID\":\"deepseek-v4-flash\"}}" > /dev/null
  curl -s -X POST "$BASE/session/$SID/kill-sandbox" > /dev/null
  sleep 2
done
# 最终一次命令验证
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo final-check"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' | jq -r '.parts[] | select(.type=="text") | .text'
```

**期望**：每次 kill 后重建 sandbox，`final-check` 正常返回。

---

## P0-3: PG advisory lock — 跨进程 sandbox 创建互斥

### T39.3.1 同 session 并发创建只有一个 sandbox

**场景**：同一 session 并发发送 3 条消息，只创建一个 sandbox 容器。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 并发 3 条消息（不同模型调用但同一 session）
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 $i\"}],\"model\":{\"providerID\":\"Yd-DeepSeek\",\"modelID\":\"deepseek-v4-flash\"}}" &
done
wait
sleep 30
# PG 验证：sandbox 只有 1 条 running 记录
COUNT=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND state='running'")
echo "sandbox running count: $COUNT"
```

**期望**：`COUNT=1`，不产生孤儿容器。

### T39.3.2 不同 session 并发创建各自独立

```bash
SIDS=()
for i in 1 2 3; do
  S=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
  SIDS+=($S)
  curl -s -X POST "$BASE/session/$S/prompt_async" -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 session-$i\"}],\"model\":{\"providerID\":\"Yd-DeepSeek\",\"modelID\":\"deepseek-v4-flash\"}}" &
done
wait
sleep 30
for S in "${SIDS[@]}"; do
  COUNT=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM sandbox WHERE session_id='$S' AND state='running'")
  echo "$S: sandbox=$COUNT"
done
```

**期望**：每个 session 各 1 个 sandbox。

---

## P0-4: destroyById invalidate 在 lock 内

### T39.4.1 destroyById + 并发 getOrCreate 不使用已死 sandbox

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 创建 sandbox
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo create"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' > /dev/null
SB_ID=$(psql "$PG_URL" -t -A -c "SELECT id FROM sandbox WHERE session_id='$SID' AND state='running'")
# 并发 destroyById + 消息
curl -s -X POST "$BASE/session/$SID/kill-sandbox" &
sleep 1
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo after-destroyById"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' | jq -r '.parts[] | select(.type=="text") | .text'
wait
```

**期望**：消息正常返回（sandbox 重建），无 "sandbox is not available" 卡死。

---

## P0-5: session.remove 联动 cancel + destroy

### T39.5.1 删除 session 后 sandbox 被销毁

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 创建 sandbox
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo create-sandbox"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' > /dev/null
sleep 2
STATE_BEFORE=$(psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID'")
echo "before delete: sandbox state=$STATE_BEFORE"
# 删除 session
curl -s -X DELETE "$BASE/session/$SID" | jq -r .id
sleep 3
STATE_AFTER=$(psql "$PG_URL" -t -A -c "SELECT state FROM sandbox WHERE session_id='$SID'")
echo "after delete: sandbox state=$STATE_AFTER"
```

**期望**：`before=running`，`after=destroyed`。

### T39.5.2 删除正在 LLM 调用的 session，不再写入新消息

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 发异步消息（LLM 正在生成）
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"写一首 500 字的诗"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}'
sleep 2
MSG_BEFORE=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM message WHERE session_id='$SID'")
# 立即删除
curl -s -X DELETE "$BASE/session/$SID" > /dev/null
sleep 20
# 检查是否有新消息写入已删 session
MSG_AFTER=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM message WHERE session_id='$SID'")
echo "messages: before_delete=$MSG_BEFORE after_20s=$MSG_AFTER"
```

**期望**：`after_20s=0`（session 级联删除了所有消息），或 `after_20s <= before_delete`（LLM 被取消，未产生新消息）。

### T39.5.3 删除 session 后 PG 无孤儿 sandbox

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
curl -s -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 echo orphan-test"}],"model":{"providerID":"Yd-DeepSeek","modelID":"deepseek-v4-flash"}}' > /dev/null
sleep 3
curl -s -X DELETE "$BASE/session/$SID" > /dev/null
sleep 5
RUNNING=$(psql "$PG_URL" -t -A -c "SELECT count(*) FROM sandbox WHERE session_id='$SID' AND state='running'")
echo "orphan running sandbox: $RUNNING"
```

**期望**：`RUNNING=0`。
