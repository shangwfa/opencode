# 并发与隔离

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

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

