# 并发与隔离

> 公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。
>
> **本文档已改写为 V2 契约**（2026-09-29）。原 V1 写法与映射关系见文末「V1 → V2 改写」。

## ⚠️ V1 路径已失效

V2 无 V1 兼容层。V1 请求不会返回 404，而是命中 **SPA fallback 返回 HTML 200** —— 判定端点存在必须看 `content-type`，只看状态码会被骗过。

其中 **`POST /session/:id/exec` 实测返回 405**，且 V2 **没有同步 exec**：所有命令执行改用 `POST /api/session/:id/shell`（返回 204，异步），终态从 PG 读。

## 验证标准

| 层级 | 方法 | 判定标准 |
|------|------|---------|
| 1. HTTP 响应 | 并发调用 API | 全部成功，无冲突 |
| 2. PG 记录 | 查询 `sandbox` / `session_message` 表 | 记录独立，状态正确 |
| 3. 文件隔离 | `shell` 端点执行 `cat`/`ls` 验证 | session 间文件不互相可见 |

## 通用变量与辅助函数

> 运行前先加载环境：`source test-env.sh 3`。开测前建议跑一次
> `bash docs/test-cases/check-image-freshness.sh` 确认镜像没过期。

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

# V2 shell 替代 V1 同步 exec：发命令 → 轮询 PG → 取输出。
# 只有 status='exited' 才是终态，running 不能当结果。
# 结果写入全局 SHELL_OUT / SHELL_EXIT。用法: run_shell SID "命令" [超时秒]
run_shell(){
  local sid="$1" cmd="$2" to="${3:-60}" before
  before=$(pgval "SELECT coalesce(max(seq),0) FROM session_message WHERE session_id='$sid'")
  jq -nc --arg c "$cmd" '{command:$c}' \
    | api -X POST "$BASE/api/session/$sid/shell" -H 'Content-Type: application/json' --data-binary @- >/dev/null
  for _ in $(seq 1 $((to*2))); do
    if [ "$(pgval "SELECT count(*) FROM session_message WHERE session_id='$sid' AND type='shell' AND seq>$before AND data::jsonb->>'status'='exited'")" -gt 0 ]; then
      SHELL_OUT=$(pgval "SELECT data::jsonb->'output'->>'output' FROM session_message WHERE session_id='$sid' AND type='shell' AND seq>$before AND data::jsonb->>'status'='exited' ORDER BY seq DESC LIMIT 1")
      SHELL_EXIT=$(pgval "SELECT coalesce((data::jsonb->>'exit')::text,'?') FROM session_message WHERE session_id='$sid' AND type='shell' AND seq>$before AND data::jsonb->>'status'='exited' ORDER BY seq DESC LIMIT 1")
      return 0
    fi
    sleep 0.5
  done
  SHELL_OUT=""; SHELL_EXIT="timeout"; return 1
}

killsb(){ curl -s --noproxy '*' "${CURL_AUTH[@]}" -o /dev/null -w '%{http_code}' \
  -X POST "$BASE/api/session/$1/kill-sandbox" -H 'Content-Type: application/json' -d '{}'; }
```

> **为什么文件操作用 `shell` 而不是「发消息让模型写文件」**：原 V1 文档靠 AI 准备测试数据，慢且不确定。`shell` 可直接执行命令，断言从「模型说了什么」变成「文件里到底是什么」，隔离类断言才真正可靠。

---

## 六、并发与隔离

### T6.1 并发创建 session

```bash
SIDS=()
for i in {1..5}; do
  SID=$(new_session)
  SIDS+=($SID)
  echo "  Session $i: $SID"
done

UNIQUE=$(printf '%s\n' "${SIDS[@]}" | sort -u | wc -l | tr -d '[:space:]')
echo "创建数: ${#SIDS[@]}, 唯一数: $UNIQUE"

echo "--- PG 验证（V2 表名是 session_v2）---"
for sid in "${SIDS[@]}"; do
  EXISTS=$(pgval "SELECT count(*) FROM session_v2 WHERE id='$sid'")
  echo "  $sid: EXISTS=$EXISTS"
