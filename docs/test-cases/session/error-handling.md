# 错误处理

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## 七、错误处理

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

### T7.1 未配置的 provider
```bash
bun -e "fetch('http://localhost:14096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hi'}],model:{providerID:'not-exist',modelID:'fake'}})}).then(r=>console.log('status:',r.status)).then(()=>{})"
```
**期望**：返回 **500**，响应体为 `{"name":"UnknownError","data":{"message":"...","ref":"err_xxx"}}`。不卡死。

> **设计说明**：`prompt` 内部（`session/prompt.ts:620` `Effect.die(err)` in requireModel；以及 `:152-158` 的 TaskTool ops 用 `Effect.catch(Effect.die)`）把业务 failure（含 `ProviderModelNotFoundError`）转为 defect，handler 的 `mapError` 捕获不到，冒泡到 server defect handler 输出 `UnknownError` 500。
>
> **已知缺陷**：当前响应体的 `data` 只有通用 message + ref，**原始 error（`ProviderModelNotFoundError` 的 suggestions 等）未保留**，前端无法据此做"Model not found: x/y, did you mean:..."友好提示。若需修复，可在 `prompt.ts:620` 的 `Effect.die(err)` 前加 `catchTag`，映射到 `errors.ts` 现成的 `ModelNotFoundError`(404)，或让 defect handler 把原始 error 落到 `data` 里。
>
> **HTTP 语义注记**：客户端错误（无效 provider/model）用 500 不够精确，理想应为 4xx。

### T7.2 不存在的 session 发消息
```bash
bun -e "fetch('http://localhost:14096/session/ses_NOTEXIST/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hi'}],model:{providerID:'Yd-DeepSeek',modelID:'deepseek-v4-flash'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：404（session 不存在时明确返回 404）

### T7.3 无效 JSON 请求体
```bash
bun -e "fetch('http://localhost:14096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'not-json'}).then(r=>console.log('status:',r.status))"
```
**期望**：400

### T7.4 缺失必填字段
```bash
bun -e "fetch('http://localhost:14096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[]})}).then(r=>console.log('status:',r.status))"
```
**期望**：返回 **500**（与 T7.1 同），`name=UnknownError`。

> **说明**：请求未带 `model` 且 session 无持久化 model 时，`requireModel`（`prompt.ts:605` 内嵌 Effect.fn）解析失败同样走 defect 链路，走与 T7.1 相同的 defect → `UnknownError` 500 链路（原始 error 同样未保留，见 T7.1 已知缺陷）。

### T7.5 超长消息
```bash
bun -e "const big='x'.repeat(100000);fetch('http://localhost:14096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:big}],model:{providerID:'Yd-DeepSeek',modelID:'deepseek-v4-flash'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：能处理或返回明确的长度错误，不应 hang 死

### T7.6 unknown finish 继续（v1.18.20）

> 验证：模型返回 `finish_reason="unknown"` 时 session 不提前停止，继续生成后续内容。

```bash
SID=$(curl -s --noproxy '*' -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --noproxy '*' -X POST "$BASE/session/$SID/keep-alive" -H 'Content-Type: application/json' -d '{"enabled":true}' -o /dev/null
curl -s --noproxy '*' -m 180 -X POST "$BASE/session/$SID/message" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"回复OK即可"}],"model":{"providerID":"opencode","modelID":"hy3-free"}}' -o /dev/null -w "msg:%{http_code}\n"
psql "$PG_URL" -t -A -c "SELECT data->>'finish' FROM message WHERE session_id='$SID' AND data->>'role'='assistant' ORDER BY id DESC LIMIT 1"
```

**期望**：message 200，assistant 的 finish 为 `stop` 或 `tool-calls`（不应为 `unknown` 截断）。

### T7.7 network_error finish 重试链路（v1.18.19）

> 验证：finish_reason=network_error 时触发重试而非直接失败。该逻辑在 `ai-sdk.ts:89` 将 `network_error` 映射为 `ProviderError.ResponseStreamError`，由 `retry.ts` 捕获重试。

```bash
# 单测覆盖（核心验证路径）
cd packages/opencode
bun test test/session/retry.test.ts -t "network_error"
```

**期望**：单测通过，覆盖 `network_error` finish reason 的 retryable 判定。

### T7.8 retry patterns 网络错误变体（v1.18.19）

> 验证：`RETRYABLE_MESSAGE_PATTERNS` 覆盖 `network-error`、`network_error`、`network error` 三种变体，以及 `at capacity` 等新 pattern。

```bash
cd packages/opencode
bun test test/session/retry.test.ts -t "network-error\|network_error\|at capacity"
```

**期望**：单测通过，验证超集 patterns 全部生效（`network[-_\s]error` 统一匹配）。

---

