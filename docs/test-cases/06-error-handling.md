# 错误处理

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 七、错误处理

### T7.1 未配置的 provider
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hi'}],model:{providerID:'not-exist',modelID:'fake'}})}).then(r=>console.log('status:',r.status)).then(()=>{})"
```
**期望**：返回 **500**，响应体为 `{"name":"ProviderModelNotFoundError","data":{"providerID":"not-exist","modelID":"fake","suggestions":[...]}}`，不卡死。

> **设计说明**：`prompt` 方法（`session/prompt.ts:136`）用 `Effect.catch(Effect.die)` 把业务 failure（含 `ProviderModelNotFoundError`）转为 defect，handler 的 `mapError` 捕获不到，冒泡到 server defect handler 输出 `UnknownError` 500（保留原始 error data）。前端 `packages/app/src/utils/server-errors.ts` 识别 500 响应体里的 `ProviderModelNotFoundError`，转成"Model not found: x/y, Did you mean: ..."友好提示。
>
> **HTTP 语义注记**：客户端错误（无效 provider/model）用 500 不够精确，理想应为 4xx。当前因前端已解析，SaaS 主场景体验 OK；纯 API/SDK 调用方需解析 500 响应体的 `name` 字段判断错误类型。若需改为 4xx，可在 `prompt.ts:136` 的 `Effect.catch(Effect.die)` 前加 `catchTag`，映射到 `errors.ts` 现成的 `ModelNotFoundError`(404)。

### T7.2 不存在的 session 发消息
```bash
bun -e "fetch('http://127.0.0.1:4096/session/ses_NOTEXIST/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hi'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：404（session 不存在时明确返回 404）

### T7.3 无效 JSON 请求体
```bash
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'not-json'}).then(r=>console.log('status:',r.status))"
```
**期望**：400

### T7.4 缺失必填字段
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[]})}).then(r=>console.log('status:',r.status))"
```
**期望**：返回 **500**（与 T7.1 同），响应体为 `{"name":"ProviderModelNotFoundError",...}`。

> **说明**：body 无 `model` 字段时，`SessionPrompt.getModel` 解析失败同样抛 `ProviderModelNotFoundError`，走与 T7.1 相同的 defect → 500 链路。根因和改进方向同 T7.1。

### T7.5 超长消息
```bash
bun -e "const big='x'.repeat(100000);fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:big}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：能处理或返回明确的长度错误，不应 hang 死

---

