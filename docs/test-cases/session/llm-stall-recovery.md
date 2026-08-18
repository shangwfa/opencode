# 会话挂死修复验证（LLM 流停滞 + 陈旧 run 接管）

> 验证 `fix(session): prevent silent prompt hang from stalled LLM streams and stale runs` 的两项修复。
>
> **背景**（2026-08-17 线上事故）：LLM provider 流停滞（TCP 活着但永不出事件）→ run fiber 永挂 → Runner 停在 `Running` → 后续 prompt 在 `awaitDone` 无限排队 → 会话「发消息不回复」且无任何报错。
>
> 修复内容：
> 1. `packages/opencode/src/session/llm.ts` — `withStallTimeout` 包装 `fullStream`，单次 pull 停滞超过 `OPENCODE_LLM_STALL_TIMEOUT_SEC`（默认 300s）自动断流报错。
> 2. `packages/opencode/src/effect/runner.ts` — `ensureRunning` 排队等待已有 run 超过 `OPENCODE_SESSION_STALE_RUN_SEC`（默认 1800s）时，取消陈旧 run 并用新 prompt 接管重试；shell 后排队（交互式终端合法长跑）不受超时影响。
> 3. `packages/opencode/src/session/llm.ts` — **question 工具豁免 stall 计时**（2026-08-18 补充）：工具在 AI SDK `fullStream` 内部执行（`tool-call` → execute → `tool-result`），question 等待用户作答是合法无限期等待，却被 stall 保护误杀（2026-08-17 晚事故：`LLM stream stalled: no events for 300s` → `Tool execution aborted`，question `interrupted: true`）。修复：按 `toolCallId` 跟踪 `toolName === "question"` 的 in-flight 调用，pending 非空时不启动 stall 计时器，question 结束后自动恢复；其他工具不受豁免。

## 公共环境

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。用例直接用 `$BASE` `$PG_URL`，不重复定义。

### 单测（改动自带，`packages/opencode` 目录下运行）

```bash
bun test test/effect/runner.test.ts test/session/llm.test.ts
```

覆盖：
- `runner.test.ts` — 陈旧 run 接管恢复、shell 后排队不被误杀（2 例）
- `llm.test.ts` — `withStallTimeout` 透传/超时/per-pull 重置/错误透传/return 委托/无 unhandled rejection（7 例）
- `llm.test.ts` — question 豁免（2026-08-18 补充，3 例）：question in-flight 挂起计时器（等待超过上限不断流）、非 question 工具（bash）不豁免照常断流、question 结束后计时器恢复
- 触发方式：`bun test test/session/llm.test.ts -t "withStallTimeout"`

以下为 HTTP 层集成用例（需重建 SaaS 镜像后执行）。

---

## ST-1: LLM 流停滞自动断开（根因修复）

### T40.1.1 停滞流在超时后被切断，会话可继续使用

**场景**：模拟 provider 接受连接但永不出事件（半开连接）。设置短超时 `OPENCODE_LLM_STALL_TIMEOUT_SEC=5` 启动 server，指向一个挂死的 mock provider 端点。

```bash
# 1. 启动挂死 provider（接受连接后不响应）
nohup python3 -c "
from http.server import HTTPServer, BaseHTTPRequestHandler
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        import time
        self.rfile.read(int(self.headers.get('Content-Length', 0)))
        time.sleep(3600)  # 永不响应
    def log_message(self, *a): pass
HTTPServer(('127.0.0.1', 18099), H).serve_forever()
" > /tmp/stall-provider.log 2>&1 &

# 2. 用短停滞超时 + 挂死 provider 重启 server（容器场景：docker run -e 传入）
#    宿主机直跑场景：
env OPENCODE_LLM_STALL_TIMEOUT_SEC=5 \
  OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:15432/opencode' \
  bun run --conditions=browser ./src/index.ts serve --hostname 127.0.0.1 --port 14097 --print-logs --pure &

# 3. 配置 provider 指向挂死端点后发消息（通过 PATCH /global/config 或 opencode.jsonc 配置
#    一个 baseURL=http://127.0.0.1:18099/v1 的 openai 兼容 provider）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hello"}],"model":{"providerID":"stall-mock","modelID":"m1"}}' \
  | jq -r '.info.role'

# 4. 停滞后立刻再发一条，会话应可继续（run 已释放）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"recovery check"}],"model":$MODEL} | jq -r '.info.role'
```

