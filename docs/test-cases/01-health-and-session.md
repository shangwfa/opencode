# 基础健康与元信息、Session 生命周期

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

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