done
```

**期望**：5 个不同 sessionID，PG 全部 EXISTS=1

### T6.2 跨 session 文件隔离

```bash
# Session A 创建文件
SID_A=$(new_session); echo "Session A: $SID_A"
run_shell "$SID_A" "echo A > /workspace/sessionA.txt"
echo "  A 写入 exit=$SHELL_EXIT"
run_shell "$SID_A" "cat /workspace/sessionA.txt"
echo "  A 读取: $SHELL_OUT"

# Session B 列出目录
SID_B=$(new_session); echo "Session B: $SID_B"
run_shell "$SID_B" "ls /workspace/ 2>&1"
echo "  B ls: ${SHELL_OUT:-(空)}"
echo "$SHELL_OUT" | grep -q 'sessionA.txt' \
  && echo "❌ T6.2 FAIL: B 看到了 A 的文件" \
  || echo "✅ T6.2 PASS: B 看不到 A 的文件"

echo "--- PG 验证 ---"
pgval "SELECT session_id||' -> '||id||' '||state FROM sandbox WHERE session_id IN ('$SID_A','$SID_B')"
```

**期望**：B 看不到 `sessionA.txt`，sandbox id 不同

### T6.3 并发消息发送

```bash
SID=$(new_session); echo "SID: $SID"

# V2 prompt 返回 200（不是 V1 prompt_async 的 204）
for i in {1..3}; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" --noproxy '*' "${CURL_AUTH[@]}" --max-time 15 \
    -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
    -d "{\"text\":\"第${i}条\",\"metadata\":{},\"delivery\":\"queue\"}")
  echo "  第${i}条: HTTP=$STATUS"
done

sleep 30
echo "--- PG 验证（V2 表名 session_message，无 part 表）---"
pgval "SELECT '总消息数='||count(*) FROM session_message WHERE session_id='$SID'"
pgval "SELECT 'user='||count(*) FROM session_message WHERE session_id='$SID' AND type='user'"
```

**期望**：全部 200，`user=3`（3 条消息均被接纳未丢失）

> **定位说明**：同 session 消息为串行处理（见已废弃的 T6.10），本用例验证的是 **prompt 的 200 接纳语义**（快速连续提交均被接受且不丢消息），而非并发执行能力。V2 无 `part` 表，content 内嵌在 `session_message.data.content[]`。

### T6.4 并发 sandbox 创建

```bash
SIDS=()
for i in {1..5}; do
  SIDS+=("$(new_session)")
done

echo "并发触发 5 个 sandbox 创建..."
for sid in "${SIDS[@]}"; do
  run_shell "$sid" "hostname" 90 &
done
wait

echo "--- PG 验证 ---"
for sid in "${SIDS[@]}"; do
  echo "  $sid: state=$(pgval "SELECT state FROM sandbox WHERE session_id='$sid'")"
done
```

**期望**：5 个 sandbox 全部创建成功（state=running）

### T6.5 并发写同名文件隔离

```bash
SID_A=$(new_session); SID_B=$(new_session)
echo "Session A: $SID_A"; echo "Session B: $SID_B"

# 并发写同名文件
run_shell "$SID_A" "echo AAA > /workspace/shared.txt" 90 &
run_shell "$SID_B" "echo BBB > /workspace/shared.txt" 90 &
wait

# 验证各自内容独立
run_shell "$SID_A" "cat /workspace/shared.txt"; CONTENT_A="$SHELL_OUT"
run_shell "$SID_B" "cat /workspace/shared.txt"; CONTENT_B="$SHELL_OUT"

echo "  Session A 内容: $CONTENT_A"
echo "  Session B 内容: $CONTENT_B"
[ "$CONTENT_A" = "AAA" ] && [ "$CONTENT_B" = "BBB" ] \
  && echo "✅ T6.5 PASS" || echo "❌ T6.5 FAIL"
```

**期望**：A 读到 AAA，B 读到 BBB，内容互不影响

### T6.6 sandbox 崩溃隔离

> ⚠️ **原用例的 `kill -9 1` 在 V2 沙箱里无效**（实测：exit=0、输出正常，但 PG 中 sandbox 仍 `running`）。沙箱 PID 1 是 entrypoint，execd 拉起的 shell 不受其影响 —— 照原写法跑会**假通过**，根本没测到崩溃隔离。
>
> 正确做法：用 `POST /api/session/:id/kill-sandbox` 真实销毁（PG 会转 `destroyed`），再验证 B 不受影响。

```bash
SID_A=$(new_session); SID_B=$(new_session)
echo "Session A: $SID_A"; echo "Session B: $SID_B"