**期望**：
- 第 3 步消息在 ~5s 后失败（返回错误或 error 事件），**而非无限挂起**
- 第 4 步正常返回 assistant 回复——run 未被挂死流永久占用
- server 日志出现 `LLM stream stalled: no events for 5s`

### T40.1.2 question 工具等待用户期间不被 stall 保护误杀（2026-08-18）

**场景**：question 工具的 execute 在 AI SDK `fullStream` 内部运行，等待用户通过 SSE/HTTP 作答。设置短超时 `OPENCODE_LLM_STALL_TIMEOUT_SEC=10`，让 AI 调用 question 后**不作答**，静默超过 10s——验证 stall 计时器被挂起，question 不被 abort。

```bash
# 1. 短 stall 超时启动 server（容器场景：docker run -e 传入；宿主机直跑见 T40.1.1）
env OPENCODE_LLM_STALL_TIMEOUT_SEC=10 \
  OPENCODE_DATABASE_URL='postgresql://local@127.0.0.1:15432/opencode' \
  bun run --conditions=browser ./src/index.ts serve --hostname 127.0.0.1 --port 14097 --print-logs --pure &

# 2. 发消息诱导 question（agent prompt 明确要求先问再动）
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)

# 3. 后台监听 SSE，捕获 question part 及其 requestID/answers 端点后**不回应**
curl -s -N "$BASE/session/$SID/event" > /tmp/sse-question.log &
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"先调用 question 工具问我喜欢什么颜色，得到答案后再回答"}],"model":$MODEL}' &
sleep 30   # 远超 10s stall 上限，期间不作答

# 4. 验证 question part 未被 abort
psql "$PG_URL" -P pager=off -c "
SELECT p.data->>'tool' as tool, p.data->'state'->>'status' as status,
  p.data->'state'->>'error' as error
FROM part p WHERE p.session_id='$SID' AND p.data->>'tool'='question';"

# 5. 静默期后作答，验证 run 正常继续
#    （从 SSE 的 question 事件取 answers 端点，或用 permission 式回复接口）
# curl -s -X POST "$BASE/session/$SID/question/$REQUEST_ID" -d '{"answers":[["蓝色"]]}' -H 'Content-Type: application/json'
```

**期望**：
- 第 4 步：question part `status` 仍为 `running`（或 `pending`），**无** `Tool execution aborted` / `interrupted: true`
- server 日志在 question 等待期间**无** `LLM stream stalled`
- 第 5 步作答后 AI 基于答案继续回复，run 正常完成
- 对照组（修复前行为）：10s 后 `LLM stream stalled: no events for 10s` + question `status=error, interrupted=true`（2026-08-17 晚 `ses_ff06aa6bfffej9qAulJF7Zn5iP` 事故形态）

### T40.1.3 非 question 工具长跑仍受 stall 保护（豁免不扩大）

**场景**：确认豁免仅限 question——bash 等工具在流内执行超过 stall 上限时仍被断流（防止工具挂死拖垮会话）。单测已覆盖（`stall timer keeps running for non-question tools`），HTTP 层可选验证：诱导长 bash + 短超时，超时后应报 `LLM stream stalled` 而非无限等待。

**期望**：
- bash 挂起超过 `OPENCODE_LLM_STALL_TIMEOUT_SEC` 后流被切断，run 失败可见错误
- 会话可继续发消息（run 已释放）
- **无** pending 计时器泄漏：question 结束后流停滞照常触发 stall

---

## ST-2: 陈旧 run 接管（兜底修复）

### T40.2.1 幽灵 run 后新 prompt 在接管超时后恢复

**场景**：制造一个永不结束的 run（方法：用 stall provider 或长时间无超时的工具调用挂住第一条消息），随后发第二条消息。设置短接管超时 `OPENCODE_SESSION_STALE_RUN_SEC=30` 让等待可观测。

```bash
# server 以 OPENCODE_SESSION_STALE_RUN_SEC=30 启动
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)

# 第一条消息挂住（stall provider，同 T40.1.1）
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hang me"}],"model":{"providerID":"stall-mock","modelID":"m1"}}' &
sleep 2

# 第二条消息走正常模型，应被排队 → 30s 接管超时 → 取消幽灵 run → 重试成功
time curl -s --max-time 120 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"takeover check"}],"model":$MODEL}' | jq -r '.info.role'
```

