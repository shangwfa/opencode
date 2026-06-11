# AI 对话与工具调用

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

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

