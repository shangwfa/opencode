# OpenCode SaaS 测试用例集

> **⚠️ 行为变更（2026-08-25）**：`bash` 工具的 `background:true` 不再自动触发 keepAlive（已从 `shell.ts` 移除），
> 保活唯一入口是 keep-alive API。本文档中 T11.9、T12.3 及所有"background 必须设为 true 以保活"的表述已过时；
> 现行用例以 [`test-cases/`](./test-cases/) 目录为准。

所有用例在容器内通过 `bun -e` 执行，端口默认 `4096`。请把 `SID` 替换为实际 sessionID。

## 测试环境

- **容器镜像**：`opencode-saas-sandbox-test:v11`
- **容器名**：`opencode-saas-test`
- **本地端口映射**：`localhost:14096 → 容器 4096`
- **本地 PG 数据库**：`postgresql://postgres:postgres@127.0.0.1:5432/opencode`（容器通过 `host.docker.internal:5432` 访问）
- **测试模型**：`zhipuai/glm-5.1`（`{"providerID":"zhipuai","modelID":"glm-5.1"}`）
- **Sandbox API**：`host.docker.internal:30040`（需外部 Sandbox 服务）

## 回归测试结果摘要

- **执行日期**：2026-05-26
- **镜像版本**：v11（基于 upstream/dev `748fcb7eb`）
- **已验证通过**：T1.1-T1.3, T2.1-T2.6, T3.1-T3.2, T4.1-T4.2, T4.6-T4.7, T6.1, T7.2-T7.3, T7.5, T8.1-T8.2, T9.1-T9.2, T10.1
- **待验证（需 Sandbox API）**：T5, T11-T13
- **关键修复**：`Flag.OPENCODE_DEFAULT_DIRECTORY` 需添加到 `packages/core/src/flag/flag.ts`（非 `packages/opencode`）
- **工具调用说明**：upstream 的 part type 为 `tool`（非 `tool-use`），响应结构含 `step-start`, `reasoning`, `tool`, `text`, `step-finish`

### 消息结构说明

`POST /session/:sessionID/message` 的返回值是 **AI 最后一条消息**（通常是文字总结），而工具调用在**前一条消息**中。完整的消息流为：

```
💬 [N]   用户 prompt
🔧 [N+1] AI 工具调用（bash/write/read/edit 等，可能多个）
💬 [N+2] AI 文字总结 ← POST /message 返回的是这条
```

因此，仅解析 `POST /message` 的返回值无法验证工具是否被调用。验证工具调用过程需要查询 `GET /session/:sessionID/message` 获取完整消息列表。

### 通用验证函数

以下 bash 函数可在测试脚本中复用：

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