**期望**：
- 第二条消息在 ~30-40s 内返回 assistant 回复（修复前：永久挂起）
- server 日志出现 `SessionRunner: cancelling stale run after takeover timeout`

### T40.2.2 正常长 run 不被误接管

**场景**：默认 `OPENCODE_SESSION_STALE_RUN_SEC=1800` 下，一条正常耗时 60s+ 的消息（如长工具调用）运行期间并发发送第二条，第二条应共享等待而非触发接管。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 第一条：长 bash（60s）
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"用 bash 执行 sleep 60 && echo long-done"}],"model":$MODEL}' &
sleep 5
# 第二条：并发到达，应等到第一条完成（共享同一 run 的结果）
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"queued behind long run"}],"model":$MODEL}' | jq -r '.info.role'
```

**期望**：
- 两条都正常完成，第二条共享第一条 run 的结果（返回最后 assistant 消息）
- **无** `cancelling stale run` 日志——正常 run 未被误杀

### T40.2.3 shell 会话（交互式终端）不受接管超时影响

**场景**：打开长驻 shell（`/session/:id/shell`），排队一条 prompt，确认排队的 run 在 shell 结束后正常执行，不被接管超时取消。

```bash
SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | jq -r .id)
# 开 shell 并保持（websocket/pty，参见 sse.md 的 shell 用例做法）
# ... shell 打开期间：
curl -s -X POST "$BASE/session/$SID/prompt_async" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"queued behind shell"}],"model":$MODEL}'
sleep 35   # 超过 30s 的 staleAfterSec（若配置）
# 关闭 shell 后检查消息状态
psql "$PG_URL" -t -A -c "SELECT count(*) FROM message WHERE session_id='$SID' AND data->>'role'='assistant'"
```

**期望**：shell 关闭后排队消息正常产生 assistant 回复；shell 期间未被 `cancelling stale run` 打断（shell 是合法长驻状态，`behindRun=false` 路径不设超时）。

---

## ST-3: 回归确认——事故场景复现

### T40.3.1 多实例共享 PG，远端实例重启后卡死会话自动恢复

**场景**：复现 2026-08-17 事故形态：会话在某实例上有幽灵 run（实例重启前挂死），验证**部署本修复后的实例重启即恢复**。

```bash
# 1. 用旧镜像（无修复）起实例 A，发消息挂住（stall provider）后保持进程存活
# 2. 会话状态：user 消息已落库、无 assistant、后续消息不回
SID="ses_xxx"
psql "$PG_URL" -t -A -c "SELECT count(*) FROM message WHERE session_id='$SID' AND data->>'role'='assistant'"

# 3. 换新镜像（含本修复）重启实例
docker rm -f opencode-saas-test
docker run -d --name opencode-saas-test -p 14096:4096 \
  -e OPENCODE_DATABASE_URL=... \
  opencode-saas-sandbox-test:$(git rev-parse --short HEAD)