# 先在 B 中写文件
run_shell "$SID_B" "echo SAFE > /workspace/before-crash.txt"
echo "  B 预置文件 exit=$SHELL_EXIT"

# 真实销毁 A 的 sandbox
echo "--- kill-sandbox A ---"
echo "  HTTP $(killsb "$SID_A")"
sleep 4
echo "  A sandbox 状态=$(pgval "SELECT state FROM sandbox WHERE session_id='$SID_A'")"

# 验证 B 不受影响
run_shell "$SID_B" "cat /workspace/before-crash.txt"
echo "  Session B 内容: $SHELL_OUT"
[ "$SHELL_OUT" = "SAFE" ] && echo "✅ T6.6 PASS" || echo "❌ T6.6 FAIL"
```

**期望**：A 的 sandbox 转 `destroyed`；B 读到 `SAFE`，证明 A 被销毁不影响 B

### T6.7 同 session 并发 exec

```bash
SID=$(new_session)
echo "SID: $SID"

# 先创建 sandbox
run_shell "$SID" "echo warmup" 90

# 并发执行 5 个 shell
echo "--- 并发执行 5 个 shell ---"
for i in {1..5}; do
  run_shell "$SID" "echo exec-$i" 90 &
done
wait

echo "--- PG 验证 ---"
echo "  shell 消息数=$(pgval "SELECT count(*) FROM session_message WHERE session_id='$SID' AND type='shell'") (期望 >=6: warmup+5)"
pgval "SELECT '  '||id||' '||state FROM sandbox WHERE session_id='$SID'"
```

**期望**：5 个并发 shell 全部执行成功（PG 中 shell 消息 ≥6 条）

### T6.8 并发删除 + 写入

```bash
SID_A=$(new_session); SID_B=$(new_session)
echo "Session A: $SID_A"; echo "Session B: $SID_B"

# B 开始写文件（先 sleep 制造时间差）
echo "--- Session B 开始写文件 ---"
run_shell "$SID_B" "sleep 2; echo DONE > /workspace/long-write.txt" 90 &

sleep 1

# A 删除自己
echo "--- Session A 删除自己 ---"
DEL=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID_A")
echo "  delete HTTP: $DEL"

# 等 B 完成
wait

# 验证 B 的文件还在
run_shell "$SID_B" "cat /workspace/long-write.txt 2>&1"
echo "  Session B 内容: $SHELL_OUT"
[ "$SHELL_OUT" = "DONE" ] && echo "✅ T6.8 PASS" || echo "❌ T6.8 FAIL"

echo "--- PG 验证（V2 表名 session_v2）---"
echo "  A 残留=$(pgval "SELECT count(*) FROM session_v2 WHERE id='$SID_A'") (期望 0)"
pgval "SELECT '  '||id||' '||state FROM sandbox WHERE session_id='$SID_B'"
```

**期望**：A 删除 HTTP 204 且 PG 残留 0，B 的文件不受影响

### T6.9 sandbox 重建并发

```bash
SIDS=()
for i in {1..3}; do
  SIDS+=("$(new_session)")
done

# 先触发 sandbox 创建
for sid in "${SIDS[@]}"; do
  run_shell "$sid" "echo warm" 90
done

# 销毁所有 sandbox
echo "--- 销毁所有 sandbox ---"
for sid in "${SIDS[@]}"; do
  echo "  kill HTTP $(killsb "$sid")"
done
sleep 3

# 并发触发重建
echo "--- 并发触发重建 ---"
for sid in "${SIDS[@]}"; do
  run_shell "$sid" "echo rebuilt-ok" 90 &
done
wait

echo "--- PG 验证 ---"
for sid in "${SIDS[@]}"; do
  echo "  $sid: state=$(pgval "SELECT state FROM sandbox WHERE session_id='$sid'")"
