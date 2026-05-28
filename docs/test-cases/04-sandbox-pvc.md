# 沙箱与 PVC 持久化

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

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