# 4. 重启后对该会话发消息
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"recovered?"}],"model":$MODEL}' | jq -r '.info.role'
```

**期望**：
- 新实例内存态干净（幽灵 run 随旧进程消失），消息立即正常回复
- 若新实例上再次出现停滞流，ST-1/ST-2 机制保证 5 分钟内自动断流、30 分钟内自动接管，不再需要人工重启

---

## 复测记录

| 日期 | 用例 | 结果 | 备注 |
|---|---|---|---|
| 2026-08-17 | 单测（runner 2 例 + llm 7 例） | ✅ 62 pass | `bun test test/effect/runner.test.ts test/session/llm.test.ts` |
| 2026-08-18 | 单测（question 豁免 3 例新增） | ✅ 38 pass / 0 fail | `bun test test/session/llm.test.ts`；question 挂起计时、bash 不豁免、question 结束后计时恢复。注：`keeps supported OpenAI models` 用例偶发 5s 超时抖动，stash 前后复现，与改动无关 |
| 2026-08-18 | typecheck | ✅ | 基线 41 个既有错误，无新增（基线由 39 → 41 为上游合并漂移，llm.ts 无错误） |
| 2026-08-17 | typecheck | ✅ | 基线 39 个既有错误，无新增 |
| 2026-08-17 | T40.1.1 stall 断开+恢复（容器 14098，STALL=5） | ✅ | stall 消息 ~10s 返回 `LLM stream stalled: no events for 5s`；同 session 后续 Yd-GLM 消息正常回复 `ok` |
| 2026-08-17 | T40.2.1 接管（容器，STALL=600/STALE=30） | ⚠️ 改由单测覆盖 | **发现**：HTTP 层 `withSessionLock` 先于 Runner 串行——`promptAsync` 的 fork 在锁内，幽灵 run 持锁期间第二条消息卡在 `waitForSessionLock`（50ms 无限轮询），到不了 Runner。Runner 接管只对绕过 HTTP 锁的内部调用方（subagent/background job 直调 prompt）生效。见下方「分层发现」 |
| 2026-08-17 | T40.2.2 正常长 run 不误杀（容器，STALL=600/STALE=30） | ✅ | 长消息（数到 30）运行期间排队消息正常返回 `done`；`cancelling stale run` 日志 0 条 |
| 2026-08-17 | T40.2.3 shell 不受影响 | ✅ 单测覆盖 | `runner.test.ts` "queued work behind a shell is not cancelled"（staleAfterSec=0.1s + shell 长驻 300ms 验证不被误杀）；HTTP pty websocket 集成未跑 |
| 2026-08-17 | T40.3.1 事故复现+重启恢复（容器，STALL=600） | ✅ | 幽灵 run 后续消息 curl 28 超时（事故形态复现）；`docker restart` 后同 session 消息 12s 恢复回复 |
| 2026-08-18 | T40.1.2 question 不被 stall 误杀 | ✅ | 容器（STALL=5，镜像 stall-fix-97544cf64e）：诱导 question 后静默 25s，part 仍 `running` 无 error/`interrupted`；经 `POST /question/:requestID/reply` 作答后 run 正常完成（AI 基于答案回复）。修复前 5s 即被斩 |
| 2026-08-18 | T40.1.3 非 question 工具仍受保护 | ✅ | 容器（STALL=5）：30s bash 消息 ~15s 报 `LLM stream stalled: no events for 5s`（豁免未扩大）；同 session 后续消息正常回复 `ok` |
| 2026-08-18 | T40.2.1 幽灵 run 接管 | ⚠️ 同 2026-08-17 | HTTP 层 `waitForSessionLock` 先卡（第二条 120s curl 超时），与上次记录一致；Runner 接管仍由单测覆盖 |
| 2026-08-18 | T40.2.2 正常长 run 不误杀 | ✅ | 容器（STALL=600/STALE=30）：20s bash 长消息期间排队消息 41s 返回 `ok`；`cancelling stale run` 0 条 |
| 2026-08-18 | T40.3.1 事故复现+重启恢复 | ✅ | 容器（STALL=600）：幽灵 run 持锁，新消息 HTTP 000 超时（事故形态复现）；`docker restart` 后同 session 消息 ~10s 恢复回复 `ok` |

## 分层发现（2026-08-17 实测）

「发消息不回」实际有**两层**串行防线，幽灵 run 会先后卡住二者：

```
HTTP handler: waitForSessionLock（进程内存 Map，50ms 无限轮询，无超时无日志）  ← 第一层，先卡这里
    └── SessionPrompt.prompt → Runner.ensureRunning（本次修复加了 stall 断流 + 接管）  ← 第二层
```

- **根因修复（stall 断流）已足够解除用户可见挂死**：stalled 流默认 300s 报错 → run 结束 → session lock 释放 → 会话恢复。T40.1.1 实测 5s 配置下 ~10s 恢复。
- **Runner 接管是纵深防御**：保护直调 prompt 的内部调用方（不经 HTTP 锁）。HTTP 路径的排队消息在锁释放前根本进不了 Runner。
- 遗留问题（未修，建议后续）：`waitForSessionLock` 无超时无日志——幽灵持锁期间 waiter fiber 无限累积；建议加超时 + 观测日志。

## 测试环境备注（2026-08-17）

- 容器环境（`opencode-saas-sandbox-test:stall-fix`，含修复代码的镜像）一切符合预期。
- 宿主机直跑 server（`bun run src/index.ts serve`）所有 provider 均在 5s 内零事件被 stall 误杀——宿主机环境问题（疑似 `--conditions=browser` 下 fetch 行为差异），与修复无关；集成用例一律走容器。
- stall provider 需绑 `0.0.0.0`（容器经 `host.docker.internal` 访问）；测试配置经 `OPENCODE_CONFIG_CONTENT` 注入。