done
```

**期望**：3 个 sandbox 全部重建成功（`state=running`）

### T6.10 消息队列压力（⛔ 已废弃）

> **废弃原因**：单 session 连续发送 20 条消息属于人造场景，真实用户不会如此操作。opencode 对同一 session 的消息**串行处理**，该用例实际测的是"慢模型 + 串行队列"的吞吐延迟，而非并发隔离能力。并发验证应聚焦 **session 级别**，见 [T6.11](#t611-20-会话--混合任务并发)（20 会话真并发）。原脚本已移除（历史版本见 git 历史），无需执行。

---

## 七、负载压测

### T6.11 20 会话 × 混合任务并发

```bash
# 创建 20 个会话
echo "--- 创建 20 个会话 ---"
SIDS=()
for i in $(seq 1 20); do
  SID=$(new_session)
  SIDS+=("$SID")
  echo "  [$i] $SID"
done

# 发送 20 条 prompt（V2 期望 200，不是 V1 的 204）
echo "--- 发送 20 条 prompt ---"
N=0
for SID in "${SIDS[@]}"; do
  N=$((N + 1))
  curl -s -o /dev/null -w "%{http_code}\n" --noproxy '*' "${CURL_AUTH[@]}" --max-time 15 \
    -X POST "$BASE/api/session/$SID/prompt" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":\"任务编号 $N\",\"metadata\":{},\"delivery\":\"queue\"}" &
done > /tmp/t6-11-codes.txt
wait

echo "--- HTTP 状态码统计（期望全 200）---"
sort /tmp/t6-11-codes.txt | uniq -c

echo "--- 等待处理（90秒）---"
sleep 90

echo "--- 验证结果（V2 用 type 字段，不是 data->>'role'）---"
TOTAL_USER=0
TOTAL_ASSISTANT=0
for SID in "${SIDS[@]}"; do
  U=$(pgval "SELECT count(*) FROM session_message WHERE session_id='$SID' AND type='user'")
  As=$(pgval "SELECT count(*) FROM session_message WHERE session_id='$SID' AND type='assistant'")
  TOTAL_USER=$((TOTAL_USER + U))
  TOTAL_ASSISTANT=$((TOTAL_ASSISTANT + As))
done

