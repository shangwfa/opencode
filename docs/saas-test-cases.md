# OpenCode SaaS 测试用例集

所有用例在容器内通过 `bun -e` 执行，端口默认 `4096`。请把 `SID` 替换为实际 sessionID。

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
**期望**：`cwd=/workspace`，`root=/`

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
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'1+1等于几'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：AI 返回包含 `2` 的文本

### T4.2 多轮上下文记忆
```bash
# 第一轮
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'记住我叫张三'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"

# 第二轮
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'我叫什么？'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：第二轮回复中含「张三」

### T4.3 写文件工具
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 创建 t4-3.txt 内容是 hello'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>{const t=d.parts.find(p=>p.type==='tool');console.log('tool:',t?.tool,'state:',t?.state?.status)})"
```
**期望**：`tool: write`，`state: completed`

### T4.4 读文件工具
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'读 /workspace/t4-3.txt'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：回复中含 `hello`

### T4.5 bash 命令执行
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'执行 ls /workspace 命令'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>{const t=d.parts.find(p=>p.type==='tool');console.log('tool:',t?.tool,t?.state?.output?.slice(0,200))})"
```
**期望**：`tool: bash`，输出含 `t4-3.txt`

### T4.6 异步消息（不等结果）
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/prompt_async',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'写一首五言绝句'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：`status: 204`

### T4.7 中断会话
```bash
# 先异步发送一个长任务
bun -e "fetch('http://127.0.0.1:4096/session/$SID/prompt_async',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'写一篇1万字的文章'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})})"

# 立即中断
sleep 1 && bun -e "fetch('http://127.0.0.1:4096/session/$SID/abort',{method:'POST'}).then(r=>r.text()).then(console.log)"
```
**期望**：abort 返回 `true`，最后一条消息 `finish=abort` 或类似

---

## 五、沙箱与 PVC 持久化

### T5.1 创建沙箱写入文件
```bash
bun -e "const ts=Date.now();fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 创建 pvc-'+ts+'.txt 内容是 '+ts}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.text()).then(()=>console.log('已写入 pvc-'+ts+'.txt'))"
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
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'读 /workspace/$FILENAME'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：读到原内容，证明 PVC 跨实例持久化

### T5.4 多文件批量持久化
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 下创建三个文件：a.txt 内容 A，b.txt 内容 B，c.txt 内容 C'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.text()).then(()=>console.log('done'))"

# dispose
bun -e "fetch('http://127.0.0.1:4096/instance/dispose',{method:'POST'}).then(r=>r.text())"

# 验证三个文件都在
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'用 ls 列出 /workspace 下所有 txt 文件'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：a.txt、b.txt、c.txt 都在

### T5.5 目录持久化
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 下创建 sub/deep 目录，并在 sub/deep/x.txt 写入 DEEP'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.text()).then(()=>console.log('done'))"

bun -e "fetch('http://127.0.0.1:4096/instance/dispose',{method:'POST'}).then(r=>r.text())"

bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'读 /workspace/sub/deep/x.txt'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
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
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(s=>{global.SA=s.id;return fetch('http://127.0.0.1:4096/session/'+s.id+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'创建 /workspace/sessionA.txt 内容 A'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})})}).then(()=>console.log('sessionA:',global.SA))"

# session B 也访问同个 PVC，能看到 sessionA.txt（因为共享 PVC）
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}).then(r=>r.json()).then(s=>fetch('http://127.0.0.1:4096/session/'+s.id+'/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'ls /workspace'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})})).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：B 能看到 sessionA.txt（如果用同一 PVC）；如果设计为每 session 独立 PVC 则看不到——确认实际策略

### T6.3 并发消息发送
```bash
bun -e "Promise.all(Array.from({length:3},(_,i)=>fetch('http://127.0.0.1:4096/session/$SID/prompt_async',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'第'+i+'条'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.status))).then(console.log)"
```
**期望**：全部返回 204，服务端串行处理或合理排队

---

## 七、错误处理

### T7.1 未配置的 provider
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hi'}],model:{providerID:'not-exist',modelID:'fake'}})}).then(r=>console.log('status:',r.status)).then(()=>{})"
```
**期望**：状态码 4xx/5xx，不卡死

### T7.2 不存在的 session 发消息
```bash
bun -e "fetch('http://127.0.0.1:4096/session/ses_NOTEXIST/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'hi'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：404 或类似明确错误

### T7.3 无效 JSON 请求体
```bash
bun -e "fetch('http://127.0.0.1:4096/session',{method:'POST',headers:{'Content-Type':'application/json'},body:'not-json'}).then(r=>console.log('status:',r.status))"
```
**期望**：400

### T7.4 缺失必填字段
```bash
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[]})}).then(r=>console.log('status:',r.status))"
```
**期望**：400

### T7.5 超长消息
```bash
bun -e "const big='x'.repeat(100000);fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:big}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>console.log('status:',r.status))"
```
**期望**：能处理或返回明确的长度错误，不应 hang 死

---

## 八、Provider 与模型

### T8.1 列出所有 provider
```bash
bun -e "fetch('http://127.0.0.1:4096/provider').then(r=>r.json()).then(d=>console.log('providers:',d.providers.length,'connected:',d.connected))"
```

### T8.2 切换模型
```bash
# 用同一 session 在两轮里切换不同模型
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'你是哪个模型？'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log('m1:',d.info.modelID))"
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
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'在 /workspace 创建一个 python 项目结构：myapp/__init__.py、myapp/main.py（含 def main(): print(\"hello\")）、tests/test_main.py（import myapp.main 并测试）'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.text()).then(()=>console.log('done'))"

# 2) 检查文件结构
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'用 find /workspace -type f -name \"*.py\" 列出所有 py 文件'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"

# 3) 销毁实例
bun -e "fetch('http://127.0.0.1:4096/instance/dispose',{method:'POST'}).then(r=>r.text())"

# 4) 重建后运行测试
bun -e "fetch('http://127.0.0.1:4096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'cd /workspace && python -c \"from myapp.main import main; main()\"'}],model:{providerID:'moonshotai-cn',modelID:'kimi-k2.6'}})}).then(r=>r.json()).then(d=>console.log(d.parts.find(p=>p.type==='text')?.text))"
```
**期望**：输出 `hello`

---

## 测试结果记录模板

| 用例 | 状态 | 备注 |
|---|---|---|
| T1.1 | | |
| T1.2 | | |
| ... | | |

每条用例标记 ✅ / ❌ / ⚠️，附加发现的问题
