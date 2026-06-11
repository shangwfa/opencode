# 错误处理

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

## 七、错误处理

### T7.1 未配置的 provider
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hi'}],model:{providerID:'not-exist',modelID:'fake'}})}).then(r=>console.log('status:',r.status)).then(()=>{})"
```
**期望**：状态码 200（服务端宽松处理，错误体现在 AI 回复内容中），不卡死

> **NOTE**：服务端不会对 model providerID 做严格校验，请求本身返回 200，但 AI 回复中会包含 provider 错误信息。如需 4xx 语义需在前端/网关层拦截。

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
**期望**：200（服务端宽松处理，空 parts 允许通过但 AI 回复中会提示无内容）

> **NOTE**：当前服务端不强制校验 `parts` 非空。如需严格 400 语义需增加请求校验中间件。

### T7.5 超长消息
```bash
bun -e "const big='x'.repeat(100000);fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:big}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：能处理或返回明确的长度错误，不应 hang 死

---

