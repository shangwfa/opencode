# V2 后台执行（Background Jobs）

> 后台执行让模型的长耗时工具调用（shell 命令、子代理）不阻塞主会话：作业转后台继续跑，
> 主会话立即得到返回并继续工作，完成后自动收到 synthetic 通知（走 inbox 的 synthetic 通道）。
> 实现依据：`packages/core/src/job.ts`（Job 注册表 + KV 持久化 + block 三态竞争）、
> `packages/core/src/tool/plugin/shell.ts`（shell 工具）、`packages/core/src/tool/plugin/subagent.ts`
> + `subagent-job.ts` + `subagent-completion.ts`（子代理后台）、
> `packages/core/src/session.ts:722-741`（用户触发转后台）、
> `packages/core/src/session/execution/restart.ts`（重启恢复）。

## 核心语义（用例断言依据）

| 维度 | 语义 | 代码依据 |
|---|---|---|
| 作业注册 | `jobs.start({run, recovery})`，前台工具 `jobs.block()` 内部 race(done, backgrounded) | `job.ts:303-321` |
| 转后台 | `jobs.background(id)` 解除所有阻塞会话，block 返回 `backgrounded`，工具立即返回后台占位结果 | `job.ts:339-353` |
| **沙箱限制（已修复）** | `sandboxProvider.enabled` 时 shell 工具 `background:true` 走 v1 式 nohup + **detached 独立命令上下文**（不占会话串行队列、会话保活不删除）；立即返回日志文件路径 | `shell.ts`（nohup 包装）；`provider.ts` RunInput.detached |
| subagent 后台 | `background:true` 时 prompt `resume:false` + 立即返回；**无沙箱限制**（子会话复用主会话沙箱） | `subagent.ts:201-234` |
| 后台超时 | 后台 shell 启动超时 10s（nohup 包装命令瞬间返回）；前台默认 DEFAULT_TIMEOUT_MS | `shell.ts` |
| 命令排队预算 | 队列等待下限 **90s**（v1 对齐，`COMMAND_QUEUE_MIN_SECONDS=85`+grace），执行超时永远先于排队预算到期 | `provider.ts`（v2 曾为 timeout+5s，导致探针 10s 命令排队 15s 即失败，已修复） |
| 完成通知 | synthetic 消息进父会话：`<subagent sessionID="..." state="..." description="...">文本</subagent>`，metadata.source=subagent | `subagent-completion.ts:22-43` |
| 用户转后台 | `POST /api/session/:sid/background` 把该会话**前台阻塞**的可后台工具全部转后台 + 注入清单 synthetic（"不要等待/轮询"） | `session.ts:722-741`；protocol:1271 |
| 空闲 no-op | 空闲会话调 background 端点：204、无 synthetic | protocol 描述 "Idle requests are a no-op" |
| 重启恢复（subagent） | running 的后台子代理：prepareResume（有 maxAttempts 预算）→ 重新 start+background 续跑 → 完成通知经 notificationID 幂等送达 | `restart.ts:123-190` |
| 重启恢复（shell） | running 的后台 shell → **cancelled**："Command cancelled because the server restarted"（resume:false 不唤醒） | `restart.ts:90-116` |
| KV 持久化 | 后台作业记录在 kv 表 `job.background/` 前缀；`completeBackground(notificationID)` 完成后清除 | `job.ts:38,181,416` |

**工具名**（V2）：`shell`（不是 bash）、`subagent`（不是 task）。

## SaaS 部署下的实际可用面（2026-10-08 修复后）

我们的部署 `OPENCODE_SANDBOX_ENABLED=true`（每会话一沙箱）：

| 路径 | 可用性 |
|---|---|
| `shell` 工具 `background:true` | ✅ v1 式 nohup + detached 上下文（B1.1 验证：立即返回日志路径，进程真实跑完） |
| `subagent` 工具 `background:true` | ✅ 可用（B2 验证） |
| `POST /api/session/:sid/background` | ✅ 但只影响走 Job.block 的前台工具 → 沙箱部署下实际只有**前台 subagent**（B3 验证；前台 shell 为同步执行无从转后台） |
| 重启恢复 | ✅ subagent 后台作业续跑（B4 验证）；**nohup 后台 shell 随沙箱存亡**（无 KV 记录，沙箱销毁即终止——v1 同语义） |
| 并发 | ✅ 后台命令不占前台队列；前台排队预算 90s（BR2 修复验证：后台 sleep 40 期间 2+3 即时应答、0 超时） |

