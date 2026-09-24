# 结构化输出（V2 Structured Output / format json_schema）

> 本文按当前 V2 HTTP API 重写。V1 原文（`POST /session/:id/message`、`prompt_async`、`parts[]`、`info.structured`）保留在 git 历史。
>
> **接口范围**：`format` 仅 `PromptInput` 携带，即 `POST /api/session/:id/prompt`、`POST /api/session/:id/prompt_stream`；`command` / `shell` 端点的输入 schema 无 `format`，**不支持**结构化输出（代码确认 `CommandInput`/`ShellInput`）。
>
> 用法：请求体带 `format: {"type":"json_schema","schema":<JSON Schema>,"retryCount"?:2}`。结果落在 assistant 消息的 `structured` 字段（V2 是顶层字段，不再是 V1 的 `info.structured`）。
> `format: {"type":"text"}` 或不传 `format` 为普通文本模式。

## V1 → V2 契约变化

| 维度 | V1 | V2 |
|---|---|---|
| 发送消息 | `POST /session/:id/message`（同步）/ `prompt_async` | `POST /api/session/:id/prompt`（异步接纳）+ `POST /api/experimental/session/:id/wait` |
| 跟随回合 | `POST /session/:id/prompt_stream` | 同名，路径为 `/api/session/:id/prompt_stream` |
| 结果字段 | `info.structured` | assistant 消息顶层 `structured` |
| 读回字段 | `info.format` | user 消息顶层 `format` |
| 工具名 | `StructuredOutput` | `StructuredOutput`（对齐 V1） |
| 强制手段 | `toolChoice: "required"` + system prompt | 相同（对齐 V1，见下方"实现要点"） |
| 失败错误 | `StructuredOutputError` | `provider.invalid-output`（V1 迁移映射：`v1-migration.bun.ts:950`） |
| `retryCount` | 带字段但未实现（`retries: 0`） | 带字段但未实现（恒为 0） |

**Schema 写法的差异**：V1 的 `OutputFormat` 是 `Schema.Class` union，HTTP 响应 encode 只接受类实例，因此带 `format` 的消息落库后 `GET` 会 400（`Expected OutputFormatJsonSchema`）。V2 的 `OutputFormat` 是 `Schema.Struct` union，普通存储对象可直接 encode，从根上消除了该 400。

## 实现要点（与 V1 对齐）

V2 走"提示词定向 + mode 强制"，**不使用 named `tool_choice`**：

1. `format.type === "json_schema"` 时，runner 注入 `StructuredOutput` 工具（`inputSchema` = 调用方的 JSON Schema，剔除 `$schema`），`execute` 直接回传入参；
2. `toolChoice: "required"`（**mode 形式**）—— provider 在 thinking 模式下会拒绝 named `tool_choice` 对象（实测 DeepSeek 返回 `Thinking mode does not support this tool_choice`），mode 形式被放行；
3. 因为 `required` 只保证"调某个工具"，同时追加 system prompt 定向到 `StructuredOutput`：
   > `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool …`
4. 工具入参在 `session.tool.called` 时投影到 `Assistant.structured`；工具失败则记 `provider.invalid-output`。

**与 V1 的一处行为差异**：V2 是 agent loop，结构化工具之后模型仍会基于结果产出一条普通文本消息。所以 `structured` 在**带 `StructuredOutput` 调用的那条** assistant 消息上，其后可能还有一条 `structured` 为空的文本消息。V1 会在工具命中后立即 `break` 回合。读回时按"找带 `structured` 的消息"，不要按下标取最后一条。

## 前置条件与通用变量

```bash
export BASE="${BASE:-http://localhost:14096}"
MODEL='{"id":"deepseek-v4-flash","providerID":"Yd-DeepSeek"}'
CURL_AUTH=()
if [[ -n "${OPENCODE_PASSWORD:-}" ]]; then
  CURL_AUTH=(-u "opencode:${OPENCODE_PASSWORD}")
fi

new_sid() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session" \
    -H 'Content-Type: application/json' \
    -d "{\"title\":\"tso\",\"location\":{\"directory\":\"/workspace\"},\"model\":$MODEL}" | jq -r '.data.id'
}
# 异步接纳 + 等待回合结束
send_prompt() {
  local sid="$1" text="$2" format_json="${3:-null}"
  jq -n --arg text "$text" --argjson fmt "$format_json" \
    '{text:$text,metadata:{},delivery:"queue",format:$fmt}' \
    | curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/session/$sid/prompt" \
        -H 'Content-Type: application/json' --data-binary @- >/dev/null
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/experimental/session/$sid/wait" \
    -H 'Content-Type: application/json' -d '{}' --max-time 300
}
# 取带 structured 的 assistant 消息（V2 可能在其后追加一条纯文本消息）
get_structured() {
  curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$1/message?order=asc&limit=100" \
    | jq -c '[.data[] | select(.type=="assistant" and .structured != null)][0].structured'
}
```