echo "========================================"
echo "  汇总"
echo "========================================"
echo "总会话数: 20"
echo "总消息数: $TOTAL_MSG (期望>=40)"
echo "  - user: $TOTAL_USER (期望=20)"
echo "  - assistant: $TOTAL_ASSISTANT (期望>=20)"
```

**期望**：
- HTTP：全部 204
- PG：user=20，assistant>=20，总消息数>=40

---

## 验收汇总

| 用例 | 场景 | HTTP | PG | 隔离验证 | 结果 |
|------|------|------|-----|---------|------|
| T6.1 | 并发创建 session | 5 个唯一 ID | 全部 EXISTS=1 | — | ✅ |
| T6.2 | 跨 session 文件隔离 | A/B 独立 | sandbox 不同 | B 看不到 A 文件 | ✅ |
| T6.3 | 并发消息发送 | 全部 200 | user=3 | — | ✅ |
| T6.4 | 并发 sandbox 创建 | 5 个成功 | state=running | — | ✅ |
| T6.5 | 并发写同名文件 | 各自成功 | — | A=AAA B=BBB | ✅ |
| T6.6 | sandbox 崩溃隔离 | kill-sandbox 200 | A 已 destroyed | B 读到 SAFE | ✅ |
| T6.7 | 同 session 并发 exec | 5 个成功 | shell 消息=6 | — | ✅ |
| T6.8 | 并发删除+写入 | A 删除 204 | A 残留=0 | B 读到 DONE | ✅ |
| T6.9 | sandbox 重建并发 | 3 个重建成功 | state=running | — | ✅ |
| T6.10 | 消息队列压力（⛔ 已废弃） | — | — | 单 session 串行连发，非真实场景 | ⛔ |
| T6.11 | 20 会话混合任务 | 20 条 200 | user=20, assistant=60 | — | ✅ |

---

## 2026-09-29 V2 实测记录

环境：SaaS `opencode-saas-sandbox-test:9d86bde786-t4`、沙箱 `opencode-opensandbox:local`（`7057c941ec64`）、本地 PG + 本地 OpenSandbox、`Yd-DeepSeek/deepseek-v4-flash`。**11 条断言 PASS，0 FAIL。**

### V1 → V2 改写

原文档全部使用 V1 路径，V2 无兼容层。关键映射：

| V1 | V2 |
|---|---|
| `POST /session` | `POST /api/session` |
| `POST /session/:id/message`（同步） | `POST /api/session/:id/prompt` + `wait` |
| `POST /session/:id/exec`（**同步返回 stdout**） | `POST /api/session/:id/shell`（**返回 204，异步**），终态从 PG 的 `type='shell'` 且 `status='exited'` 读 |
| `prompt_async` | `prompt` |
| PG 表 `session` / `message` / `part` | `session_v2` / `session_message` /（V2 无 part 表，content 在 `session_message.data.content[]`） |

> **V2 没有同步 exec 端点**（V1 路径实测返回 405）。原文档大量依赖 `exec` 同步拿 `stdout`，V2 必须改成「发 shell → 轮询 PG → 取 `data.output.output` 与 `data.exit`」。注意只有 `status='exited'` 才是终态，`running` 不能当结果。

### 三个必须注意的坑

1. **`kill -9 1` 在 V2 沙箱里杀不掉容器**。实测 `kill -9 1` 返回 `exit=0`、输出 `selfkill-attempted`，但 PG 中 sandbox 仍是 `running` —— 沙箱 PID 1 是 entrypoint，execd 拉起的 shell 不受影响。**原 T6.6 因此根本没测到崩溃隔离**。已改用 `POST /api/session/:id/kill-sandbox` 真实销毁（PG 确认转 `destroyed`），才真正验证了 A 销毁后 B 不受影响。

2. **文件操作不必绕 AI**。原文档用「发消息让模型写文件」准备测试数据，慢且不确定。V2 的 `shell` 端点可直接执行命令，隔离类用例全部改用它，断言从「模型说了什么」变成「文件里到底是什么」。

3. **T6.3 的期望码从 204 变 200**。V1 `prompt_async` 返回 204，V2 `prompt` 返回 200 + 已接纳的 user message。沿用 204 会误判 FAIL。

### 实测明细

| 用例 | 实际观察 |
|---|---|
| T6.1 | 5 个 sessionID 全唯一，`session_v2` 中 EXISTS 全为 1 |
| T6.2 | A 写入并读回 `A`；B 的 `ls /workspace` 为空，看不到 `sessionA.txt`；两侧 sandbox id 不同 |
| T6.3 | 3 次 `prompt` 全部 HTTP 200；PG `user=3`、总消息 8 条 |
| T6.4 | 5 个 session 并发建沙箱，`state` 全为 `running` |
| T6.5 | 并发写同名 `shared.txt`：A 读到 `AAA`，B 读到 `BBB` |
| T6.6 | `kill -9 1` **无效**（exit=0 但 state 仍 running）；改用 kill-sandbox 后 A 转 `destroyed`，B 仍读到 `SAFE` |
| T6.7 | 同 session 并发 5 个 shell，PG 中 `shell` 消息 6 条（warmup + 5），全部 exit=0 |
| T6.8 | A 删除 HTTP 204、PG 残留 0；B 的 `long-write.txt` 内容仍为 `DONE` |
| T6.9 | 3 个 sandbox 先全部 kill（HTTP 200），并发重建后 `state` 全为 `running` |
| T6.11 | 20 会话并发，**user=20（期望 20）**、assistant=60、总消息 80（期望 ≥40） |

### 清理

本轮 43 个会话及其 sandbox 已删除，复查 `count=0`。

> ⚠️ **本条记录曾一度不准确**：首次清理用了 `for s in $SIDS`（zsh 下不分词，只迭代一次），验证查询又用同样的字符串拼接生成 `IN ('a,b,c')` —— 字符串字面量永远匹配不到任何行，返回 `0` 被误读为「已清理干净」。事后复查发现实际残留 49 个会话。详见 [e2e.md 的「清理陷阱」](./e2e.md#️-清理陷阱zsh-下-for-s-in-sids-只迭代一次)。

