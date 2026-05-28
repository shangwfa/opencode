# Provider 与模型、SSE 事件流

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

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

