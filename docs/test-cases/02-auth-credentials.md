# Auth 凭据管理

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-INDEX.md`](./00-INDEX.md)。

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