# send_and_verify: 发送消息并验证工具调用过程 + 最终结果
# 用法: send_and_verify $SID "prompt文本" "测试标签"
send_and_verify() {
  local sid=$1 prompt=$2 label=$3
  echo "=== $label ==="

  # 发送消息（返回值是最后一条文字总结）
  curl -s --max-time 120 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$prompt\"}],\"model\":$MODEL}" > /dev/null 2>&1

  # 从完整消息列表验证工具调用过程
  curl -s "$BASE/session/$sid/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
# 取最后3条消息（prompt + tool calls + summary）
recent = msgs[-3:] if len(msgs) >= 3 else msgs
tools, texts = [], []
for m in recent:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            t = p.get('tool', '?')
            s = p.get('state', {})
            status = s.get('status', '?')
            output = s.get('output', '')[:80] if s.get('output') else ''
            tools.append(f'{t}({status})')
        elif p.get('type') == 'text':
            texts.append(p.get('text', '')[:100])
print(f'  工具调用: {\"✅ \" + str(tools) if tools else \"❌ 无工具调用\"}')
print(f'  AI回复: {texts[-1] if texts else \"(空)\"}')
"
}
```

### API 路径速查

| 功能 | 正确路径 |
|---|---|
| 同步消息 | `POST /session/:sessionID/message` |
| 异步消息 | `POST /session/:sessionID/prompt_async` |
| 中断会话 | `POST /session/:sessionID/abort` |
| Provider 列表 | `GET /provider` |
| 全局事件流 | `GET /global/event`（SSE） |
| Auth 凭据 | `PUT/DELETE /auth/:providerID` |
| Sandbox proxy | `/session/:sessionID/proxy/:port/*` |
| Sandbox 直连 endpoint | `GET /session/:sessionID/endpoint/:port` |
| 沙箱执行命令 | `POST /session/:sessionID/exec` |
| 异步执行命令 | `POST /session/:sessionID/exec/async` |
| 查询执行状态 | `GET /session/:sessionID/exec/:execId` |
| SSE 流式输出 | `GET /session/:sessionID/exec/:execId/stream` |
| 中断执行 | `POST /session/:sessionID/exec/:execId/kill` |
| 执行列表 | `GET /session/:sessionID/execs` |
| 设置 keepAlive | `POST /session/:sessionID/keep-alive` |
| 查询 keepAlive | `GET /session/:sessionID/keep-alive` |
| 销毁 sandbox | `POST /session/:sessionID/kill-sandbox` |
| 健康检查 | `GET /global/health` |
| 全局配置 | `GET /global/config` |

## 验收分层

SaaS 化验收按优先级分三层：

- **P0 SaaS 核心验收**：多 session 隔离、PVC 持久化、sandbox 生命周期、dev server proxy、PG 落库、provider 凭据、并发执行。
- **P1 SaaS 稳定性**：错误恢复、资源回收、重启恢复、限流/计费、proxy 错误上报。
- **P2 低优先级兼容回归**：原 OpenCode 基础 API smoke test，仅用于确认 SaaS 改造没有破坏基础能力，不作为 SaaS 主验收。

当前设计约束：

- 不同 session 必须隔离。Session B 不应看到 Session A 的 `/workspace` 文件或后台进程。
- keepAlive 由 bash 工具是否以 `background:true` 启动决定。直接访问 sandbox proxy 不触发 keepAlive。
- 用户/租户、API 鉴权、用户与 session 的绑定关系、跨用户端口访问控制由外部服务负责，本服务只验证 session 维度的隔离与资源行为。
- 资源配额沿用默认 sandbox/runtime 限制，不在本用例集中单独验收自定义 CPU/内存/磁盘配额。
- 不覆盖老版本/本地数据迁移场景。

```bash
# 通用：定义 SID 变量
SID="ses_xxxxxxxxxxxxxxxxxxxx"
```

---

## 一、基础健康与元信息

### T1.1 服务健康检查
```bash
bun -e "fetch('http://127.0.0.1:4096/global/health').then(r=>r.json()).then(console.log)"
```
**期望**：`{healthy: true, version: ...}`

### T1.2 全局配置查询
```bash
bun -e "fetch('http://127.0.0.1:4096/global/config').then(r=>r.json()).then(d=>console.log(JSON.stringify(d,null,2).slice(0,500)))"
```
**期望**：返回 config 对象，不报错

### T1.3 路径信息
```bash
bun -e "fetch('http://127.0.0.1:4096/path').then(r=>r.json()).then(console.log)"
```
**期望**：`directory=/workspace`

---

## 二、Session 生命周期

### T2.1 创建空 session
```bash
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(console.log)"
```
**期望**：返回 `id`、`directory=/workspace`、`projectID=global`

### T2.2 创建带 title 的 session
```bash
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'测试会话-1'})}).then(r=>r.json()).then(console.log)"
```
**期望**：返回的 `title` 等于 `测试会话-1`

### T2.3 列出所有 session
```bash
bun -e "fetch('http://127.0.0.1:4096/session').then(r=>r.json()).then(d=>console.log('total:',d.length,d.slice(0,3).map(s=>s.id)))"
```
**期望**：数组里包含刚创建的 session

### T2.4 获取单个 session
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID').then(r=>r.json()).then(console.log)"
```
**期望**：返回 session 详情

### T2.5 修改 session title
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'改名后的会话'})}).then(r=>r.json()).then(console.log)"
```
**期望**：返回 `title=改名后的会话`

### T2.6 删除 session
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID',{method:'DELETE'}).then(r=>r.json()).then(console.log)"
```
**期望**：返回 `true`，再 GET 该 session 返回 404

---

## 三、Auth 凭据管理

### T3.1 设置 provider 凭据
```bash
bun -e "fetch('http://127.0.0.1:4096/auth/moonshotai-cn',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'api',key:'sk-test-key'})}).then(r=>r.text()).then(console.log)"
```
**期望**：返回 `true`

### T3.2 删除 provider 凭据
```bash
bun -e "fetch('http://127.0.0.1:4096/auth/moonshotai-cn',{method:'DELETE'}).then(r=>r.text()).then(console.log)"
```
**期望**：返回 `true`

### T3.3 凭据持久化（重启服务后仍存在）
```bash
# 1) 设置 key
bun -e "fetch('http://127.0.0.1:4096/auth/test-provider',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'api',key:'persist-key'})}).then(r=>r.text()).then(console.log)"

# 2) 重启 Pod 后查询 provider 列表，看 connected 是否包含
bun -e "fetch('http://127.0.0.1:4096/provider').then(r=>r.json()).then(d=>console.log('connected:',d.connected))"
```
**期望**：重启后 `connected` 数组仍含该 provider

---

## 四、AI 对话与工具调用

### T4.1 简单文本对话
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'1+1等于几'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：AI 返回包含 `2` 的文本

### T4.2 多轮上下文记忆
```bash
# 第一轮
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'记住我叫张三'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"

# 第二轮
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'我叫什么？'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：第二轮回复中含「张三」

### T4.3 写文件工具
```bash
# 发送消息
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 创建 t4-3.txt 内容是 hello'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log('result:',d.parts.find(p=>p.type==='text')?.text?.slice(0,200)))"

# 验证工具调用过程（POST /message 返回的是文字总结，工具调用在前一条消息中）
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message').then(r=>r.json()).then(msgs=>{
  const recent=msgs.slice(-3);
  const tools=recent.flatMap(m=>m.parts.filter(p=>p.type==='tool').map(p=>p.tool+'('+p.state?.status+')'));
  console.log('tools:',tools.length?tools:'❌ NO TOOLS');
})"
```
**期望**：`tools` 包含 `write(completed)` 或 `bash(completed)`；文字总结确认文件已创建

### T4.4 读文件工具
```bash
# 发送消息
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'读 /workspace/t4-3.txt'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log('result:',d.parts.find(p=>p.type==='text')?.text))"

# 验证工具调用过程
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message').then(r=>r.json()).then(msgs=>{
  const recent=msgs.slice(-3);
  const tools=recent.flatMap(m=>m.parts.filter(p=>p.type==='tool').map(p=>p.tool+'('+p.state?.status+')'));
  console.log('tools:',tools.length?tools:'❌ NO TOOLS');
})"
```
**期望**：`tools` 包含 `read(completed)`；回复中含 `hello`

### T4.5 bash 命令执行
```bash
# 发送消息
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'执行 ls /workspace 命令'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log('result:',d.parts.find(p=>p.type==='text')?.text?.slice(0,200)))"

# 验证工具调用过程
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message').then(r=>r.json()).then(msgs=>{
  const recent=msgs.slice(-3);
  const tools=recent.flatMap(m=>m.parts.filter(p=>p.type==='tool').map(p=>p.tool+'('+p.state?.status+')'));
  console.log('tools:',tools.length?tools:'❌ NO TOOLS');
})"
```
**期望**：`tools` 包含 `bash(completed)` 或 `read(completed)`；回复中含文件列表或 `t4-3.txt`

### T4.6 异步消息（不等结果）
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/prompt_async',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'写一首五言绝句'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：`status: 204`

### T4.7 中断会话
```bash
# 先异步发送一个长任务
bun -e "fetch('http://127.0.0.1:4096/session/$SID/prompt_async',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'写一篇1万字的文章'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})})"

# 立即中断
sleep 1 && bun -e "fetch('http://127.0.0.1:4096/session/$SID/abort',{method:'POST'}).then(r=>r.text()).then(console.log)"
```
**期望**：abort 返回 `true`，最后一条消息 `finish=abort` 或类似

---

## 五、沙箱与 PVC 持久化

### T5.1 创建沙箱写入文件
```bash
bun -e "const ts=Date.now();fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 创建 pvc-'+ts+'.txt 内容是 '+ts}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.text()).then(()=>console.log('已写入 pvc-'+ts+'.txt'))"
```
**期望**：成功写入，记下文件名

### T5.2 销毁沙箱
```bash
bun -e "fetch('http://127.0.0.1:4096/instance/dispose',{method:'POST'}).then(r=>r.text()).then(console.log)"
```
**期望**：返回 `true`，K8s 上对应 sandbox Pod 被删除

### T5.3 重建沙箱后文件仍存在（核心 PVC 测试）
```bash
# 替换为 T5.1 写入的文件名
FILENAME="pvc-1778465991234.txt"
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'读 /workspace/$FILENAME'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：读到原内容，证明 PVC 跨实例持久化

### T5.4 多文件批量持久化
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 下创建三个文件：a.txt 内容 A，b.txt 内容 B，c.txt 内容 C'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.text()).then(()=>console.log('done'))"

# dispose
bun -e "fetch('http://127.0.0.1:4096/instance/dispose',{method:'POST'}).then(r=>r.text())"

# 验证三个文件都在
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'用 ls 列出 /workspace 下所有 txt 文件'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：a.txt、b.txt、c.txt 都在

### T5.5 目录持久化
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 下创建 sub/deep 目录，并在 sub/deep/x.txt 写入 DEEP'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.text()).then(()=>console.log('done'))"

bun -e "fetch('http://127.0.0.1:4096/instance/dispose',{method:'POST'}).then(r=>r.text())"

bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'读 /workspace/sub/deep/x.txt'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：读出 `DEEP`

---

## 六、并发与隔离

### T6.1 并发创建 session
```bash
bun -e "Promise.all(Array.from({length:5},()=>fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()))).then(arr=>console.log(arr.map(s=>s.id)))"
```
**期望**：5 个不同的 sessionID，全部创建成功

### T6.2 跨 session 文件隔离
```bash
# session A 创建文件
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(s=>{global.SA=s.id;return fetch('http://127.0.0.1:4096/session/'+s.id+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'创建 /workspace/sessionA.txt 内容 A'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})})}).then(()=>console.log('sessionA:',global.SA))"

# session B 访问自己的独立 workspace，不能看到 sessionA.txt
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(s=>fetch('http://127.0.0.1:4096/session/'+s.id+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'ls /workspace'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})})).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：B 看不到 `sessionA.txt`，证明不同 session 的 `/workspace` 互相隔离

### T6.3 并发消息发送
```bash
bun -e "Promise.all(Array.from({length:3},(_,i)=>fetch('http://127.0.0.1:4096/session/$SID/prompt_async',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'第'+i+'条'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.status))).then(console.log)"
```
**期望**：全部返回 204，服务端串行处理或合理排队

---

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

## 八、Provider 与模型

### T8.1 列出所有 provider
```bash
bun -e "fetch('http://127.0.0.1:4096/provider').then(r=>r.json()).then(d=>console.log('providers:',d.all?.length,'connected:',d.connected))"
```

### T8.2 切换模型
```bash
# 用同一 session 在两轮里切换不同模型
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'你是哪个模型？'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log('m1:',d.info.modelID))"
```

---

## 九、SSE 事件流

### T9.1 订阅事件流
```bash
# 后台订阅
bun -e "const r=await fetch('http://127.0.0.1:4096/global/event');const reader=r.body.getReader();const decoder=new TextDecoder();let count=0;while(count<5){const{value,done}=await reader.read();if(done)break;console.log(decoder.decode(value).slice(0,200));count++}" &

# 触发事件：创建 session
sleep 1
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(s=>console.log('created:',s.id))"
```
**期望**：事件流中收到 session.created 等事件

---

## 十、综合 E2E 场景

### T10.1 完整开发流程
```bash
# 1) 创建项目骨架
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 创建一个 python 项目结构：myapp/__init__.py、myapp/main.py（含 def main(): print(\"hello\")）、tests/test_main.py（import myapp.main 并测试）'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.text()).then(()=>console.log('done'))"

# 2) 检查文件结构
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'用 find /workspace -type f -name \"*.py\" 列出所有 py 文件'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"

# 3) 销毁实例
bun -e "fetch('http://127.0.0.1:4096/instance/dispose',{method:'POST'}).then(r=>r.text())"

# 4) 重建后运行测试
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'cd /workspace && python -c \"from myapp.main import main; main()\"'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：输出 `hello`

---

## 十一、Sandbox Proxy（dev server 代理）

> 前置条件：本地测试环境已启动（见 `docs/local-test-env.md`），使用 `zhipuai/glm-5.1` 模型，基础 URL 为 `http://localhost:14096`。

```bash
BASE="http://localhost:14096"
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

### T11.1 创建 Vite 项目并启动 dev server

```bash
# 创建项目 + 安装依赖
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: npx create-vite@5 /workspace/vite-app --template react-ts --yes && cd /workspace/vite-app && npm install\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# background:true 启动 Vite（必须）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

sleep 10
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Vite proxy: %{http_code}\n"
```
**期望**：`Vite proxy: 200`

---

### T11.2 HTML 注入验证

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
print('data-oc-prefix:', 'data-oc-prefix=\"'+prefix+'\"' in html)
print('inject script:', 'function f(' in html)
print('fetch patch:', 'window.fetch=function' in html)
print('WebSocket patch:', 'window.WebSocket=function' in html)
print('XHR patch:', 'XMLHttpRequest.prototype.open' in html)
"
```
**期望**：全部为 `True`

---

### T11.3 HTML src/href 属性路径重写

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
# 找 src/href 属性
attrs = re.findall(r'(?:src|href)=\"(/[^\"]+)\"', html)
unprefixed = [a for a in attrs if not a.startswith(prefix) and not a.startswith('http')]
print('unprefixed src/href:', unprefixed[:5])
print('all prefixed:', len(unprefixed)==0)
"
```
**期望**：`all prefixed: True`，`unprefixed` 为空

---

### T11.4 内联 script import 路径重写（Vite @react-refresh）

```bash
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys,re
html=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
# 检查 @react-refresh preamble
prefixed = 'from \"'+prefix+'/@react-refresh\"' in html
unprefixed = 'from \"/@react-refresh\"' in html
print('@react-refresh PREFIXED:', prefixed)
print('@react-refresh UNPREFIXED (bug):', unprefixed)
"
```
**期望**：`PREFIXED: True`，`UNPREFIXED: False`

---

### T11.5 JS import 路径重写

```bash
# 获取 main chunk URL
MAIN=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "src=\"/session/$SID/proxy/5173/src/main.tsx[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
curl -s "$BASE$MAIN" | python3 -c "
import sys,re
js=sys.stdin.read()
sid='$SID'
prefix='/session/'+sid+'/proxy/5173'
# 找未加前缀的 import
bad = re.findall(r'from \"/(?!session/)[^\"]+\"', js)
print('unprefixed imports:', bad[:3])
print('all imports prefixed:', len(bad)==0)
"
```
**期望**：`all imports prefixed: True`

---

### T11.6 BrowserRouter 自动替换为 HashRouter

```bash
MAIN=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "src=\"/session/$SID/proxy/5173/src/main.tsx[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
curl -s "$BASE$MAIN" | python3 -c "
import sys
js=sys.stdin.read()
print('HashRouter count:', js.count('HashRouter'))
print('BrowserRouter count (should be 0):', js.count('BrowserRouter'))
"
```
**期望**：`HashRouter count >= 1`，`BrowserRouter count: 0`

---

### T11.7 CSS url() 路径重写

```bash
# 获取 layout.css URL
CSS=$(curl -s "$BASE/session/$SID/proxy/5173/" | grep -o "href=\"/session/$SID/proxy/5173/[^\"]*\.css[^\"]*\"" | head -1 | sed 's/href="//;s/"//')
if [ -n "$CSS" ]; then
  curl -s "$BASE$CSS" | grep -o 'url([^)]*)' | head -5
else
  echo "No CSS link found (may not exist in this project)"
fi
```
**期望**：CSS 中 `url()` 内的路径含 proxy prefix，或项目无自定义字体（Next.js 项目才有）

---

### T11.8 错误上报端点

```bash
# 查询错误列表（初始为空）
curl -s "$BASE/session/$SID/proxy/5173/__errors"
echo ""
# 查询聚合错误
curl -s "$BASE/session/$SID/proxy-errors"
```
**期望**：返回 JSON（`[]` 或 `{}`），HTTP 200

---

### T11.9 background:true keepAlive 验证（核心）

```bash
# 访问 proxy 不触发 keepAlive；keepAlive 由 bash background:true 决定
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null

# 等待 session idle（AI 无操作约 5 秒）
sleep 10

# Sandbox 应仍然存活（有 keepAlive 不回收）
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "After idle: %{http_code}\n"
```
**期望**：`After idle: 200`（sandbox 未被回收）

**注意**：这里能保持 200 的前提是 T11.1 使用了 `background:true` 启动 dev server。单纯访问 proxy 不会保活 sandbox。

---

### T11.10 sandbox proxy 刷新页面（不丢失路由）

```bash
# 访问子路由（Vite 项目 SPA 路由用 HashRouter，刷新不受影响）
curl -s "$BASE/session/$SID/proxy/5173/#/about" -o /dev/null -w "Hash route: %{http_code}\n"
```
**期望**：`Hash route: 200`（proxy 服务端只看 pathname，`#` 后的内容不影响路由）

---

### T11.11 Next.js dev server 代理

```bash
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"  # 已有 Next.js 项目

# 启动 Next.js（background:true）
curl -s --max-time 60 -X POST "$BASE/session/$SID_NEXT/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace/next-app && npx next dev -H 0.0.0.0 -p 3000\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

sleep 20

# 验证首页、about、contact 三个页面
for path in "/" "/about" "/contact"; do
  CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID_NEXT/proxy/3000$path")
  echo "Next.js $path: $CODE"
done
```
**期望**：三个路径均返回 `200`

---

### T11.12 Next.js webpack publicPath 重写

```bash
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"
PREFIX="/session/$SID_NEXT/proxy/3000"

# 找 webpack.js
WP_URL=$(curl -s "$BASE$PREFIX/" | grep -o "src=\"$PREFIX/_next/static/chunks/webpack[^\"]*\"" | head -1 | sed 's/src="//;s/"//')
echo "webpack URL: $WP_URL"
curl -s "$BASE$WP_URL" | grep -o '__webpack_require__\.p\s*=\s*"[^"]*"'
```
**期望**：`__webpack_require__.p="/session/{sid}/proxy/3000/_next/"`

---

### T11.13 Next.js RSC 路径重写

```bash
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"
PREFIX="/session/$SID_NEXT/proxy/3000"

curl -s "$BASE$PREFIX/" | python3 -c "
import sys,re
html=sys.stdin.read()
prefix='/session/ses_1d52f1c8cffeiSZAgZNA8XElBE/proxy/3000'

# 检查 RSC flight data 中路径
unprefixed = re.findall(r'(?<=[\"\\\\])/(?!session/|/)(?:_next|about|contact|favicon)[^\"\\\\]*', html)
print('unprefixed paths in RSC:', unprefixed[:5])
print('all RSC paths prefixed:', len(unprefixed)==0)

# about 链接
has_about = (prefix+'/about') in html or '\\\\\"'+prefix+'/about' in html
print('about link prefixed:', has_about)
"
```
**期望**：`all RSC paths prefixed: True`，`about link prefixed: True`

---

### T11.14 SPA 路由（Next.js 客户端导航）

人工测试步骤：
1. 浏览器打开 `http://localhost:14096/session/ses_1d52f1c8cffeiSZAgZNA8XElBE/proxy/3000/`
2. 点击 About 链接 → 地址栏变为 `.../proxy/3000/about`，页面内容变为 About
3. 点击 Contact 链接 → 地址栏变为 `.../proxy/3000/contact`，页面正常
4. 刷新当前页面 → 仍然正常（302/200 均可）
5. 浏览器后退 → 回到上一页

**期望**：全部正常，无白屏，无 chunk 加载错误

---

### T11.15 Server Proxy 模式连通性

```bash
# 验证 sandbox server proxy API key 正确传递（期望非 401）
SID_NEXT="ses_1d52f1c8cffeiSZAgZNA8XElBE"
CODE=$(curl -s --max-time 30 -o /dev/null -w "%{http_code}" "$BASE/session/$SID_NEXT/proxy/3000/")
echo "Server proxy mode: $CODE (expect 200, NOT 401/502)"
```
**期望**：`200`（401 = API key 未传；502 = sandbox 未启动）

---

## 十二、沙箱生命周期管理

> 前置条件：同第十一节，使用本地测试环境（`docs/local-test-env.md`）。

```bash
BASE="http://localhost:14096"
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

### T12.1 沙箱按需创建（首次 AI 消息时创建）

```bash
# 发消息前检查日志（不应有 sandbox created）
docker exec opencode-saas-test grep 'sandbox created' /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l

# 发第一条消息（触发 sandbox 创建）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo hello\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 发消息后检查日志
docker exec opencode-saas-test grep "sandbox created.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -1
```
**期望**：发消息后日志中出现 `sandbox created`，含对应 `sessionID` 和 `sandboxID`

---

### T12.2 同一 session 复用同一沙箱

```bash
# 第一条消息，记录 sandboxID
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo sandbox-test-1\"}],\"model\":$MODEL}" > /dev/null

SB1=$(docker exec opencode-saas-test grep "sandbox.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | grep -o 'sandboxID=[^ ]*' | tail -1)
echo "First sandboxID: $SB1"

# 第二条消息
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo sandbox-test-2\"}],\"model\":$MODEL}" > /dev/null

SB2=$(docker exec opencode-saas-test grep "sandbox.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | grep -o 'sandboxID=[^ ]*' | tail -1)
echo "Second sandboxID: $SB2"

[ "$SB1" = "$SB2" ] && echo "PASS: same sandbox reused" || echo "FAIL: different sandboxes"
```
**期望**：无 keepAlive 时两次 `sandboxID` 可能不同（idle 后 sandbox 被销毁，下次消息自动重建新 sandbox）。有 keepAlive 时（`background:true` 启动了长后台进程）sandbox 保持存活，`sandboxID` 不变。这是预期行为，非 bug

---

### T12.3 background:true 触发 keepAlive

```bash
# 用 background:true 执行命令
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: sleep 1 && echo done\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"

# 检查 keepAlive 是否被设置
docker exec opencode-saas-test grep "keep alive enabled.*$SID" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -1
```
**期望**：日志中出现 `sandbox keep alive enabled`，含对应 `sessionID`

---

### T12.4 无 keepAlive 时 session idle 后沙箱被销毁

```bash
# 创建新 session（避免污染已有 keepAlive session）
SID2=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID2: $SID2"

# 普通命令（非 background），执行完后 session 进入 idle
curl -s --max-time 60 -X POST "$BASE/session/$SID2/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo hello\"}],\"model\":$MODEL}" > /dev/null

# 等待 onIdle 触发
sleep 5

# 检查 destroy 日志
docker exec opencode-saas-test grep "sandbox destroyed\|destroy.*$SID2" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -1
```
**期望**：日志中出现 `sandbox destroyed`，含对应 `sessionID`

---

### T12.5 keepAlive 阻止 idle 销毁

```bash
SID3=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID3: $SID3"

# background:true 激活 keepAlive
curl -s --max-time 60 -X POST "$BASE/session/$SID3/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: echo keepalive-test\"}],\"model\":$MODEL}" > /dev/null

# 等待 session idle
sleep 10

# 检查：有 idle 日志，但无 destroy 日志
IDLE=$(docker exec opencode-saas-test grep "session.idle.*$SID3\|exiting loop.*$SID3" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l)
DESTROY=$(docker exec opencode-saas-test grep "sandbox destroyed.*$SID3\|destroy.*$SID3" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l)
echo "idle events: $IDLE (should > 0)"
echo "destroy events: $DESTROY (should = 0)"
```
**期望**：`idle events > 0`，`destroy events = 0`

---

### T12.6 instance/dispose 强制销毁所有沙箱

```bash
# 先确保有沙箱在运行
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo before-dispose\"}],\"model\":$MODEL}" > /dev/null

# 调用 dispose
curl -s -X POST "$BASE/instance/dispose" -o /dev/null -w "dispose: %{http_code}\n"

# 检查销毁日志
sleep 2
docker exec opencode-saas-test grep "sandbox destroyed\|destroyAll" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -3
```
**期望**：`dispose: 200`，日志中出现 sandbox 销毁记录

---

### T12.7 dispose 后再次发消息自动重建沙箱

```bash
# dispose
curl -s -X POST "$BASE/instance/dispose" > /dev/null

# 等一下
sleep 2

# 再次发消息（应自动重建沙箱）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo after-dispose\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：正常响应，输出含 `after-dispose`，沙箱自动重建

---

### T12.8 沙箱容器重启后 PVC 数据恢复

```bash
# Step 1: 写入测试文件
TS=$(date +%s)
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo $TS > /workspace/restart-test-$TS.txt\"}],\"model\":$MODEL}" > /dev/null

echo "Wrote restart-test-$TS.txt"

# Step 2: 重启 opencode 容器（模拟 Pod 重启）
docker restart opencode-saas-test
sleep 10

# Step 3: 重启 TCP 转发（容器重启后可能需要）
# （若转发正常则跳过）

# Step 4: 重新发消息，验证文件仍存在
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: cat /workspace/restart-test-$TS.txt\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:100]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：重启后仍能读到 `$TS`，PVC 数据跨容器重启持久

---

### T12.9 多 session PVC 子目录隔离

> 每个 session 的 PVC 挂载在独立子路径 `sessions/{sessionID}/workspace`，互相隔离。

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A 写文件
curl -s --max-time 60 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo session-A > /workspace/only-in-A.txt\"}],\"model\":$MODEL}" > /dev/null

# Session B 读 A 的文件（应该看不到）
RESULT=$(curl -s --max-time 60 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: ls /workspace/only-in-A.txt 2>&1\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']")
echo "Session B sees A's file: $RESULT"
```
**期望**：Session B 看不到 `only-in-A.txt`（No such file or directory）

---

### T12.10 沙箱进程隔离（不同 session 进程互不影响）

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Session A 启动后台进程
curl -s --max-time 60 -X POST "$BASE/session/$SID_A/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 设为 true: sleep 3600\"}],\"model\":$MODEL}" > /dev/null

# Session B 查看进程（不应看到 A 的 sleep）
PROCS=$(curl -s --max-time 60 -X POST "$BASE/session/$SID_B/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: ps aux | grep sleep | grep -v grep\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p['text'][:300]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']")
echo "Session B processes: $PROCS"
```
**期望**：Session B 看不到 Session A 的 `sleep 3600` 进程（容器级隔离）

---

### T12.11 OPENCODE_SANDBOX_IDLE_KILL_SEC 配置验证

```bash
# 验证该配置当前未被 opencode 代码使用（只传给 SDK）
docker exec opencode-saas-test env | grep IDLE_KILL
grep -n 'idleKillMs\|IDLE_KILL' /Users/ruomu/code/opencode/packages/opencode/src/tool/sandbox-provider.ts
```
**期望**：
- `env` 显示 `OPENCODE_SANDBOX_IDLE_KILL_SEC=30`
- `grep` 只在 config 定义处出现（第 19、35 行），**无实际使用**
- 回收逻辑在 `run-state.ts` `onIdle` 回调中，由 session runner 空闲触发，非定时器

---

### T12.12 proxy 访问不触发 keepAlive（当前行为）

```bash
SID4=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 先通过 AI 启动 dev server（不用 background:true）
curl -s --max-time 60 -X POST "$BASE/session/$SID4/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo started\"}],\"model\":$MODEL}" > /dev/null

# 直接访问 proxy（不触发 keepAlive）
curl -s "$BASE/session/$SID4/proxy/3000/" -o /dev/null

# 等待 session idle + sandbox destroy
sleep 10

DESTROY=$(docker exec opencode-saas-test grep "destroy.*$SID4" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l)
echo "destroy events: $DESTROY (should > 0, proxy access does NOT prevent destroy)"
```
**期望**：`destroy events > 0`，说明直接访问 proxy 不触发 keepAlive，sandbox 仍被回收

> 这是当前的设计行为。如需 proxy 访问自动保活，需修改 `sandbox-proxy.ts` 在 `getEndpoint` 后调用 `keepAlive`（见 `sandbox-proxy-design.md` 相关讨论）。



## 十三、SaaS 稳定性补充

> 前置条件：同第十一节，使用本地测试环境（`docs/local-test-env.md`）。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T13.1 单 session kill-sandbox
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo kill-test > /workspace/kill-test.txt\"}],\"model\":$MODEL}" > /dev/null
curl -s -X POST "$BASE/session/$SID/kill-sandbox" -w "\nkill-sandbox: %{http_code}\n"
```
**期望**：HTTP 200，返回 `{"sessionID":"...","destroyed":true}`，日志中出现该 `SID` 对应的 sandbox destroyed 记录

### T13.2 kill-sandbox 后 PVC 保留并自动重建
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: cat /workspace/kill-test.txt\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:200]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：输出含 `kill-test`，证明 kill 只销毁 sandbox runtime，不删除 PVC 数据

### T13.3 同一 session 并发首条消息只创建一个 sandbox
```bash
SID_NEW=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
for i in 1 2 3; do
  curl -s --max-time 90 -X POST "$BASE/session/$SID_NEW/prompt_async" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo concurrent-create-$i\"}],\"model\":$MODEL}" &
done
wait
sleep 10
docker exec opencode-saas-test grep "sandbox created.*$SID_NEW" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | wc -l
```
**期望**：同一个 `SID_NEW` 只创建 1 个 sandbox；不能出现多个可用 sandbox runtime 绑定同一 session

### T13.4 dispose 与正在执行的 prompt 并发
```bash
SID_BUSY=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_BUSY/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: sleep 30 && echo late-output\"}],\"model\":$MODEL}" &
sleep 2
curl -s -X POST "$BASE/instance/dispose" -w "\ndispose: %{http_code}\n"
sleep 5
curl -s "$BASE/session/status" | python3 -m json.tool
```
**期望**：dispose 返回 200；正在执行的任务最终进入 idle/abort/error 中的明确状态，不应永久 running

### T13.5 Vite HMR/WebSocket proxy 连通
```bash
# 前置：T11.1 已启动 Vite dev server
curl -i -N --max-time 5 \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
  -H "Sec-WebSocket-Version: 13" \
  "$BASE/session/$SID/proxy/5173/" 2>&1 | head -20
```
**期望**：能完成 WebSocket upgrade 或返回 Vite HMR 兼容响应；不应是 401/404/502

### T13.6 proxy 302 Location 路径重写
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace && python3 -m http.server 8123\"}],\"model\":$MODEL}" > /dev/null
sleep 3
curl -i -s "$BASE/session/$SID/proxy/8123/no-such-dir" | grep -i '^location:'
```
**期望**：如果上游返回 `Location: /...`，代理后的 Location 应加上 `/session/$SID/proxy/8123` 前缀

### T13.7 proxy 二进制资源代理
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: printf '\\\\x89PNG\\\\r\\\\n\\\\x1a\\\\n' > /workspace/test.png\"}],\"model\":$MODEL}" > /dev/null
curl -s "$BASE/session/$SID/proxy/8123/test.png" | python3 -c "import sys;d=sys.stdin.buffer.read();print(d[:8], len(d))"
```
**期望**：输出 PNG 文件头 `b'\x89PNG\r\n\x1a\n'`，二进制内容不被 HTML/JS 重写破坏

### T13.8 proxy 错误上报 POST 与聚合查询
```bash
curl -s -X POST "$BASE/session/$SID/proxy/5173/__error_report" \
  -H 'Content-Type: application/json' \
  -d '[{"type":"runtime","message":"synthetic proxy error","url":"/x","line":1,"col":2,"stack":"stack","timestamp":1778465991234}]'
curl -s "$BASE/session/$SID/proxy/5173/__errors" | python3 -m json.tool
curl -s "$BASE/session/$SID/proxy-errors" | python3 -m json.tool
```
**期望**：两个查询结果都能看到 `synthetic proxy error`，并关联到当前 `SID` 与端口

### T13.9 服务重启后 session/message/part 仍可查询
```bash
SID_RESTART=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"restart-pg-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_RESTART/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 restart-pg-ok\"}],\"model\":$MODEL}" > /dev/null
docker restart opencode-saas-test
sleep 10
curl -s "$BASE/session/$SID_RESTART" | python3 -m json.tool
curl -s "$BASE/session/$SID_RESTART/message" | python3 -c "import json,sys;print(len(json.load(sys.stdin)))"
```
**期望**：重启后 session 可查询，message 数量大于 0

### T13.10 prompt_async 落库与 abort 状态
```bash
SID_ABORT=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_ABORT/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"写一篇很长的文章，持续输出\"}],\"model\":$MODEL}" -w "async: %{http_code}\n"
sleep 1
curl -s -X POST "$BASE/session/$SID_ABORT/abort"
sleep 5
curl -s "$BASE/session/$SID_ABORT/message" | python3 -m json.tool | head -120
```
**期望**：异步请求返回 204；abort 后消息已落库，最后状态是 abort/error/idle 中的明确结果，不应永久 running

### T13.11 PG FK 完整性与删除级联
```bash
SID_DEL=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_DEL/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo pg-integrity\"}],\"model\":$MODEL}" > /dev/null
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM message WHERE session_id = '$SID_DEL';"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM part WHERE session_id = '$SID_DEL';"
curl -s -X DELETE "$BASE/session/$SID_DEL"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM message WHERE session_id = '$SID_DEL';"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM part WHERE session_id = '$SID_DEL';"
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT COUNT(*) FROM part p LEFT JOIN message m ON p.message_id = m.id WHERE m.id IS NULL;"
```
**期望**：删除前 message/part 大于 0；删除后该 session 的 message/part 为 0；全局 orphan part 为 0

### T13.12 订阅额度月度 reset 与 rate limit
```bash
cd /Users/ruomu/code/opencode/packages/console/core && bun test test/subscription.test.ts
cd /Users/ruomu/code/opencode/packages/console/app && bun test test/rateLimiter.test.ts
```
**期望**：全部通过，覆盖 usage reset、rate-limited、Retry-After、usagePercent cap

### T13.13 rate limit 命中后不执行工具
```bash
# 需要外部服务或测试桩把当前用户/org 标记为 rate-limited 后再执行
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo should-not-run > /workspace/rate-limit.txt\"}],\"model\":$MODEL}" \
  -w "\nstatus: %{http_code}\n"
curl -s "$BASE/file/content?path=/workspace/rate-limit.txt&sessionID=$SID"
```
**期望**：请求返回明确 rate limit 错误；`rate-limit.txt` 不应存在。若限流由外部服务完成，本用例在外部网关层执行

### T13.14 sandbox 安全：禁止访问宿主路径
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: ls /Users /var/run/docker.sock /home/opencode/.ssh 2>&1 || true\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:500]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：不能读取宿主机用户目录、Docker socket 或 SSH 私钥；输出应是不存在或权限拒绝

### T13.15 sandbox 安全：禁止路径逃逸
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: cd /workspace && ln -s /etc/passwd escape-passwd 2>/dev/null || true && cat escape-passwd 2>&1 || true && cat ../../etc/passwd 2>&1 || true\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:800]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：不能通过软链或相对路径读到 sandbox 外敏感文件；如果 sandbox 内 `/etc/passwd` 可读，应确认不包含宿主机用户信息

### T13.16 sandbox 安全：敏感环境变量不泄露
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: env | grep -Ei 'TOKEN|SECRET|KEY|PASSWORD|COOKIE' || true\"}],\"model\":$MODEL}" \
  | python3 -c "import json,sys;[print(p.get('text','')[:800]) for p in json.load(sys.stdin).get('parts',[]) if p.get('type')=='text']"
```
**期望**：不应暴露外部服务密钥、数据库密码、provider key、cookie 等敏感信息；允许出现无敏感值的测试变量

### T13.17 幂等性：重复 instance/dispose
```bash
for i in 1 2 3; do
  curl -s -X POST "$BASE/instance/dispose" -w "dispose-$i: %{http_code}\n"
done
```
**期望**：重复调用都稳定返回 200/true，不产生异常日志或残留 sandbox

### T13.18 幂等性：重复 kill-sandbox
```bash
for i in 1 2 3; do
  curl -s -X POST "$BASE/session/$SID/kill-sandbox" -w "kill-$i: %{http_code}\n"
done
```
**期望**：重复调用返回稳定结果；若 sandbox 已不存在，必须是明确成功或明确错误，不应 500

### T13.19 幂等性：重复删除 session 和 provider 凭据
```bash
SID_DELETE=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
for i in 1 2; do curl -s -X DELETE "$BASE/session/$SID_DELETE" -w "delete-session-$i: %{http_code}\n"; done
curl -s -X PUT "$BASE/auth/test-provider" -H 'Content-Type: application/json' -d '{"type":"api","key":"idempotent-key"}'
for i in 1 2; do curl -s -X DELETE "$BASE/auth/test-provider" -w "delete-auth-$i: %{http_code}\n"; done
```
**期望**：重复删除行为明确。第二次可以是 200/true 或 404，但不能 500 或产生不一致状态

### T13.20 观测性：sandbox 生命周期日志
```bash
SID_LOG=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_LOG/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: echo log-observe\"}],\"model\":$MODEL}" > /dev/null
sleep 2
docker exec opencode-saas-test grep "$SID_LOG" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | grep -E 'sandbox created|keep alive enabled|sandbox destroyed' | tail -10
```
**期望**：日志包含 `sessionID`，并能定位 sandbox created、keepAlive、destroyed 等生命周期事件

### T13.21 观测性：错误可关联 sessionID
```bash
SID_ERR=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 30 -X POST "$BASE/session/$SID_ERR/message" \
  -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"hi"}],"model":{"providerID":"not-exist","modelID":"fake"}}' \
  -w "\nstatus: %{http_code}\n"
sleep 2
docker exec opencode-saas-test grep "$SID_ERR" /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -20
```
**期望**：provider/sandbox/session 错误日志能关联到 `SID_ERR`

### T13.22 观测性：usage/计费记录可关联 session
```bash
SID_USAGE=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_USAGE/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 usage-observe\"}],\"model\":$MODEL}" > /dev/null
docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -A -c "SELECT id, data->>'role', data->'metadata' FROM message WHERE session_id = '$SID_USAGE' ORDER BY time_created DESC LIMIT 5;"
```
**期望**：消息或相关 usage 表中能关联 `sessionID`、model、token/成本信息；若当前尚未落 usage，标记为待实现

### T13.23 恢复语义：重启后 running session 状态明确
```bash
SID_RUN=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s --max-time 60 -X POST "$BASE/session/$SID_RUN/prompt_async" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: sleep 60 && echo after-restart\"}],\"model\":$MODEL}" > /dev/null
sleep 2
docker restart opencode-saas-test
sleep 10
curl -s "$BASE/session/status" | python3 -m json.tool
curl -s "$BASE/session/$SID_RUN/message" | python3 -m json.tool | head -120
```
**期望**：`SID_RUN` 不应永久 running；最终应变为 idle/abort/error 中的明确状态

### T13.24 恢复语义：重启后无孤儿 sandbox
```bash
docker restart opencode-saas-test
sleep 10
docker ps --format '{{.Names}}' | grep -i sandbox || true
docker exec opencode-saas-test grep -E 'orphan|cleanup|sandbox' /home/opencode/.local/share/opencode/log/dev.log 2>/dev/null | tail -50
```
**期望**：重启后旧 sandbox 不应成为无法管理的孤儿资源；如设计为外部 runtime 自动清理，日志应能体现清理或重新接管

---

## 十四、低优先级兼容回归

> 本节不是 SaaS 主验收，仅用于回归确认原 OpenCode 基础 API 没有被 SaaS 改造间接破坏。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"p2-base-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T14.1 session 列表过滤
```bash
curl -s "$BASE/session?search=p2-base-test&limit=1" | python3 -m json.tool
curl -s "$BASE/session?roots=true&limit=5" | python3 -m json.tool
curl -s "$BASE/session?start=0&limit=5" | python3 -m json.tool
```
**期望**：search 能找到刚创建的 session；limit 生效；roots 返回根 session

### T14.2 session/status
```bash
curl -s "$BASE/session/status" | python3 -m json.tool
```
**期望**：返回对象，包含 active/idle/busy 等明确状态信息

### T14.3 session fork 与 children
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"回复 fork-base\"}],\"model\":$MODEL}" > /tmp/fork-msg.json
MSG=$(python3 -c "import json;print(json.load(open('/tmp/fork-msg.json'))['info']['id'])")
curl -s -X POST "$BASE/session/$SID/fork" -H 'Content-Type: application/json' -d "{\"messageID\":\"$MSG\"}" | python3 -m json.tool
curl -s "$BASE/session/$SID/children" | python3 -m json.tool
```
**期望**：fork 返回 child session；children 列表包含该 child

### T14.4 message 分页
```bash
curl -i -s "$BASE/session/$SID/message?limit=1" | tee /tmp/page1.txt
CUR=$(grep -i '^x-next-cursor:' /tmp/page1.txt | tr -d '\r' | awk '{print $2}')
if [ -n "$CUR" ]; then curl -i -s "$BASE/session/$SID/message?limit=1&before=$CUR"; fi
```
**期望**：第一页返回最多 1 条；有更多数据时响应头包含 `X-Next-Cursor` 和 `Link`

### T14.5 share/unshare
```bash
curl -s -X POST "$BASE/session/$SID/share" | python3 -m json.tool
curl -s "$BASE/session/$SID" | python3 -m json.tool
curl -s -X DELETE "$BASE/session/$SID/share" | python3 -m json.tool
```
**期望**：share 后 session 含分享信息；unshare 后分享信息被移除

### T14.6 diff/revert/unrevert
```bash
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo diff-test > /workspace/diff-test.txt\"}],\"model\":$MODEL}" > /tmp/diff-msg.json
MSG=$(python3 -c "import json;print(json.load(open('/tmp/diff-msg.json'))['info']['id'])")
curl -s "$BASE/session/$SID/diff?messageID=$MSG" | python3 -m json.tool
curl -s -X POST "$BASE/session/$SID/revert" -H 'Content-Type: application/json' -d "{\"messageID\":\"$MSG\"}" | python3 -m json.tool
curl -s -X POST "$BASE/session/$SID/unrevert" | python3 -m json.tool
```
**期望**：diff 能显示文件变更；revert 后文件变更回滚；unrevert 后恢复

### T14.7 file API
```bash
curl -s "$BASE/file?path=/workspace&sessionID=$SID" | python3 -m json.tool
curl -s "$BASE/file/content?path=/workspace/diff-test.txt&sessionID=$SID" | python3 -m json.tool
curl -s "$BASE/file/status" | python3 -m json.tool
```
**期望**：能列出 session sandbox 内文件、读取文件内容、返回 git 文件状态

### T14.8 find API
```bash
curl -s "$BASE/find/file?query=diff-test&limit=10" | python3 -m json.tool
curl -s "$BASE/find?pattern=diff-test" | python3 -m json.tool
curl -s "$BASE/find/symbol?query=main" | python3 -m json.tool
```
**期望**：文件搜索和文本搜索返回匹配；symbol 当前可为空数组但不能报错

### T14.9 VCS API
```bash
curl -s "$BASE/vcs" | python3 -m json.tool
curl -s "$BASE/vcs/diff?mode=working" | python3 -m json.tool
```
**期望**：返回当前分支/default branch；diff 返回数组

### T14.10 agent/skill/command 列表
```bash
curl -s "$BASE/agent" | python3 -m json.tool | head -80
curl -s "$BASE/skill" | python3 -m json.tool | head -80
curl -s "$BASE/command" | python3 -m json.tool | head -80
```
**期望**：三个接口均返回数组，不报错

---

## 十五、Session Skills

本节验证 SaaS API 中 session 维度的 skills：创建、读取、删除、复杂 bundle、resources 注入，以及从 SkillsMP 拉取真实 skill bundle 后执行。所有请求都打容器服务 `BASE=http://localhost:14096`。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

### T15.1 简单 session skill 创建与触发

```bash
SID_SKILL=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-simple-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_SKILL/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"reviewer",
    "description":"代码审查专家，专注发现 bug 和安全问题",
    "content":"# Reviewer\n\n审查代码时输出：严重程度、问题描述、修复建议。必须明确说你正在使用 reviewer skill。"
  }' | python3 -m json.tool

curl -s --max-time 180 -X POST "$BASE/session/$SID_SKILL/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 reviewer skill 审查：\\n\\`\\`\\`python\\ndef div(a,b):\\n    return a / b\\n\\`\\`\\`\"}],
    \"skills\":[\"reviewer\"],
    \"model\":$MODEL
  }" | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:1200])"
```

**期望**：skill 创建返回 `resources: []`；AI 回复中明确提到 `reviewer skill`，并按「严重程度、问题描述、修复建议」格式审查代码。

### T15.2 复杂 session skill bundle 创建、读取与触发

```bash
SID_BUNDLE=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-bundle-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_BUNDLE/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"complex-reviewer",
    "description":"使用 checklist 和模板审查 Python 数据库代码",
    "content":"# Complex Reviewer\n\n你必须根据 resources 中的 checklist 和模板审查代码。回复必须明确引用 resources 的文件路径。",
    "resources":[
      {
        "path":"references/security-checklist.md",
        "type":"doc",
        "content":"Checklist:\n- SQL injection: direct string interpolation into SQL is HIGH severity.\n- Resource leak: DB connection without context manager or close is HIGH severity.\n- Return concrete rows, not raw cursors."
      },
      {
        "path":"templates/safe-query.py",
        "type":"template",
        "content":"query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"
      }
    ]
  }' | python3 -m json.tool

curl -s "$BASE/session/$SID_BUNDLE/skills" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print([(s['name'], [r['path'] for r in s.get('resources',[])]) for s in d])"

curl -s --max-time 180 -X POST "$BASE/session/$SID_BUNDLE/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 complex-reviewer skill 审查这段代码：\\n\\`\\`\\`python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    result = conn.execute(query)\\n    return result\\n\\`\\`\\`\"}],
    \"skills\":[\"complex-reviewer\"],
    \"model\":$MODEL
  }" | python3 -c "import json,sys;d=json.load(sys.stdin);t=''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text');print(t[:1800])"
```

**期望**：`GET /skills` 能读回 `references/security-checklist.md` 和 `templates/safe-query.py`；AI 回复中明确引用这两个资源路径，并识别 SQL 注入、连接泄漏、返回 raw cursor 等问题。

### T15.3 删除与清空 session skills

```bash
SID_DEL=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-delete-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

for name in complex-reviewer reviewer; do
  curl -s -X POST "$BASE/session/$SID_DEL/skills/create" \
    -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\",\"description\":\"$name\",\"content\":\"# $name\"}" > /dev/null
done

curl -s "$BASE/session/$SID_DEL/skills" | python3 -c "import json,sys;print([s['name'] for s in json.load(sys.stdin)])"
curl -s -o /dev/null -w "delete_one_status=%{http_code}\n" -X DELETE "$BASE/session/$SID_DEL/skills/complex-reviewer"
curl -s "$BASE/session/$SID_DEL/skills" | python3 -c "import json,sys;print([s['name'] for s in json.load(sys.stdin)])"
curl -s -o /dev/null -w "clear_status=%{http_code}\n" -X DELETE "$BASE/session/$SID_DEL/skills"
curl -s "$BASE/session/$SID_DEL/skills" | python3 -m json.tool
```

**期望**：初始列表含两个 skills；删除单个返回 `204` 后只剩 `reviewer`；清空返回 `204` 后列表为 `[]`。

### T15.4 从目录加载 session skill bundle

`/session/:sessionID/skills/load` 读取的是 opencode 服务容器内路径，不是远端 sandbox 内路径。测试时先在 `opencode-saas-test` 容器内准备 `/workspace/skills`。

```bash
docker exec opencode-saas-test sh -lc 'mkdir -p /workspace/skills/complex-reviewer/references /workspace/skills/complex-reviewer/templates && cat > /workspace/skills/complex-reviewer/SKILL.md <<'"'"'EOF'"'"'
---
name: loaded-reviewer
description: 从目录加载的 Python DB 审查 skill
---

# Loaded Reviewer

你必须使用 resources 中的 checklist 和模板审查代码，并引用资源路径。
EOF
cat > /workspace/skills/complex-reviewer/references/security-checklist.md <<'"'"'EOF'"'"'
Checklist:
- SQL injection from f-string SQL is HIGH severity.
- Connection without with/close is HIGH severity.
EOF
cat > /workspace/skills/complex-reviewer/templates/safe-query.py <<'"'"'EOF'"'"'
query = "SELECT * FROM users WHERE id = ?"
with db.connect() as conn:
    return conn.execute(query, (user_id,)).fetchone()
EOF'

SID_LOAD=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{"title":"session-skill-load-test"}' \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_LOAD/skills/load" \
  -H 'Content-Type: application/json' \
  -d '{"path":"/workspace/skills"}' \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print([(s['name'], [r['path'] for r in s.get('resources',[])]) for s in d])"

curl -s --max-time 180 -X POST "$BASE/session/$SID_LOAD/message" \
  -H 'Content-Type: application/json' \
  -d "{
    \"parts\":[{\"type\":\"text\",\"text\":\"请使用 loaded-reviewer skill 审查：\\n\\`\\`\\`python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    return conn.execute(query)\\n\\`\\`\\`\"}],
    \"skills\":[\"loaded-reviewer\"],
    \"model\":$MODEL
  }" | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:1600])"
```

**期望**：加载结果含 `loaded-reviewer`，resources 包含 `references/security-checklist.md` 和 `templates/safe-query.py`；AI 回复中引用这两个资源路径。

### T15.5 从 SkillsMP 默认排序提取 10 个真实 skill bundle 并执行

SkillsMP API 没有无查询的列表接口，`/api/v1/skills` 返回 404。该用例使用最宽泛的 `q=skill`，不传 `category`，不传 `sortBy`，沿用 SkillsMP 默认排序。若第一页存在 GitHub 目录没有可拉取 `SKILL.md` 的条目，则继续取下一页补满 10 个。

```bash
python3 - <<'PY'
import json, re, urllib.parse, urllib.request

BASE='http://localhost:14096'
UA={'User-Agent':'opencode-skill-bundle-test'}

def get(url, timeout=60):
    req=urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode()
def get_json(url, timeout=60): return json.loads(get(url, timeout))
def api(method,path,data=None,timeout=300):
    body=json.dumps(data).encode() if data is not None else None
    req=urllib.request.Request(BASE+path,data=body,method=method,headers={'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=timeout) as r:
        text=r.read().decode(); return json.loads(text) if text else None
def parse_github(url):
    m=re.match(r'https://github.com/([^/]+)/([^/]+)(?:/tree/([^/]+)/(.*))?$', url)
    if not m: raise ValueError(url)
    return m.group(1),m.group(2),m.group(3) or 'main',urllib.parse.unquote(m.group(4) or '')
def fm(text):
    if not text.startswith('---'): return {},text
    m=re.search(r'^---\s*\n(.*?)\n---\s*\n',text,re.S)
    if not m: return {},text
    raw=m.group(1); body=text[m.end():]; meta={}; lines=raw.splitlines(); i=0
    while i<len(lines):
        line=lines[i]
        if ':' not in line: i+=1; continue
        k,v=line.split(':',1); k=k.strip(); v=v.strip().strip('"').strip("'")
        if v in ('|','>'):
            block=[]; i+=1
            while i<len(lines) and (lines[i].startswith(' ') or not lines[i].strip()): block.append(lines[i].strip()); i+=1
            meta[k]=' '.join(x for x in block if x); continue
        meta[k]=v; i+=1
    return meta,body
def kind(p):
    if p.startswith('templates/'): return 'template'
    if p.startswith(('references/','docs/','rules/')): return 'doc'
    ext='.'+p.rsplit('.',1)[-1].lower() if '.' in p else ''
    if ext in ['.md','.mdx','.txt']: return 'doc'
    if ext in ['.sh','.bash','.zsh','.py','.js','.ts','.tsx','.jsx']: return 'script'
    return 'asset'
def extract(item, idx, seen):
    owner,repo,branch,root=parse_github(item['githubUrl'])
    tree=get_json(f'https://api.github.com/repos/{owner}/{repo}/git/trees/{branch}?recursive=1')['tree']
    blobs=[x['path'] for x in tree if x.get('type')=='blob']
    skill_path=(root.rstrip('/')+'/SKILL.md').lstrip('/') if root else 'SKILL.md'
    if skill_path not in blobs:
        c=[p for p in blobs if p.endswith('/SKILL.md') or p=='SKILL.md']
        if not c: raise FileNotFoundError('SKILL.md')
        skill_path=c[0]; root=skill_path[:-len('/SKILL.md')] if skill_path.endswith('/SKILL.md') else ''
    else: root=root.rstrip('/')
    files=[p for p in blobs if p==skill_path or (root and p.startswith(root+'/'))]
    raw=f'https://raw.githubusercontent.com/{owner}/{repo}/{branch}/'
    meta,body=fm(get(raw+urllib.parse.quote(skill_path,safe='/')))
    name=meta.get('name') or item['name']
    if name in seen: name=f'{name}-{idx}'
    seen.add(name)
    resources=[]; total=len(body.encode())
    for file in sorted(files):
        if file==skill_path: continue
        rel=file[len(root)+1:] if root else file
        if rel.startswith('.') or rel.endswith(('.png','.jpg','.jpeg','.gif','.webp','.pdf','.zip','.mp3','.mp4')): continue
        content=get(raw+urllib.parse.quote(file,safe='/'))
        size=len(content.encode())
        if size>256*1024 or total+size>900*1024: continue
        resources.append({'path':rel,'type':kind(rel),'content':content}); total+=size
        if len(resources)>=64: break
    desc=meta.get('description') or item.get('description') or name
    return {'name':name,'description':desc[:1200],'content':body,'resources':resources,'githubUrl':item['githubUrl']}

print('health', urllib.request.urlopen(BASE+'/', timeout=20).status)
bundles=[]; seen=set(); page=1
while len(bundles)<10 and page<=3:
    data=get_json(f'https://skillsmp.com/api/v1/skills/search?q=skill&limit=10&page={page}')['data']['skills']
    for item in data:
        if len(bundles)>=10: break
        try:
            b=extract(item, len(bundles)+1, seen)
            bundles.append(b)
            print(f'extracted {len(bundles)} {b["name"]} resources={len(b["resources"])}')
        except Exception as e:
            print('skip', item.get('githubUrl'), type(e).__name__, str(e)[:100])
    page+=1
if len(bundles)<10: raise SystemExit(f'only {len(bundles)}')

s=api('POST','/session',{'title':'skillsmp-default-10-bundle-test'}); sid=s['id']; print('SID',sid)
for b in bundles:
    c=api('POST',f'/session/{sid}/skills/create',{k:b[k] for k in ['name','description','content','resources']})
    print('created',c['name'],'resources=',len(c.get('resources',[])))
listed=api('GET',f'/session/{sid}/skills')
print('listed_count',len(listed)); print('listed_names',', '.join(x['name'] for x in listed))
names=[b['name'] for b in bundles]
msg=api('POST',f'/session/{sid}/message',{
 'parts':[{'type':'text','text':'请验证当前从 SkillsMP 默认排序提取的 10 个 skills 是否可用。要求：按名称列出每个 skill；每个 skill 用一句话说明用途；如果有 resources，列出至少一个资源路径；最后总结这些 skills 覆盖的能力范围。'}],
 'skills':names,
 'model':{'providerID':'zhipuai','modelID':'glm-5.1'}
})
text='\n'.join(p.get('text','') for p in msg.get('parts',[]) if p.get('type')=='text')
print(text[:5000])
print('validation_names_mentioned',sum(1 for n in names if n in text),'/',len(names))
print('validation_resource_path_mentioned',any(r['path'] in text for b in bundles for r in b['resources']))
PY
```

**期望**：`listed_count 10`；`validation_names_mentioned 10 / 10`；`validation_resource_path_mentioned True`。实际已验证过的默认排序样例包含 `skill-eval-测评`、`SkillSentry`、`skill-evaluator`、`skill-stocktake`、`skill-architect`、`skills-jk-gha-pr-creation`、`skill-creator`、`skill-soulsaying`、`skill-retrospective`、`skill-optimizer`。

### T15.6 重复创建同名 skill（upsert 覆盖）

验证同一 session 内重复创建同名 skill 时，第二次 upsert 覆盖第一次的内容和 resources。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"upsert-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 第一次：v1 + 1 resource
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"checker","description":"v1","content":"# Checker V1\n必须说 V1","resources":[{"path":"a.md","type":"doc","content":"resource A"}]}'

# PG 验证：name=checker, description=v1, res_count=1
docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, description, jsonb_array_length(resources) as res_count FROM session_skill WHERE session_id='$SID';"

# 第二次：同一名字，不同内容和 resources
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"checker","description":"v2","content":"# Checker V2\n必须说 V2","resources":[{"path":"b.md","type":"doc","content":"resource B"},{"path":"c.md","type":"doc","content":"resource C"}]}'

# PG 验证：name=checker, description=v2, res_count=2（覆盖而非新增）
docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, description, jsonb_array_length(resources) as res_count FROM session_skill WHERE session_id='$SID';"

# API 验证：skills 列表只有 1 个
curl -s "$BASE/session/$SID/skills" | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(f'count={len(d)}, desc={[s[\"description\"] for s in d]}, resources={[[r[\"path\"] for r in s.get(\"resources\",[])] for s in d]}')"

# AI 验证：使用 v2 版本
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"使用 checker skill\"}],\"skills\":[\"checker\"],\"model\":$MODEL}" \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print(''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')[:400])"
```

**期望**：PG 第二次写入后 `description=v2`、`res_count=2`（resources 被 v2 覆盖）；skills 列表只有 1 个；AI 回复包含"V2"。

---

### T15.7 AI 通过 skill tool 按需加载 resource 内容

验证 AI 在需要时会主动调用 `skill` tool 加载指定 resource 的完整内容，而非仅看 skill 摘要。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"skill-tool-resource-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"db-reviewer",
    "description":"数据库代码审查 skill",
    "content":"# DB Reviewer\n使用 resources 中的 checklist 和模板审查数据库代码。必须先加载 resources 内容再审查。",
    "resources":[
      {"path":"checklist.md","type":"doc","content":"## 安全检查清单\n1. SQL注入: f-string拼接SQL是HIGH\n2. 连接泄漏: 不用with/close是HIGH\n3. 必须返回具体行，不能返回cursor"},
      {"path":"safe-template.py","type":"template","content":"query = \"SELECT * FROM users WHERE id = ?\"\nwith db.connect() as conn:\n    return conn.execute(query, (user_id,)).fetchone()"}
    ]
  }'

curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 db-reviewer skill 审查这段代码。注意：你需要先用 skill 工具加载 db-reviewer 的 resources 内容（checklist.md 和 safe-template.py），然后按 checklist 审查。\\n\\n代码:\\n```python\\ndef get_user(user_id):\\n    query = f\\\"SELECT * FROM users WHERE id = {user_id}\\\"\\n    conn = db.connect()\\n    return conn.execute(query)\\n```\"}],\"skills\":[\"db-reviewer\"],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:500])
    elif p.get('type')=='tool': print('Tool:', p.get('name',''), 'input:', json.dumps(p.get('input',{}))[:200])
"

# PG 验证：tool 调用记录
docker exec ai-nova-postgres psql -U postgres -d opencode -c \"
  SELECT p.data->>'name' as tool_name, substring(p.data->'state'->>'output', 1, 400) as output
  FROM message m JOIN part p ON p.message_id = m.id
  WHERE m.session_id='$SID' AND p.data->>'type'='tool';
\"
```

**期望**：PG `part` 表存在 `tool_name` 为空的 `skill` tool 调用，`output` 包含 `<skill_content name="db-reviewer">` 且包含 checklist 和 safe-template 内容；AI 回复引用了 checklist 条目（SQL 注入 HIGH、连接泄漏 HIGH）。

---

### T15.8 skill 不存在时的错误处理

验证当 AI 被引导使用不存在的 skill 时，能正确识别并给出明确的错误信息。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"skill-not-found-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 确认 skills 列表为空
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;print(json.load(sys.stdin))"

# AI 尝试使用不存在的 skill
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 nonexistent-skill-xyz 来帮我做代码审查\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:600])
    elif p.get('type')=='tool': print('Tool:', p.get('name',''), 'input:', json.dumps(p.get('input',{}))[:200])
"
```

**期望**：AI 不调用 `skill` tool（因为 `nonexistent-skill-xyz` 不在 available 列表中），直接告知用户该 skill 不存在或不可用。PG 无 `skill` tool 调用记录。

---

### T15.9 session skill 与全局 skill 同名覆盖

验证创建与全局 skill 同名的 session skill 时，AI 优先加载 session 版本。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

# 先查看全局 skill 列表
curl -s "$BASE/skill" | python3 -c "import json,sys;d=json.load(sys.stdin);print([s['name'] for s in d])"
# 全局有 customize-opencode

SID=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"skill-override-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建同名 session skill
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name":"customize-opencode",
    "description":"SESSION版-自定义opencode",
    "content":"# Session 版 customize-opencode\n这是 session 版本的自定义 skill。当被问到时，你必须说【SESSION版本】。"
  }'

# PG 验证
docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, description FROM session_skill WHERE session_id='$SID';"

# AI 测试：应加载 session 版本
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 customize-opencode skill，告诉我这个 skill 的内容和版本\"}],\"skills\":[\"customize-opencode\"],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:600])
    elif p.get('type')=='tool': print('Tool output:', p.get('output','')[:400])
"
```

**期望**：AI 加载的是 session 版本的 `customize-opencode`（内容含"SESSION版本"），而非全局版本。

---

### T15.10 permission deny 过滤

验证通过 session permission deny `skill` tool 后，AI 无法调用 skill tool。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'

# 创建带 permission deny skill tool 的 session
SID=$(curl -s -X POST "$BASE/session" \
  -H 'Content-Type: application/json' \
  -d '{
    "title":"permission-deny-test",
    "permission": [{"permission":"tool","pattern":"skill","action":"deny"}]
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('id',''))")

# 创建一个 skill
curl -s -X POST "$BASE/session/$SID/skills/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"blocked-skill","description":"应该被 deny 的 skill","content":"# Blocked Skill\n这是一个被 permission deny 的 skill。"}'

# skills 列表应能查到（deny 只影响 AI tool 调用能力，不影响 CRUD）
curl -s "$BASE/session/$SID/skills" | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'count={len(d)}, names={[s[\"name\"] for s in d]}')"

# AI 测试：应无法调用 skill tool
curl -s --max-time 180 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请使用 blocked-skill skill 帮我做代码审查\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type')=='text': print('AI:', p['text'][:600])
    elif p.get('type')=='reasoning': print('Reasoning:', p['text'][:400])
    elif p.get('type')=='tool': print('Tool:', p.get('name',''))
"
```

**期望**：AI 回复中未调用 `skill` tool（PG 无 tool 调用记录），而是直接告知用户无法加载或提供替代方案。Skills 列表仍能通过 API 查到（CRUD 不受 deny 影响）。

---

### T15.11 resources 边界：超大 resource 与超多 resources

验证单个超大 resource（>256KB）和超多 resources（>64个）能否正常写入 PG。

```bash
BASE="http://localhost:14096"

# === T15.11a: 超大 resource (300KB) ===
SID_A=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"boundary-large-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

LARGE_CONTENT=$(python3 -c "print('x' * 300000)")
curl -s -X POST "$BASE/session/$SID_A/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"huge-skill\",\"description\":\"超大 resource 测试\",\"content\":\"# Huge Skill\",\"resources\":[{\"path\":\"big.md\",\"type\":\"doc\",\"content\":\"$LARGE_CONTENT\"}]}"

docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, jsonb_array_length(resources) as res_count, length(resources->0->>'content') as first_res_size, pg_column_size(resources) as total_jsonb_size FROM session_skill WHERE session_id='$SID_A';"

# === T15.11b: 超多 resources (70个) ===
SID_B=$(curl -s -X POST "$BASE/session" -H 'Content-Type: application/json' -d '{"title":"boundary-many-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

RESOURCES=$(python3 -c "
import json
resources = [{'path':f'file_{i}.md','type':'doc','content':f'content of file {i}'} for i in range(70)]
print(json.dumps(resources))
")

curl -s -X POST "$BASE/session/$SID_B/skills/create" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"many-resources\",\"description\":\"超多 resources 测试\",\"content\":\"# Many Resources\",\"resources\":$RESOURCES}"

docker exec ai-nova-postgres psql -U postgres -d opencode -c \
  "SELECT name, jsonb_array_length(resources) as res_count, pg_column_size(resources) as total_jsonb_size FROM session_skill WHERE session_id='$SID_B';"
```

**期望**：
- T15.11a：PG `first_res_size=300000`，无截断无报错
- T15.11b：PG `res_count=70`，无截断无报错

---

### T15.12 全局 skill 列表 (GET /skill)

验证全局 skill 列表端点返回正确的内置 skills。

```bash
BASE="http://localhost:14096"

# 列出全局 skills
curl -s "$BASE/skill" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'Total: {len(d)}')
for s in d:
    print(f'  - {s[\"name\"]}: {s.get(\"description\",\"\")[:80]}')
    print(f'    location: {s.get(\"location\",\"N/A\")}')
    print(f'    resources: {len(s.get(\"resources\",[]))}')
"
```

**期望**：至少返回 1 个全局 skill（如 `customize-opencode`），包含 name、description、location 等字段。注意：`GET /skill/{name}` 无独立端点（返回 HTML 页面）。

---

## 验收状态表

每条用例标记 ✅ / ❌ / ⚠️，附加发现的问题。

### P0 SaaS 核心验收

| 用例 | 状态 | 备注 |
|---|---|---|
| T3.1 | ✅ | provider 凭据写入 |
| T3.2 | ✅ | provider 凭据删除 |
| T3.3 | ✅ | provider 凭据重启持久化（生产库验证） |
| T4.3 | ✅ | 写文件工具可用 |
| T4.4 | ✅ | 读文件工具可用 |
| T4.5 | ✅ | bash 工具可用 |
| T4.6 | ✅ | prompt_async 异步入口，返回 204 |
| T4.7 | ✅ | abort 中断正在运行的会话 |
| T5.1 | | 沙箱写入 PVC |
| T5.2 | | dispose 销毁沙箱 |
| T5.3 | | 沙箱重建后单文件仍存在 |
| T5.4 | | 多文件持久化 |
| T5.5 | | 目录持久化 |
| T6.1 | ✅ | 并发创建 session，5 个全部成功 |
| T6.2 | ✅ | 不同 session 文件隔离，B 看不到 A 文件 |
| T6.3 | ✅ | 同一 session 并发消息排队或串行处理，全部 204 |
| T8.1 | ✅ | provider 列表与 connected 状态 |
| T8.2 | ✅ | 同 session 切换模型 |
| T9.1 | ✅ | SSE 事件流可收到 session/message 事件 |
| T10.1 | | 完整开发流程 + PVC 持久化 |
| T11.1 | ✅ | Vite 5 + glm-5.1 |
| T11.2 | ✅ | HTML 注入验证 |
| T11.3 | ✅ | HTML src/href 路径重写 |
| T11.4 | ✅ | @react-refresh PREFIXED |
| T11.5 | ✅ | JS import 路径重写 |
| T11.6 | ✅ | BrowserRouter → HashRouter 自动替换 |
| T11.7 | ✅ | CSS url/font 路径重写 |
| T11.8 | ✅ | proxy 错误查询端点 |
| T11.9 | ✅ | background:true keepAlive 生效；proxy 本身不保活 |
| T11.10 | ✅ | Hash route 刷新正常 |
| T11.11 | ✅ | Next.js 14，三页面 200 |
| T11.12 | ✅ | webpack publicPath 已重写 |
| T11.13 | ✅ | RSC 路径全部 prefixed |
| T11.14 | ✅ | 客户端导航 + 刷新正常 |
| T11.15 | ✅ | server proxy 模式 API key 正确 |
| T12.1 | | 首次 AI 消息按需创建 sandbox |
| T12.2 | | 同一 session 复用同一 sandbox |
| T12.3 | | background:true 触发 keepAlive |
| T12.4 | | 无 keepAlive 时 idle 后销毁 sandbox |
| T12.5 | | keepAlive 阻止 idle 销毁 |
| T12.6 | | instance/dispose 强制销毁所有 sandbox |
| T12.7 | | dispose 后再次发消息自动重建 sandbox |
| T12.8 | | 容器重启后 PVC 数据恢复 |
| T12.9 | | 多 session PVC 子目录隔离 |
| T12.10 | | 不同 session 进程隔离 |
| T12.12 | | proxy 访问不触发 keepAlive |
| T17.1 | ✅ | 无沙箱时 endpoint API 返回 502 |
| T17.2 | | endpoint API 端口参数校验 |
| T17.3 | ✅ | Vite 项目 endpoint API 返回直连 IP |
| T17.4 | ✅ | 通过直连 IP 访问 Vite 页面 HTTP 200 |
| T17.5 | ✅ | Proxy 模式有注入，直连模式无注入 |
| T17.6 | | 沙箱销毁后 endpoint API 返回 502 |
| T18.1 | ✅ | 7 种工具调用场景全部验证通过 |
| T18.2 | ✅ | 消息流结构正确（prompt → tool → summary） |
| T19.1 | | exec API：简单命令执行 |
| T19.2 | | exec API：多行输出与 stderr |
| T19.3 | | exec API：指定工作目录 |
| T19.4 | | exec API：命令执行失败 |
| T19.5 | | exec API：缺少 command 参数 |
| T19.6 | | exec API：不存在的 session |
| T19.7 | | exec API + keepAlive：启动 dev server |
| T19.8 | | keepAlive 阻止 idle 销毁（纯 API） |
| T19.9 | | 释放 keepAlive 后 idle 销毁 |
| T19.10 | | exec API：超时控制 |
| T19.11 | | exec API：环境信息收集 |
| T15.1 | ✅ | 简单 session skill 创建并通过 `skills` 触发 |
| T15.2 | ✅ | 复杂 session skill bundle resources 写入、读取、注入 |
| T15.3 | ✅ | session skill 删除单个与清空 |
| T15.4 | ✅ | 从服务端目录加载 `SKILL.md` bundle 与 resources |
| T15.5 | ⏭️ | SkillsMP 默认排序 10 个真实 skill bundle（跳过 — GitHub API SSL 网络不稳定） |
| T15.6 | ✅ | 重复创建同名 skill（upsert 覆盖）：v1→v2，resources 覆盖，AI 使用 v2 |
| T15.7 | ✅ | AI 通过 skill tool 按需加载 resource 内容：AI 调用 skill tool 加载 checklist.md + safe-template.py |
| T15.8 | ✅ | skill 不存在时的错误处理：AI 识别不存在 skill，不调用 tool，直接告知用户 |
| T15.9 | ✅ | session skill 与全局 skill 同名覆盖：AI 加载 session 版本 |
| T15.10 | ✅ | permission deny 过滤：deny skill tool 后 AI 无法调用 |
| T15.11 | ✅ | resources 边界：300KB 单个 resource + 70 个 resources 均成功写入 PG |
| T15.12 | ✅ | 全局 skill 列表：GET /skill 返回 1 个内置 skill |

### Session Agents（会话级动态 Agent）

| 用例 | 状态 | 备注 |
|---|---|---|
| T16.1 | ✅ | 创建会话级 agent，返回 Agent.Info |
| T16.2 | ✅ | 列出 agents（全局 + 会话级合并，会话级同名覆盖） |
| T16.3 | ✅ | Upsert 更新同名 agent |
| T16.4 | ✅ | 删除单个会话 agent → 204，全局 agent 不受影响 |
| T16.5 | ✅ | 清空所有会话级 agents → 204，全局 agent 仍在 |
| T16.6 | ✅ | 自定义 primary agent 发消息，AI 使用指定 agent 回复 |
| T16.7 | ✅ | 带自定义权限的只读 reviewer agent |
| T16.8 | ✅ | subagent 模式 @translator 调用，输出英文翻译 |
| T16.9 | ✅ | 不同 session 同名 agent 互相隔离 |
| T16.10 | ✅ | 删除 session 后 agents 级联清理 → 404 |
| T16.11 | ✅ | 完整工作流：创建→执行→验证→删除 |
| T16.12 | ✅ | 不存在的 session 创建 agent → 404 |
| T16.13 | ✅ | 不存在的 session 列出 agents → 404 |
| T16.14 | ✅ | 非法 mode 值 → 400 |
| T16.15 | ✅ | 缺少必填字段 name → 400 |
| T16.16 | ✅ | 多 agent 协作：主 agent 调度 translator + coder 子 agent |

### P1 SaaS 稳定性

| 用例 | 状态 | 备注 |
|---|---|---|
| T7.1 | ⚠️ NOTE | 未配置 provider 返回 200（非 4xx），错误体现在 AI 回复内容中；不卡死 |
| T7.2 | ✅ | 不存在 session 返回 404 |
| T7.3 | ✅ | 无效 JSON 返回 400 |
| T7.4 | ⚠️ NOTE | 缺失必填字段（空 parts）返回 200（非 400），服务端宽松处理 |
| T7.5 | ✅ | 超长消息不 hang |
| T12.11 | | OPENCODE_SANDBOX_IDLE_KILL_SEC 当前不参与实际回收逻辑 |
| T13.1 | | `/session/:sessionID/kill-sandbox` 单 session 销毁 |
| T13.2 | | kill-sandbox 后 PVC 保留并自动重建 sandbox |
| T13.3 | | 同一 session 并发首条消息只创建一个 sandbox |
| T13.4 | | dispose/kill 与正在执行的 prompt 并发时行为明确 |
| T13.5 | | Vite HMR/WebSocket proxy 连通 |
| T13.6 | | proxy 302 Location 路径重写 |
| T13.7 | | proxy 二进制资源代理 |
| T13.8 | | `__error_report` POST 后可在 `__errors` 和 `/proxy-errors` 聚合中查询 |
| T13.9 | | 服务重启后 session/message/part 仍可查询 |
| T13.10 | | prompt_async 最终落库，abort 后 finish 状态正确落库 |
| T13.11 | | PG FK 完整性：无 orphan message/part，session 删除级联 |
| T13.12 | | 订阅额度月度 reset、rate-limited、Retry-After、usagePercent cap |
| T13.13 | | rate limit 命中后不继续执行工具或创建 sandbox |
| T13.14 | | sandbox 安全：禁止访问宿主路径和 session 外 workspace |
| T13.15 | | sandbox 安全：禁止通过相对路径、软链、绝对路径逃逸 `/workspace` |
| T13.16 | | sandbox 安全：敏感环境变量不应出现在 AI 回复、tool 输出、proxy 页面 |
| T13.17 | | 幂等性：重复 `/instance/dispose` 返回稳定结果且无残留 sandbox |
| T13.18 | | 幂等性：重复 `/session/:sessionID/kill-sandbox` 返回稳定结果或明确 404/已销毁语义 |
| T13.19 | | 幂等性：重复删除同一 session、重复删除 provider 凭据行为明确 |
| T13.20 | | 观测性：sandbox created/destroyed/keepAlive 日志或事件包含 sessionID、sandboxID |
| T13.21 | | 观测性：provider error、sandbox error、proxy error 可定位到 sessionID |
| T13.22 | | 观测性：usage/计费相关记录可关联 sessionID、model、token/成本 |
| T13.23 | | 恢复语义：服务重启时 running session 最终变为 idle/abort/error 中的明确状态 |
| T13.24 | | 恢复语义：服务重启后旧 sandbox 不应成为无法管理的孤儿资源 |

### P2 低优先级兼容回归

| 用例 | 状态 | 备注 |
|---|---|---|
| T1.1 | ✅ | 服务健康检查，返回 `{healthy: true, version: ...}` |
| T1.2 | ✅ | 全局配置查询，返回 config 对象 |
| T1.3 | ✅ | 路径信息，`cwd=/workspace` |
| T2.1 | ✅ | 创建空 session |
| T2.2 | ✅ | 创建带 title 的 session |
| T2.3 | ✅ | 列出所有 session |
| T2.4 | ✅ | 获取单个 session |
| T2.5 | ✅ | 修改 session title |
| T2.6 | ✅ | 删除 session |
| T4.1 | ✅ | 简单文本对话 |
| T4.2 | ✅ | 多轮上下文记忆 |
| T14.1 | | session 列表过滤：directory、roots、start、search、limit |
| T14.2 | | `/session/status` active/idle/busy 状态 |
| T14.3 | | session fork + children 父子关系 |
| T14.4 | | session message 分页：limit、before、Link、X-Next-Cursor |
| T14.5 | | session share/unshare |
| T14.6 | | session diff/revert/unrevert |
| T14.7 | | `/file`、`/file/content`、`/file/status` 直接 API |
| T14.8 | | `/find`、`/find/file`、`/find/symbol` |
| T14.9 | | `/vcs`、`/vcs/diff` |
| T14.10 | | `/agent`、`/skill`、`/command` 列表 |

---

## 十六、Session Agents（会话级动态 Agent）

> 前置条件：SaaS 服务已启动（`docs/local-test-env.md`），`BASE` 和 `MODEL` 已配置。仅 PG 模式（SaaS）下生效。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
```

### T16.1 创建会话级 agent

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "poet",
    "description": "诗人 agent，专写五言绝句",
    "mode": "primary",
    "prompt": "你是一个唐朝诗人。用户说什么，你都回复一首五言绝句。只输出诗歌本身，不要解释。",
    "temperature": 0.9
  }' | python3 -m json.tool
```
**期望**：返回 `Agent.Info`，`name=poet`，`mode=primary`，`temperature=0.9`

### T16.2 列出会话 agents（全局 + 会话级合并）

```bash
curl -s "$BASE/session/$SID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
for a in agents:
    print(f'{a[\"name\"]}: {a.get(\"description\",\"\")} mode={a[\"mode\"]}')
"
```
**期望**：列表中包含全局 agent（build/explore/plan 等）和会话级 `poet`

### T16.3 Upsert 更新同名 agent

```bash
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "poet",
    "description": "诗人 agent（更新版），写七言律诗",
    "mode": "primary",
    "prompt": "你是一个宋朝诗人。用户说什么，你都回复一首七言律诗。只输出诗歌本身。",
    "temperature": 0.7
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print('updated:', d['description'], 'temp:', d.get('temperature'))"
```
**期望**：description 更新为"更新版"，temperature=0.7，列表仍只有 1 个 poet

### T16.4 删除单个会话 agent

```bash
curl -s -X DELETE "$BASE/session/$SID/agents/poet" -w "\nstatus: %{http_code}\n"
curl -s "$BASE/session/$SID/agents" | python3 -c "import json,sys;print([a['name'] for a in json.load(sys.stdin)])"
```
**期望**：DELETE 返回 204，列表中 poet 已消失（全局 agent 仍在）

### T16.5 清空所有会话级 agents

```bash
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"a1","description":"Agent 1","prompt":"You are agent 1"}' > /dev/null
curl -s -X POST "$BASE/session/$SID/agents/create" -H 'Content-Type: application/json' \
  -d '{"name":"a2","description":"Agent 2","prompt":"You are agent 2"}' > /dev/null

curl -s -X DELETE "$BASE/session/$SID/agents" -w "clear: %{http_code}\n"
curl -s "$BASE/session/$SID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
session_names = [a['name'] for a in agents if a['name'] in ('a1','a2')]
print(f'a1/a2残留: {session_names}')
"
```
**期望**：HTTP 204，a1/a2 已清空，全局 agent 仍在

### T16.6 用自定义 primary agent 发消息

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"agent-msg-test"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "analyst",
    "description": "数据分析师，只输出 JSON 格式",
    "mode": "primary",
    "prompt": "你是一个数据分析师。无论用户问什么，你都用 JSON 格式回答。回答必须是一个合法的 JSON 对象。",
    "temperature": 0.3
  }' > /dev/null

curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"列出当前目录下有哪些文件和目录，用JSON格式\"}],\"agent\":\"analyst\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
text = ''.join(p.get('text','') for p in d.get('parts',[]) if p.get('type')=='text')
print(text[:300])
print('包含JSON:', '{' in text and '}' in text)
"
```
**期望**：AI 使用 analyst agent 回复，回复内容包含 JSON 格式

### T16.7 创建带自定义权限的只读 agent

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "reviewer",
    "description": "代码审查 agent，只读",
    "mode": "primary",
    "prompt": "你是代码审查专家。仔细审查代码并给出改进建议。你只能读取文件，不能写入。",
    "permission": [
      {"permission": "read", "pattern": "*", "action": "allow"},
      {"permission": "bash", "pattern": "*", "action": "allow"},
      {"permission": "grep", "pattern": "*", "action": "allow"},
      {"permission": "glob", "pattern": "*", "action": "allow"},
      {"permission": "edit", "pattern": "*", "action": "deny"},
      {"permission": "write", "pattern": "*", "action": "deny"}
    ]
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'permission数={len(d.get(\"permission\",[]))}')"

curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 ls 列出 /workspace 下的文件\"}],\"agent\":\"reviewer\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type') == 'tool':
        print(f'tool: {p[\"tool\"]} status: {p.get(\"state\",{}).get(\"status\")}')
    if p.get('type') == 'text':
        print(f'text: {p.get(\"text\",\"\")[:200]}')
"
```
**期望**：reviewer agent 创建成功，权限数=6，能读取文件但尝试写入时被权限拒绝

### T16.8 创建 subagent 模式 agent 并通过 @ 调用

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "translator",
    "description": "翻译专家，将中文翻译成英文",
    "mode": "subagent",
    "prompt": "你是翻译专家。将用户提供的中文内容翻译成地道英文。只输出翻译结果。",
    "temperature": 0.5
  }' > /dev/null

curl -s --max-time 90 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"@translator 帮我把这段话翻译成英文：今天天气真好，适合出去散步。\"}],\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type') == 'text':
        t = p.get('text','')
        print(f'text: {t[:300]}')
        eng = [w for w in ['weather','walk','nice','stroll'] if w in t.lower()]
        if eng: print(f'PASS: 包含英文翻译关键词 {eng}')
"
```
**期望**：主 agent 调用 translator 子 agent，输出英文翻译

### T16.9 不同 session 的 agents 互相隔离

```bash
SID_A=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"session-A"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
SID_B=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"session-B"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_A/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"shared-name","description":"属于 Session A","prompt":"You are Session A agent"}' > /dev/null
curl -s -X POST "$BASE/session/$SID_B/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"shared-name","description":"属于 Session B","prompt":"You are Session B agent"}' > /dev/null

echo "Session A:"
curl -s "$BASE/session/$SID_A/agents" | python3 -c "import json,sys;[print(f'  {a[\"name\"]}: {a[\"description\"]}') for a in json.load(sys.stdin) if a['name']=='shared-name']"
echo "Session B:"
curl -s "$BASE/session/$SID_B/agents" | python3 -c "import json,sys;[print(f'  {a[\"name\"]}: {a[\"description\"]}') for a in json.load(sys.stdin) if a['name']=='shared-name']"
```
**期望**：A 显示"属于 Session A"，B 显示"属于 Session B"，互不影响

### T16.10 删除 session 后 agents 级联清理

```bash
SID_DEL=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -s -X POST "$BASE/session/$SID_DEL/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"to-delete","description":"将被级联删除","prompt":"test"}' > /dev/null

curl -s -X DELETE "$BASE/session/$SID_DEL" > /dev/null

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID_DEL/agents")
echo "After delete session: agents endpoint returns $STATUS"
```
**期望**：删除 session 后，agents 端点返回 404，数据已级联清理

### T16.11 完整工作流（创建→执行→验证→清理）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"full-workflow"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# Step 1: 创建 agent
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "python-coder",
    "description": "Python 编程专家",
    "mode": "primary",
    "prompt": "你是 Python 编程专家。用户描述需求，你生成干净的 Python 代码。",
    "temperature": 0.4,
    "steps": 10
  }' | python3 -c "import json,sys;d=json.load(sys.stdin);print(f'Created: {d[\"name\"]} mode={d[\"mode\"]}')"

# Step 2: 用 agent 创建文件
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"在 /workspace 创建 calculator.py，包含 add/subtract/multiply/divide 四个函数\"}],\"agent\":\"python-coder\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
for p in d.get('parts',[]):
    if p.get('type') == 'tool':
        print(f'  tool: {p[\"tool\"]} status: {p.get(\"state\",{}).get(\"status\")}')
    if p.get('type') == 'text':
        print(f'  AI: {p.get(\"text\",\"\")[:200]}')
"

# Step 3: 验证 agent 仍在
curl -s "$BASE/session/$SID/agents" | python3 -c "import json,sys;print('python-coder exists:', any(a['name']=='python-coder' for a in json.load(sys.stdin)))"

# Step 4: 删除 agent
curl -s -X DELETE "$BASE/session/$SID/agents/python-coder" -w "delete: %{http_code}\n"
curl -s "$BASE/session/$SID/agents" | python3 -c "import json,sys;print('python-coder deleted:', not any(a['name']=='python-coder' for a in json.load(sys.stdin)))"
```
**期望**：完整流程顺利执行，agent 创建→执行→验证→删除

### T16.12 不存在的 session 创建 agent → 404

```bash
curl -s -o /dev/null -w "status: %{http_code}\n" "$BASE/session/ses_NOTEXIST/agents/create" \
  -X POST -H 'Content-Type: application/json' \
  -d '{"name":"test","description":"test","prompt":"test"}'
```
**期望**：404

### T16.13 不存在的 session 列出 agents → 404

```bash
curl -s -o /dev/null -w "status: %{http_code}\n" "$BASE/session/ses_NOTEXIST/agents"
```
**期望**：404

### T16.14 非法 mode 值 → 400

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{"name":"bad","mode":"invalid"}' -w "\nstatus: %{http_code}\n"
```
**期望**：400，错误信息包含 `"mode"` 校验失败

### T16.15 缺少必填字段 name → 400

```bash
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{}' -w "\nstatus: %{http_code}\n"
```
**期望**：400，错误信息包含 `"name"` expected string

### T16.16 多 agent 协作（主 agent 调度多个 subagent）

```bash
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{"title":"multi-agent-collab"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "Session: $SID"

# 创建主 agent（项目经理）
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "manager",
    "description": "项目经理，负责分配任务给专家 agent",
    "mode": "primary",
    "prompt": "你是项目经理。用户提出需求后，你需要将任务拆分并分配给合适的专家 agent。使用 @agent_name 的方式调用子 agent。每次只分配一个子任务，等子 agent 完成后再分配下一个。所有子任务完成后，汇总结果返回给用户。",
    "temperature": 0.3
  }' > /dev/null

# 创建 subagent：翻译专家
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "translator",
    "description": "翻译专家，中文翻译成英文",
    "mode": "subagent",
    "prompt": "你是翻译专家。将用户提供的中文内容翻译成地道英文。只输出翻译结果，不要解释。",
    "temperature": 0.5
  }' > /dev/null

# 创建 subagent：代码专家
curl -s -X POST "$BASE/session/$SID/agents/create" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "coder",
    "description": "代码专家，写 Python 代码",
    "mode": "subagent",
    "prompt": "你是 Python 代码专家。根据需求写出干净、可运行的 Python 代码。只输出代码，放在 ```python 代码块中。",
    "temperature": 0.4
  }' > /dev/null

# 确认 3 个 agent 都存在
echo "Agents:"
curl -s "$BASE/session/$SID/agents" | python3 -c "
import json,sys
agents = json.load(sys.stdin)
custom = [a for a in agents if a['name'] in ('manager','translator','coder')]
for a in custom:
    print(f'  {a[\"name\"]}: mode={a[\"mode\"]} desc={a.get(\"description\",\"\")}')
print(f'验证: 3个自定义agent = {len(custom)==3} (期望 True)')
"

# 用主 agent 发消息，让它调度 translator 和 coder
echo ""
echo "输入: POST /session/$SID/message {agent:manager}"
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"请完成以下两个任务：1. 把「你好世界」翻译成英文；2. 写一个 Python 函数计算斐波那契数列的第 n 项。请分别调用 @translator 和 @coder 来完成。\"}],\"agent\":\"manager\",\"model\":$MODEL}" \
  | python3 -c "
import json,sys
d = json.load(sys.stdin)
tools = []
texts = []
for p in d.get('parts',[]):
    if p.get('type') == 'tool':
        tools.append(p['tool'])
        status = p.get('state',{}).get('status','?')
        print(f'  [tool] {p[\"tool\"]} status={status}')
    if p.get('type') == 'text':
        texts.append(p.get('text',''))
full = ' '.join(texts)
print(f'  AI回复 (前500字): {full[:500]}')
has_eng = any(w in full.lower() for w in ['hello','world','fibonacci','def ','python'])
has_task = 'task' in tools or len(tools) >= 2
print(f'  验证: 调度了子任务tool = {has_task} (tool列表: {tools})')
print(f'  验证: 回复包含翻译+代码内容 = {has_eng}')
"
```
**期望**：主 agent (manager) 自动调度 @translator 和 @coder 子 agent，分别完成翻译和代码生成子任务，最终汇总结果。验证方式：回复文本包含翻译内容（如 "Hello World"）和代码内容（如 `def`/`fibonacci`）

---

## 十七、Sandbox Endpoint API（沙箱直连访问）

> 前置条件：同第十一节。本节验证 `GET /session/:sessionID/endpoint/:port` 直连 API，返回沙箱 Pod IP 供浏览器直连访问。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T17.1 无沙箱时 endpoint API 返回 502

```bash
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -m json.tool
```
**期望**：`{"error": "sandbox unreachable"}`，HTTP 502（沙箱尚未创建）

### T17.2 端口参数校验

```bash
curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID/endpoint/0"
echo ""
curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID/endpoint/99999"
echo ""
curl -s -o /dev/null -w "%{http_code}" "$BASE/session/$SID/endpoint/abc"
```
**期望**：三个请求均返回 `400`

### T17.3 创建 Vite 项目并验证 endpoint API 返回直连 IP

```bash
# Step 1: 创建项目 + 安装依赖
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: mkdir -p /workspace/vite-app/src && cd /workspace/vite-app && npm init -y && npm install react react-dom && npm install -D vite @vitejs/plugin-react typescript\"}],\"model\":$MODEL}" > /dev/null

# Step 2: 创建项目文件
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"在 /workspace/vite-app 下创建6个文件：vite.config.ts、index.html、src/main.tsx、src/App.tsx（用 import { useState } from 'react'）、tsconfig.json、src/vite-env.d.ts\"}],\"model\":$MODEL}" > /dev/null

# Step 3: 验证工具调用过程
echo "=== 验证工具调用过程 ==="
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for i, m in enumerate(msgs):
    tools = [p.get('tool','') for p in m.get('parts',[]) if p.get('type')=='tool']
    if tools:
        print(f'  🔧 [{i}] {tools}')
"

# Step 4: 启动 Vite（background:true）
curl -s --max-time 120 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 工具执行，background 必须设为 true: cd /workspace/vite-app && npx vite --host 0.0.0.0 --port 5173\"}],\"model\":$MODEL}" > /dev/null
sleep 12

# Step 5: Proxy 验证
echo "=== Proxy 验证 ==="
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Proxy: HTTP %{http_code}\n"

# Step 6: Endpoint API 验证
echo "=== Endpoint API ==="
ENDPOINT=$(curl -s "$BASE/session/$SID/endpoint/5173")
echo "$ENDPOINT" | python3 -m json.tool

# Step 7: 验证返回结构
echo "$ENDPOINT" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d.get('mode') in ('direct','proxy'), f'mode 异常: {d.get(\"mode\")}'
assert d.get('url'), 'url 缺失'
assert d.get('port') == 5173, f'port 异常: {d.get(\"port\")}'
assert d.get('sandboxId'), 'sandboxId 缺失'
assert d.get('fallback','').startswith('/session/'), f'fallback 异常: {d.get(\"fallback\")}'
print('✅ 返回结构验证通过')
print(f'  mode={d[\"mode\"]} url={d[\"url\"]} sandboxId={d[\"sandboxId\"][:12]}...')
"
```
**期望**：
- Proxy 返回 HTTP 200
- Endpoint API 返回 JSON，包含 `mode`、`url`（沙箱 IP）、`port`、`sandboxId`、`fallback`
- `mode=direct` 时 `url` 为沙箱 Pod IP（如 `http://10.12.11.x:5173`）

### T17.4 通过直连 IP 访问 Vite 页面

```bash
# 获取直连 URL
URL=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")
echo "Direct URL: $URL"

# 直连访问
curl -s --max-time 10 "$URL/" -o /dev/null -w "Direct: HTTP %{http_code}\n"

# 验证内容
curl -s --max-time 10 "$URL/" | python3 -c "
import sys
html = sys.stdin.read()
print(f'  body.length={len(html)}')
print(f'  has Vite: {\"vite\" in html.lower()}')
print(f'  has module: {\"type=\\\"module\\\"\" in html}')
# 直连模式没有 proxy prefix 注入
print(f'  无 proxy 注入: {\"data-oc-prefix\" not in html}')
"
```
**期望**：
- 直连 HTTP 200
- HTML 包含 Vite 标识
- 直连模式下没有 proxy prefix 注入（与 proxy 模式的 key 区别）

### T17.5 Proxy 与直连模式对比

```bash
URL=$(curl -s "$BASE/session/$SID/endpoint/5173" | python3 -c "import json,sys;print(json.load(sys.stdin).get('url',''))")

echo "=== Proxy 模式 ==="
curl -s "$BASE/session/$SID/proxy/5173/" | python3 -c "
import sys; html=sys.stdin.read()
print(f'  长度: {len(html)}')
print(f'  有 prefix 注入: {\"data-oc-prefix\" in html}')
print(f'  有 fetch patch: {\"window.fetch=function\" in html}')
print(f'  有 WebSocket patch: {\"window.WebSocket=function\" in html}')
"

echo "=== 直连模式 ==="
curl -s --max-time 10 "$URL/" | python3 -c "
import sys; html=sys.stdin.read()
print(f'  长度: {len(html)}')
print(f'  无 prefix 注入: {\"data-oc-prefix\" not in html}')
print(f'  无 fetch patch: {\"window.fetch=function\" not in html}')
print(f'  原始 Vite 输出: {\"@vite/client\" in html}')
"
```
**期望**：
- Proxy 模式：有 prefix 注入、fetch/WebSocket patch、路径重写
- 直连模式：没有任何注入，是原始 Vite 输出

### T17.6 沙箱销毁后 endpoint API 返回 502

```bash
curl -s -X POST "$BASE/instance/dispose" > /dev/null
sleep 3
curl -s "$BASE/session/$SID/endpoint/5173" | python3 -m json.tool
```
**期望**：`{"error": "sandbox unreachable"}`，沙箱销毁后 endpoint 不可用

---

## 十八、工具调用过程批量验证

> 本节专门验证 AI 工具调用的**过程**而非仅最终结果，确保 `POST /message` 返回的文字总结背后确实执行了工具。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T18.1 批量验证 7 种工具调用场景

```bash
# 通用发送+验证函数
send_and_verify() {
  local sid=$1 prompt=$2 label=$3
  echo ""
  echo "=== $label ==="
  curl -s --max-time 120 -X POST "$BASE/session/$sid/message" \
    -H 'Content-Type: application/json' \
    -d "{\"parts\":[{\"type\":\"text\",\"text\":\"$prompt\"}],\"model\":$MODEL}" > /dev/null 2>&1

  curl -s "$BASE/session/$sid/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
recent = msgs[-3:] if len(msgs) >= 3 else msgs
tools, texts = [], []
for m in recent:
    for p in m.get('parts', []):
        if p.get('type') == 'tool':
            t = p.get('tool', '?')
            s = p.get('state', {})
            status = s.get('status', '?')
            tools.append(f'{t}({status})')
        elif p.get('type') == 'text':
            texts.append(p.get('text', '')[:80])
print(f'  工具: {\"✅ \" + str(tools) if tools else \"❌ 无工具调用\"}')
print(f'  回复: {texts[-1] if texts else \"(空)\"}')
"
}

send_and_verify "$SID" "用 bash 执行: echo hello"                   "T18.1a: bash 命令"
send_and_verify "$SID" "在 /workspace 创建 test.txt 内容是 hello"     "T18.1b: write 写文件"
send_and_verify "$SID" "读取 /workspace/test.txt 的内容"              "T18.1c: read 读文件"
send_and_verify "$SID" "列出 /workspace 下所有文件"                   "T18.1d: 模糊指令"
send_and_verify "$SID" "在 /workspace 下创建三个文件：a.txt 内容 AAA，b.txt 内容 BBB，c.txt 内容 CCC" "T18.1e: 批量写"
send_and_verify "$SID" "把 /workspace/test.txt 的内容改为 modified"   "T18.1f: 修改文件"
send_and_verify "$SID" "用 bash 工具执行，background 必须设为 true: sleep 1 && echo bg-done" "T18.1g: background bash"
```
**期望**：全部显示 `✅`，每个场景都有对应的工具调用（bash/write/read/edit）

### T18.2 验证完整消息流结构

```bash
echo "=== 完整消息列表 ==="
curl -s "$BASE/session/$SID/message" | python3 -c "
import json, sys
msgs = json.load(sys.stdin)
for i, m in enumerate(msgs):
    parts = m.get('parts', [])
    types = [p.get('type', '?') for p in parts]
    tools = [p.get('tool', '') for p in parts if p.get('type') == 'tool']
    text = [p.get('text', '')[:50] for p in parts if p.get('type') == 'text']
    marker = '🔧' if tools else '💬'
    print(f'  {marker} [{i:2d}] tools={tools or \"-\"} text={text[:1] or \"-\"}')
"
```
**期望**：消息交替出现 `💬`（用户 prompt / AI 文字总结）和 `🔧`（工具调用），结构为：`💬 prompt → 🔧 tool call → 💬 summary`

---

## 十九、沙箱命令执行 API（exec / keep-alive）

> 本节验证直接通过 HTTP API 在沙箱中执行命令、设置 keepAlive 的能力。不依赖 AI 模型是否正确传递 `background:true`，可用于程序化控制沙箱。

```bash
BASE="http://localhost:14096"
MODEL='{"providerID":"zhipuai","modelID":"glm-5.1"}'
SID=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
echo "SID: $SID"
```

### T19.1 exec API：简单命令执行

```bash
# 先通过 AI 消息创建沙箱（exec 依赖沙箱存在）
curl -s --max-time 60 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo sandbox-ready\"}],\"model\":$MODEL}" > /dev/null

# 使用 exec API 执行命令
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo hello-from-exec"}' | python3 -m json.tool
```
**期望**：返回 `{id: "...", exitCode: 0, stdout: "hello-from-exec\n", stderr: ""}`

### T19.2 exec API：多行输出与 stderr

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo line1 && echo line2 && echo err >&2"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'stdout: {repr(d.get(\"stdout\",\"\"))}')
print(f'stderr: {repr(d.get(\"stderr\",\"\"))}')
"
```
**期望**：`exitCode: 0`，stdout 含 `line1` 和 `line2`，stderr 含 `err`

### T19.3 exec API：指定工作目录

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"pwd","workingDirectory":"/tmp"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'pwd: {d.get(\"stdout\",\"\").strip()}')
"
```
**期望**：`pwd: /tmp`

### T19.4 exec API：命令执行失败

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"exit 42"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'非0: {d.get(\"exitCode\") != 0}')
"
```
**期望**：`exitCode: 42`，非 0 退出码

### T19.5 exec API：缺少 command 参数

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{}'
echo ""
```
**期望**：`400`

### T19.6 exec API：不存在的 session

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/session/ses_NOTEXIST/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo test"}'
echo ""
```
**期望**：`502`（sandbox unreachable）

### T19.7 exec API：启动 dev server 并设置 keepAlive

```bash
# 创建 Vite 项目（如果不存在）
curl -s --max-time 300 -X POST "$BASE/session/$SID/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: if [ ! -d /workspace/vite-app ]; then npx create-vite@5 /workspace/vite-app --template react-ts --yes && cd /workspace/vite-app && npm install; fi && echo vite-ready\"}],\"model\":$MODEL}" > /dev/null

# 通过 exec API 安装依赖（如果需要）
curl -s --max-time 120 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && npm install 2>&1 | tail -1"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f'npm install: exit={d.get(\"exitCode\")} stdout={d.get(\"stdout\",\"\").strip()[:80]}')
"

# 通过 exec API 设置 keepAlive
curl -s -X POST "$BASE/session/$SID/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' | python3 -m json.tool

# 通过 exec API 启动 Vite（前台执行，但 keepAlive 保护沙箱不被销毁）
# 注意：exec 是同步的，启动 dev server 会阻塞直到超时，所以用 nohup 放后台
curl -s --max-time 10 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"cd /workspace/vite-app && nohup npx vite --host 0.0.0.0 --port 5173 > /tmp/vite.log 2>&1 & echo $!"}' | python3 -c "
import json,sys; d=json.load(sys.stdin); print(f'Vite PID: {d.get(\"stdout\",\"\").strip()}')
"

sleep 8

# 验证 Vite 运行
curl -s "$BASE/session/$SID/proxy/5173/" -o /dev/null -w "Vite proxy: %{http_code}\n"

# 验证 keepAlive 状态
curl -s "$BASE/session/$SID/keep-alive" | python3 -m json.tool
```
**期望**：
- keep-alive 设置返回 `{keepAlive: true}`
- Vite proxy 返回 HTTP 200
- keep-alive 查询返回 `{keepAlive: true}`

### T19.8 keepAlive 阻止 idle 销毁（纯 API 方式）

```bash
# 创建新 session
SID2=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 先用 AI 消息创建沙箱
curl -s --max-time 60 -X POST "$BASE/session/$SID2/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo ready\"}],\"model\":$MODEL}" > /dev/null

# 通过 API 设置 keepAlive
curl -s -X POST "$BASE/session/$SID2/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null

# 等待 idle 触发
sleep 15

# 检查：sandbox 应仍然存活（不被销毁）
RESULT=$(curl -s --max-time 10 -X POST "$BASE/session/$SID2/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo alive"}')
echo "After idle + keepAlive: $RESULT" | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode={d.get(\"exitCode\")} stdout={d.get(\"stdout\",\"\").strip()}')
print(f'PASS: sandbox still alive = {d.get(\"exitCode\")==0}')
"
```
**期望**：`sandbox still alive = True`，证明 keepAlive 阻止了 idle 销毁

### T19.9 释放 keepAlive 后 idle 销毁

```bash
SID3=$(curl -s -X POST $BASE/session -H 'Content-Type: application/json' -d '{}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

# 创建沙箱
curl -s --max-time 60 -X POST "$BASE/session/$SID3/message" \
  -H 'Content-Type: application/json' \
  -d "{\"parts\":[{\"type\":\"text\",\"text\":\"用 bash 执行: echo ready\"}],\"model\":$MODEL}" > /dev/null

# 设置 keepAlive
curl -s -X POST "$BASE/session/$SID3/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":true}' > /dev/null

# 确认存活
sleep 5
curl -s -X POST "$BASE/session/$SID3/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo alive"}' | python3 -c "import json,sys;print('alive:', json.load(sys.stdin).get('exitCode')==0)"

# 释放 keepAlive
curl -s -X POST "$BASE/session/$SID3/keep-alive" \
  -H 'Content-Type: application/json' \
  -d '{"enabled":false}' | python3 -c "import json,sys;print(json.load(sys.stdin))"

# 等待 idle + destroy
sleep 15

# 检查：sandbox 应已被销毁
curl -s --max-time 10 -X POST "$BASE/session/$SID3/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo dead"}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'After release: exitCode={d.get(\"exitCode\")} error={d.get(\"error\")}')
"
```
**期望**：释放 keepAlive 后，sandbox 被 idle 回收，exec 返回 502 或执行失败

### T19.10 exec API：超时控制

```bash
curl -s --max-time 15 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"sleep 30 && echo done","timeoutSeconds":5}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(f'exitCode: {d.get(\"exitCode\")}')
print(f'has error: {bool(d.get(\"error\"))}')
"
```
**期望**：命令在 5 秒后被终止，返回非 0 exitCode 或 error

### T19.11 exec API：环境信息收集

```bash
curl -s --max-time 30 -X POST "$BASE/session/$SID/exec" \
  -H 'Content-Type: application/json' \
  -d '{"command":"echo \"node=$(node -v) npm=$(npm -v) pwd=$(pwd)\""}' | python3 -c "
import json,sys
d=json.load(sys.stdin)
print(d.get('stdout','').strip())
"
```
**期望**：输出包含 node 版本、npm 版本和当前工作目录

---

### API 接口详情

#### `POST /session/:sessionID/exec`

在沙箱中执行命令。沙箱不存在时自动创建（首次 AI 消息后）。

**请求体**：
```json
{
  "command": "echo hello",
  "workingDirectory": "/workspace",  // 可选，默认 /workspace
  "timeoutSeconds": 30               // 可选，默认不限
}
```

**响应**：
```json
{
  "id": "exec-xxx",
  "exitCode": 0,
  "stdout": "hello\n",
  "stderr": "",
  "error": null  // 或 {"name":"...","value":"...","traceback":[...]}
}
```

#### `POST /session/:sessionID/keep-alive`

设置或释放 keepAlive。keepAlive=true 时，sandbox 在 session idle 后不会被自动销毁。

**请求体**：
```json
{"enabled": true}   // 设置 keepAlive
{"enabled": false}  // 释放 keepAlive
```

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true}
```

#### `GET /session/:sessionID/keep-alive`

查询 keepAlive 状态。

**响应**：
```json
{"sessionID": "ses_xxx", "keepAlive": true}
```