## TSO.1 同步接口：format 透传与 structured 结果

```bash
SID=$(new_sid)
send_prompt "$SID" "北京是中国的首都吗？" \
  '{"type":"json_schema","schema":{"type":"object","properties":{"answer":{"type":"boolean"},"city":{"type":"string"}},"required":["answer","city"]}}'
get_structured "$SID"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" >/dev/null
```
**期望**：`{"answer":true,"city":"北京"}`（值由模型生成，结构含全部 `required` 字段）。

## TSO.2 消息回读：format/structured 经 GET 完整返回（列表 + 单条）

> TSO.1 的会话保留后再验证。修复回归用例：V1 修复前列表 400（`Expected OutputFormatJsonSchema ... at [0]["info"]["format"]`）。

```bash
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/message?order=asc&limit=100" \
  | jq -c '{list_user_format:[.data[]|select(.type=="user")][0].format.type}'
MID=$(curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/message?order=asc&limit=100" \
  | jq -r '[.data[]|select(.type=="user")][0].id')
curl -sS -o /dev/null -w "single GET %{http_code}\n" "${CURL_AUTH[@]}" "$BASE/api/session/$SID/message/$MID" \
  && curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/message/$MID" | jq -c '.data.format.type'
```
**期望**：列表与单条 GET 均 200；两处 `format.type` 均为 `json_schema`；`structured` 与 TSO.1 一致。

## TSO.3 异步接口：prompt + 轮询 structured 落库

```bash
SID=$(new_sid)
CODE=$(jq -n '{text:"天空是什么颜色？单个中文词回答",metadata:{},delivery:"queue",
  format:{type:"json_schema",schema:{type:"object",properties:{color:{type:"string"}},required:["color"]}}}' \
  | curl -sS --noproxy '*' "${CURL_AUTH[@]}" -o /tmp/tso3.json -w '%{http_code}' \
      -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' --data-binary @-)
echo "prompt=$CODE"
jq -r '.data.id' /tmp/tso3.json
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X POST "$BASE/api/experimental/session/$SID/wait" \
  -H 'Content-Type: application/json' -d '{}' --max-time 300
get_structured "$SID"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" >/dev/null
```
**期望**：接纳返回 HTTP 200（V2 不是 V1 的 204）且含 `.data.id`；wait 后 `structured` 形如 `{"color":"蓝色"}`。

## TSO.4 prompt_stream：流内跟随 + structured

> V2 的 `prompt_stream` 推送的是会话事件（`session.inbox.*` → `session.execution.*`），**不含** V1 的 `message.updated`；`structured` 仍从消息读回。流在回合终态后由服务端主动关闭。

```bash
SID=$(new_sid)
START=$(date +%s)
curl -sS -N --max-time 120 "${CURL_AUTH[@]}" "$BASE/api/session/$SID/prompt_stream" \
  -H 'Content-Type: application/json' \
  -d '{"text":"一周有几天？","metadata":{},"delivery":"queue",
       "format":{"type":"json_schema","schema":{"type":"object","properties":{"days":{"type":"integer"}},"required":["days"]}}}' \
  > /tmp/tso4.log
echo "curl_exit=$? elapsed=$(( $(date +%s) - START ))s"
tail -1 /tmp/tso4.log | jq -r '.type'
get_structured "$SID"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" >/dev/null
```
**期望**：`HTTP 200` + `text/event-stream`，最后一帧为 `session.execution.succeeded`（或 `failed`/`interrupted`），`curl_exit=0`；`structured` 形如 `{"days":7}`。

## TSO.5 负向：非法 format 请求被 400 拒绝

```bash
SID=$(new_sid)
# 变体 1：非法 type
curl -sS -o /tmp/tso5.json -w "bad type http=%{http_code}\n" --max-time 15 "${CURL_AUTH[@]}" \
  -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"hi","metadata":{},"format":{"type":"xml","schema":{}}}'
jq -r '._tag' /tmp/tso5.json
# 变体 2：schema 值非对象
curl -sS -o /dev/null -w "bad schema http=%{http_code}\n" --max-time 15 "${CURL_AUTH[@]}" \
  -X POST "$BASE/api/session/$SID/prompt" -H 'Content-Type: application/json' \
  -d '{"text":"hi","metadata":{},"format":{"type":"json_schema","schema":42}}'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" >/dev/null
```
**期望**：两个变体均 `http=400`；变体 1 报 `InvalidRequestError`（V1 是 `Expected OutputFormat, got {"type":"xml"...}`，V2 由 schema decode 统一拒绝）。