## HTTP / 工具接口

| 接口 | 语义 |
|---|---|
| `POST /api/session/:sessionID/background` | 无 payload；前台阻塞的可后台工具转后台；success 204；idle no-op |
| 工具 `shell` 参数 `background:true` | 沙箱部署下失败（ToolFailure）；非沙箱：立即返回 + 输出流文件 + 完成通知 |
| 工具 `subagent` 参数 `background:true` | 异步启动子会话，立即返回 `The subagent is working in the background (sessionID: ...)` |
| `GET /api/session/:sid/message?type=synthetic` | 观察完成通知 / 用户转后台清单 |
| `GET /api/session/:sid/event`（SSE） | 过程断言（工具生命周期、synthetic 入队） |

## 前置条件与通用变量

```bash
source docs/test-cases/test-env.sh
export OPENCODE_PASSWORD="${OPENCODE_PASSWORD:-ab123456}"
CURL_AUTH=()
[[ -n "$OPENCODE_PASSWORD" ]] && CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
export SSE_AUTH="Basic $(printf 'opencode:%s' "$OPENCODE_PASSWORD" | base64)"

new_sid() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"bg-t\",\"location\":{\"directory\":\"/workspace\"},\"model\":$V2_MODEL}" | jq -r '.data.id'
}
send() {  # send <sid> <text>
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$1/prompt" \
    -H 'Content-Type: application/json' \
    -d "{\"text\":$(jq -Rn --arg t "$2" '$t'),\"metadata\":{},\"delivery\":\"steer\"}" >/dev/null
}
wait_idle() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" --max-time 240 -X POST "$BASE/api/experimental/session/$1/wait" \
    -H 'Content-Type: application/json' -d '{}' -o /dev/null -w 'wait=%{http_code}\n'
}
synth() {  # 列出 synthetic 通知
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$1/message?type=synthetic&order=asc" \
    | jq -r '.data[] | "[\(.metadata.source // "?")] \(.text[0:120])"'
}
kv_bg() {  # 后台作业 KV 记录
  psql "$PG_URL" -P pager=off -c "SELECT key, value FROM kv WHERE key LIKE 'job.background/%' LIMIT 10;"
}
```

> 提问自动代答与 SSE 实时观察遵循 `docs/test-cases/skills/streaming-output-spec.md`。

---

## B1 沙箱后台 shell（v1 式 nohup，2026-10-08 修复后行为）

### B1.1 `shell` 工具 `background:true`：nohup 启动 + 日志文件 + 进程真实完成

**用户故事**：模型后台跑长命令（dev server、长构建），立即拿回日志文件路径，稍后读取结果。

```bash
sid=$(new_sid)
send "$sid" '用 shell 工具后台运行（background=true）命令：sleep 20 && echo BG-FIXED-DONE。报告：1) 工具返回的原始信息（含输出文件路径） 2) 等待约 25 秒后读取该输出文件，报告内容'
wait_idle "$sid"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | head -15
```

**期望**：
- 过程：`session.tool.success`（无 ToolFailure）；工具输出为 `Command moved to the background.\nOutput is streaming to: /tmp/opencode-bg-<callID>.log`。
- 结果：25 秒后日志文件含 `BG-FIXED-DONE`（nohup 进程真实跑完，退出码 0）。
- 语义：后台命令跑在 **detached 独立命令上下文**（不占会话串行队列；上下文保活不删除——deleteSession 会杀 nohup 进程）；随沙箱存亡，服务重启不中断沙箱时进程继续。
- （历史：修复前为 ToolFailure "not supported for sandboxed sessions"，B1.1 曾断言拒绝行为；2026-10-08 借鉴 v1 runDetached 修复。）

### B1.2 后台不阻塞前台（修复 BR2 的核心断言）

```bash
sid=$(new_sid)
send "$sid" '用 shell 工具后台运行（background=true）：sleep 40 && echo QUEUE-FIX-OK。你只回复：已派发。'
sleep 8
send "$sid" '先别管后台任务，只回答：2+3=?'
wait_idle "$sid"
assistant_text "$sid" | head -3   # 应为：已派发。/ 5
```

**期望**："2+3"回复**及时到达**（不等 sleep 40）；事件流 0 次 `command queue wait` 超时、0 次 `execution.failed`（修复前 BR2 在此场景必现 15s 排队超时失败）。