## TSO.6 显式 text format：普通文本模式不受影响

```bash
SID=$(new_sid)
send_prompt "$SID" "只回复两个字：收到" '{"type":"text"}'
echo "structured=$(get_structured "$SID")"
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" "$BASE/api/session/$SID/message?order=asc&limit=100" \
  | jq -r '[.data[]|select(.type=="assistant")|.content[]|select(.type=="text")|.text][-1]'
curl -fsS --noproxy '*' "${CURL_AUTH[@]}" -X DELETE "$BASE/api/session/$SID" >/dev/null
```
**期望**：`structured=null`；assistant 正常返回文本（无结构化介入）。

## TSO.7 存量脏数据容错：非法 format 不炸消息列表

> 验证 `decodeMessageRow` 的容错分支：存储的 `format` 若为历史/脏数据（decode 失败），`GET` 丢弃该字段返回 200 而非 400。
> **前提**：能直连测试 PG（`$PG_URL`）。V2 消息表为 `session_message`，`type` 列存 `user`/`assistant`/`idle`，`data` 为 `text`。

```bash
# 复用 TSO.1 的会话（TSO.1 未 DELETE 时其 SID 仍在当前 shell 中）
psql "$PG_URL" -c "
  UPDATE session_message
  SET data = (jsonb_set(data::jsonb, '{format}', '{\"type\":\"xml\",\"legacy\":true}'::jsonb))::text
  WHERE session_id='$SID' AND type='user'"
curl -sS -o /tmp/tso7.json -w "GET %{http_code}\n" "${CURL_AUTH[@]}" \
  "$BASE/api/session/$SID/message?order=asc&limit=100"
jq -c '[.data[]|{type, format}] | .[0]' /tmp/tso7.json
```
**期望**：GET 200；user 消息 `format` 为 `null`（脏值被丢弃），列表其余消息正常返回。

## 测试结果（V2）

> 2026-09-23 复测：镜像 `opencode-saas-e2e:session-fs-fix3` 热更新本轮改动后重启（未重建），本地 PG `opencode-v2-up`，真实 LLM `Yd-DeepSeek/deepseek-v4-flash`。**TSO.1–TSO.7 全部通过。**

| 用例 | 结果 | 备注 |
|------|------|------|
| TSO.1 | ✅ | `structured={"answer": true, "city": "北京"}`，由 `StructuredOutput` 工具入参投影而来 |
| TSO.2 | ✅ | 列表与单条 GET 均 200；`user.format=json_schema` 两处一致 |
| TSO.3 | ✅ | 接纳 HTTP 200 + message ID；wait 后 `structured={"color": "蓝色"}` |
| TSO.4 | ✅ | 流 200、末帧 `session.execution.succeeded`、curl_exit=0；`structured={"days": 7}` |
| TSO.5 | ✅ | `type=xml` → 400、`schema=42` → 400 |
| TSO.6 | ✅ | `structured=null` + 正常文本回复 |
| TSO.7 | ✅ | PG 写入脏 `format` 后 GET 200，`format` 丢弃为 `null` |

**单测**：`packages/schema/test/output-format.test.ts` 6 项通过（含"普通存储对象可 encode"的 V1 400 回归）；`packages/core/test/structured-output.test.ts` 9 项通过（schema 取用、跨回合不串、工具定义与透传、`$schema` 剔除、system prompt 与工具名一致）；`packages/core/test/session-runner.test.ts` 210 项通过（`toolChoice` 改动无回归）。

## 已知限制与待办

1. **`retryCount` 未实现**：字段保留在契约里与 V1 wire 兼容，但重试路径恒为 0（与 V1 一致，V1 亦硬编码 `retries: 0`）。若要真重试，需在 runner 层加回合内重发。
2. **结构化回合多一条文本消息**（见上文"与 V1 的行为差异"）。若产品要求"结构化即最终、不再有文本"，需要在 runner 的结构化工具命中后终止 loop——当前未做，以免动到既有 agent loop 语义。
3. **thinking 模型只能走 mode 形式 `tool_choice`**：`required` 可用，named（指定工具名）会被 provider 拒。这是 provider 约束，不是本地实现问题。