## B2 subagent 后台执行（saas 可用路径）

### B2.1 `subagent` 工具 `background:true`：立即返回 + 完成通知

**用户故事**：模型把独立的调研任务丢给后台子代理，先回答用户，子代理完成后自动收到结果。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true，agent=general，description=bg-count）执行任务：从 1 数到 5 输出。你立即继续，只回复：已派发。等收到子代理完成通知后，再回复一行：DONE-COUNT。'
# 主回复应很快（不等子代理）
sleep 30
echo "--- 早期 assistant:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant&order=asc" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | head -3
wait_idle "$sid"
echo "--- synthetic 通知:"
synth "$sid"
echo "--- 最终 assistant:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant&order=asc" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | tail -3
```

**期望**：
- 过程：subagent 工具调用快速返回（工具输出含 `working in the background (sessionID:`），主会话先回复"已派发"。
- 结果：父会话出现 `[subagent]` 的 synthetic 通知，格式 `<subagent sessionID="..." state="completed" description="bg-count">` 含子代理输出；最终回复 `DONE-COUNT`。
- PG：完成后 kv 无残留 `job.background/` 记录（completeBackground 已清除）。

### B2.2 前台 subagent 被用户转后台（POST /background）

**用户故事**：模型在前台等一个慢子代理，用户不想等，把阻塞工作转后台拿回控制权。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（前台，不带 background）执行：运行 sleep 60 后输出 SLOW-OK。'
sleep 15   # 等前台 subagent 已阻塞
echo "POST background=$(curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/background" -o /dev/null -w '%{http_code}')"
echo "--- 转后台清单 synthetic:"
synth "$sid"
wait_idle "$sid"
echo "--- 最终回复（应含 SLOW-OK，子代理结果仍送达）:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | grep -m2 -E 'SLOW-OK|background'
```

**期望**：
- POST 204；父会话出现 `[?]` synthetic 清单（含 "User requested that active blocking work be moved to the background" 与 `- subagent: <description>` 行）。
- 阻塞中的 subagent 工具返回 backgroundResult（`working in the background`）；子代理完成后通知送达、最终回复含 `SLOW-OK`。

### B2.3 空闲会话 POST background：no-op

```bash
sid=$(new_sid)
echo "code=$(curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/background" -o /dev/null -w '%{http_code}')"
echo "synthetic数=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq '.data | length')"
```

**期望**：204；synthetic 0 条（idle no-op，不注入清单）。

## B4 重启恢复（subagent 后台续跑）

### B4.1 后台 subagent 运行中重启 → 续跑 + 通知幂等送达

**用户故事**：后台子代理跑长任务时 SaaS 发版重启，子代理应续跑，父会话最终仍收到一次完成通知。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true，description=restart-bg）执行：运行 sleep 45 后输出 RESTART-BG-OK。你只回复：已派发。'
sleep 20   # 子代理已在跑
echo "[重启前] kv:"; kv_bg | head -5
docker restart opencode-saas-test >/dev/null; sleep 20
export OPENCODE_PASSWORD=ab123456
wait_idle "$sid"
echo "--- synthetic 通知（应恰一条 restart-bg 完成通知）:"
synth "$sid"
echo "--- 通知条数: $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq '[.data[] | select((.text // "") | contains("RESTART-BG-OK"))] | length')"
echo "--- 子代理最终输出送达: $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq -r '.data[].text' | grep -c 'RESTART-BG-OK')"
```

**期望**：
- 重启前 kv 有 `job.background/` 记录（recovery.kind=subagent、status=running）。
- 重启后：子代理被 resume 续跑；父会话收到**恰一条**含 `RESTART-BG-OK` 的完成通知（notificationID 幂等，不重复）。
- 结束后 kv 无残留。

> 重启恢复的 shell 分支（cancelled 通知）在沙箱部署下不可达（无后台 shell），不设用例；
> 子代理恢复预算（RESUME_EXHAUSTED）属于中断专项。

---

## BR 真实用户场景（E2E 组合）

> 单点用例验证契约；本组按真实用户行为模式组合操作。沙箱部署下可用面：
> subagent 后台 + 用户转后台 + 重启恢复（见"实际可用面"表）。

### BR1 并行派发：多个后台子代理同时干独立活

**用户故事**：让 AI 同时调研三个独立问题——它派三个后台子代理并行跑，先回复我"已派发"，全部完成后逐个汇报。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true）并行派发 3 个后台任务：agent=general，description 分别为 par-a/par-b/par-c，任务分别为：只输出 LETTER-A / 只输出 LETTER-B / 只输出 LETTER-C。派发后你只回复：三路已派发。收到全部完成通知后，最后一行输出：ALL-3-DONE。'
sleep 25
echo "[早期] 主回复（应已出现且不含 LETTER）:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant&order=asc" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | head -3
wait_idle "$sid"
echo "[最终] synthetic 通知:"
synth "$sid"
echo "[最终] ALL-3-DONE=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" | jq -r '.data[].content[]? | select(.type=="text") | .text' | grep -c 'ALL-3-DONE')"
echo "[最终] 三路结果各到一次:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq -r '.data[].text' | grep -oE 'LETTER-[ABC]' | sort | uniq -c
```

**期望**：
- 过程：主回复"三路已派发"先于三份通知出现（派发即返回，不等待）。
- 结果：三条 `[subagent]` synthetic 通知（state=completed），LETTER-A/B/C 各恰一次；最终回复含 `ALL-3-DONE`。
- PG：kv 无 `job.background/` 残留。

### BR2 派后台后用户马上继续聊（不阻塞）

**用户故事**：我让 AI 后台跑个慢任务，转头就问它别的问题——它必须立刻能答，慢任务完成后自动汇报。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true，description=slow-bg）执行：运行 sleep 40 后输出 SLOW-RESULT。你只回复：已派发。'
sleep 8
# 用户马上问别的问题（第二条 steer，不等待后台）
send "$sid" '先别管后台任务，只回答：2+3=?'
wait_idle "$sid"
echo "[对话] assistant 回复顺序:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant&order=asc" \
  | jq -r '.data[].content[]? | select(.type=="text") | .text' | head -4
echo "[通知] SLOW-RESULT 送达: $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq -r '.data[].text' | grep -c 'SLOW-RESULT')"
```

**期望**："2+3=5" 的回复**不等待** sleep 40 完成（先出现）；后台完成后 synthetic 通知含 `SLOW-RESULT` 恰一条。这同时验证 synthetic 通知经 inbox 在空闲边界投递（与 inbox R2 同构）。

> **实测警示（2026-10-08，已修复）**：修复前共享沙箱下"后台长命令 + 主会话并发执行"会触发
> `execution.failed: command queue wait timed out after 15s`（排队预算曾为执行超时+5s，探针 10s 命令仅 15s 预算）。
> **修复**（v1 借鉴）：① 后台命令改走 detached 独立上下文不占队列；② 排队预算下限 90s
> （`COMMAND_QUEUE_MIN_SECONDS`，`provider.ts`）。修复后 B1.2 复测通过：0 超时、0 失败、及时应答。

### BR3 前台等不及，转后台拿回控制权（完整流）

**用户故事**：AI 在前台等一个 60 秒的慢子代理，我等不了——一键转后台，马上继续问问题，最后照样拿到结果。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（前台，不带 background）执行：运行 sleep 60 后输出 SLOW-FOK。'
sleep 15   # 前台 subagent 已阻塞
echo "POST background=$(curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/background" -o /dev/null -w '%{http_code}')"
send "$sid" '现在只回答：CONTROL-BACK'
wait_idle "$sid"
echo "[清单] 转后台 synthetic:"
synth "$sid" | grep -m1 'requested'
echo "[对话] CONTROL-BACK 回复: $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" | jq -r '.data[].content[]? | select(.type=="text") | .text' | grep -c 'CONTROL-BACK')"
echo "[结果] SLOW-FOK 送达: $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq -r '.data[].text' | grep -c 'SLOW-FOK')"
```

**期望**：转后台后 `CONTROL-BACK` 立即可答（不等 sleep 60）；清单 synthetic 出现（"User requested..."）；子代理完成后 `SLOW-FOK` 通知恰一条（结果不丢）。
（实测：`wait_idle` 只等主会话空闲，不等后台作业——通知在 sleep 60 跑完后约 45s 才到达，wait 后需补等待再断言。）

### BR4 发版窗口：后台任务不丢、通知不重复

**用户故事**：后台子代理跑长任务时 SaaS 发版重启——任务要续跑完成，我只收到**一次**结果通知。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true，description=release-bg）执行：运行 sleep 50 后输出 RELEASE-OK。你只回复：已派发。'
sleep 20
echo "[重启前] kv: $(psql "$PG_URL" -At -c "SELECT count(*) FROM kv WHERE key LIKE 'job.background/%';") 条"
docker restart opencode-saas-test >/dev/null; sleep 20
export OPENCODE_PASSWORD=ab123456
wait_idle "$sid"
echo "[重启后] RELEASE-OK 通知条数（应恰1）: $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq '[.data[] | select((.text // "") | contains("RELEASE-OK"))] | length')"
echo "[重启后] kv 残留: $(psql "$PG_URL" -At -c "SELECT count(*) FROM kv WHERE key LIKE 'job.background/%';") 条"
```

**期望**：重启前 kv 有 running 记录；重启后子代理 resume 续跑，`RELEASE-OK` 通知**恰一条**（notificationID 幂等）；kv 清空。
（实测：恢复全程约 1 分钟——重启 20s + resume + 子代理收尾；重启后 wait_idle + 补 sleep 30 再断言，勿过早判失败。）

### BR4 附：子会话 ID 获取方式

子会话创建事件**不在**父会话事件流中；从 PG 拿（BR7 同法）：

```bash
child=$(psql "$PG_URL" -At -c "SELECT id FROM session_v2 WHERE parent_id='$sid' ORDER BY time_created DESC LIMIT 1;")
```

### BR5 后台失败也要知情（error 通知路径）

**用户故事**：后台任务失败了不能石沉大海——AI 要收到失败通知并告诉我。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true，description=fail-bg）执行任务：运行命令 exit 7（必然失败）。你只回复：已派发。收到完成或失败通知后，报告通知里的 state 与命令结果。'
wait_idle "$sid"
echo "[通知] state 分布:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq -r '.data[].text' | grep -oE 'state="[a-z]+"' | sort | uniq -c
echo "[对话] 最终报告:"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=assistant" | jq -r '.data[].content[]? | select(.type=="text") | .text' | tail -5
```

**期望**：出现 `state="error"`（或含退出码/失败信息的 completed 语义，以实测为准记录）的 synthetic 通知；模型最终报告失败情况。**注意**：state 的实际取值以子代理执行语义为准（子代理跑完 exit 7 是子会话内的成功工具调用，父侧 state 可能仍为 completed 但输出含错误信息）——本用例沉淀真实行为。

> **实测沉淀（2026-10-08）**：子代理跑 `exit 7` → 父侧通知 `state="completed"`，内容含
> 退出码详情（"Command run: exit 7, Exit code: 7"），模型正确汇报失败。**`state="error"` 仅当子会话
> 执行本身失败**（异常中断/预算耗尽），命令级失败属于 completed + 输出描述。

### BR6 打断主会话，后台任务不受牵连

**用户故事**：AI 主会话跑偏被我打断，但之前派的后台任务应该继续跑完并通知我。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true，description=survive-bg）执行：运行 sleep 45 后输出 SURVIVE-OK。你只回复：已派发。'
sleep 8
send "$sid" '现在进入一个长循环：反复运行 sleep 10 共 30 次。'   # 制造可打断的主会话执行
sleep 10
echo "interrupt=$(curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/interrupt" -H 'Content-Type: application/json' -d '{"reason":"user"}' -o /dev/null -w '%{http_code}')"
wait_idle "$sid"
sleep 20   # 给后台子代理完成时间
echo "[通知] SURVIVE-OK 送达: $(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$sid/message?type=synthetic" | jq -r '.data[].text' | grep -c 'SURVIVE-OK')"
```

**期望**：interrupt 200、主会话执行被打断（`session.execution.interrupted reason=user`）；后台子代理**不受牵连**继续跑完，`SURVIVE-OK` 通知最终送达（interrupt 作用于主会话 drain，不触碰已转后台的作业）。

### BR7 删会话连带清理后台子代理

**用户故事**：我不想要这个会话了，直接删除——它派出的后台子代理也要一并清理，不留孤儿任务。

```bash
sid=$(new_sid)
send "$sid" '用 subagent 工具（background=true，description=cleanup-bg）执行：运行 sleep 40 后输出 CLEANUP-OK。你只回复：已派发。'
sleep 12   # 等子会话落库
child=$(psql "$PG_URL" -At -c "SELECT id FROM session_v2 WHERE parent_id='$sid' ORDER BY time_created DESC LIMIT 1;")
echo "child=$child"
for i in 1 2 3; do
  code=$(curl -sS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$sid" -o /dev/null -w '%{http_code}')
  echo "第${i}次删除: $code"; [[ "$code" == "204" ]] && break; sleep 5
done
echo "[清理] 子会话已删: $(curl -sS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$child" -o /dev/null -w '%{http_code}')（应404）"
echo "[清理] kv 残留: $(psql "$PG_URL" -At -c "SELECT count(*) FROM kv WHERE key LIKE 'job.background/%';") 条"
echo "[清理] 子会话 inbox 残留: $(psql "$PG_URL" -At -c "SELECT count(*) FROM session_inbox WHERE session_id='$child';") 行"
echo "[清理] 子会话消息残留: $(psql "$PG_URL" -At -c "SELECT count(*) FROM session_message WHERE session_id='$child';") 行"
```

**期望**：删除 204（沙箱清理中首次可能 409，重试）；子会话 404；kv 无该作业残留；子会话 inbox 清空（`session.remove` 对 children 依次 close + interrupt + awaitIdle + 释放工具，不销毁共享沙箱）。

## 覆盖矩阵

| 代码路径 / 行为 | 用例 |
|---|---|
| 沙箱 shell background：nohup + detached 上下文 + 日志文件 + 进程真实完成 | B1.1 |
| 后台不占前台队列（排队超时修复验证） | B1.2、BR2 |
| subagent background：立即返回 + synthetic 完成通知 | B2.1 |
| 用户 POST /background：block→backgrounded + 清单注入 | B2.2 |
| 空闲 no-op | B2.3 |
| 重启恢复：KV 恢复 + resume + notificationID 幂等 | B4.1 |
| 多后台作业并行 + 各自通知恰一次 | BR1 |
| 后台不阻塞用户新对话（synthetic 经 inbox 空闲边界投递） | BR2 |
| 转后台拿回控制权完整流（清单 + 继续对话 + 结果送达） | BR3 |
| 发版重启：任务续跑 + 通知不重复（notificationID 幂等真实化） | BR4 |
| 后台失败通知路径（state 语义以实测沉淀） | BR5 |
| interrupt 主会话不牵连后台作业 | BR6 |
| 删父会话级联清理子会话与作业（close/interrupt/awaitIdle） | BR7 |

## 已知边界（不在本专项断言，避免误判）

- **沙箱后台 shell 的存续边界（B1 修复后语义）**：nohup 后台命令随**沙箱**存亡（无 KV 作业记录）：服务重启但沙箱仍在（keepAlive/snapshot）时进程继续；沙箱销毁/回收时终止且无通知（v1 同语义，输出留在日志文件）。需要跨重启通知的后台工作仍应使用 subagent 后台（B4）。
- **`POST /background` 的作用面**：只转"走 Job.block 的前台工具"；沙箱部署下即前台 subagent。对前台 shell（同步 sandboxProvider.run）无效——用例中不对其做转后台断言。
- **恢复预算**：subagent 重启 resume 有 maxAttempts 上限（RESUME_EXHAUSTED），多次崩溃场景归中断专项。
- **CodeMode 并发**：CodeMode 子代理共享 tool-call ID 但各 shell 独立 job（`shell.ts` 注释），组合行为归 code-mode 专项。
- **watchdog**：本地环境长任务约 3 分钟被 watchdog 中断；B2.2/B4.1 的 sleep 时长已控制在预算内，复跑时勿加大。
- **通知 state 语义（BR5 实测）**：命令级失败（如 exit 7）是子会话成功执行的一部分，父侧通知 `state="completed"` + 输出含错误详情；`state="error"` 仅当子会话执行本身失败。
- **detached 上下文回收**：后台命令的专属命令上下文不删除（deleteSession 会杀 nohup 进程），由沙箱销毁统一回收；高频后台命令会产生上下文积累，观察 `detached command context kept` 日志（debug 级）。

## 执行记录

- **2026-10-08（首次）**：BR1-BR7 通过；BR2 暴露排队超时（时为已知边界）。
- **2026-10-08（v1 借鉴修复后）**：B1.1 新行为通过（nohup 后台真实完成）；B1.2/BR2 复测通过
  （后台不占队列、排队预算 90s、0 超时 0 失败）。修复内容：`provider.ts`
  （RunInput.detached、排队预算下限、队列等待日志）、`shell.ts`（沙箱 background 走 nohup+detached）。
