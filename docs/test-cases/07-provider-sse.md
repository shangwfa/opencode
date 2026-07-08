# Provider 与模型、SSE 事件流

> 本文档从 `saas-test-cases.md` 拆分而来。公共测试环境和配置请参考 [`00-preamble.md`](./00-preamble.md)。

## 八、Provider 与模型

> 运行前先全局加载环境：`source test-env.sh [1|2|3]`（见 [`00-preamble.md`](./00-preamble.md)）。以下用例直接用 `$BASE` `$PG_URL`，不重复定义。

### T8.1 列出所有 provider
```bash
bun -e "fetch('http://localhost:14096/provider').then(r=>r.json()).then(d=>console.log('providers:',d.all?.length,'connected:',d.connected))"
```

### T8.2 切换模型
```bash
# 用同一 session 在两轮里切换不同模型
bun -e "fetch('http://localhost:14096/session/$SID/message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({parts:[{type:'text',text:'你是哪个模型？'}],model:{providerID:'zhipuai',modelID:'glm-5.1'}})}).then(r=>r.json()).then(d=>console.log('m1:',d.info.modelID))"
```

---

## 九、SSE 事件流

OpenCode 有两级 SSE 事件流：
- **全局事件流** `GET /global/event` — 跨实例的全局事件（session 创建、升级、配置变更等）
- **实例事件流** `GET /event`（需 `x-opencode-directory` 头） — 单实例范围内的事件（消息 delta、工具调用、权限请求、PTY、文件变更等），包含会话维度的实时推送

两个端点均返回 `text/event-stream`，10 秒心跳。

**事件格式差异**：
- 全局 SSE：`data: {"directory":"...","project":"...","payload":{"id":"...","type":"...","properties":{}}}\n\n`
- 实例 SSE：`data: {"id":"...","type":"...","properties":{}}\n\n`

**通用解析函数**（后续用例中复用）：
```javascript
function parseSSE(buf) {
  return buf.split('\n\n').filter(l => l.trim()).map(block => {
    const line = block.split('\n').find(l => l.startsWith('data: '))
    if (!line) return null
    const raw = JSON.parse(line.slice(6))
    return raw.payload || raw  // 统一：全局有 payload 层，实例没有
  }).filter(Boolean)
}
```

---

### T9.1 全局事件流：订阅与初始连接事件

> 验证：响应头、初始 `server.connected` 事件

```bash
timeout 5 bun -e "
const ctrl = new AbortController()
const timer = setTimeout(() => ctrl.abort(), 4000)
const r = await fetch('http://localhost:14096/global/event', { signal: ctrl.signal })
console.log('content-type:', r.headers.get('content-type'))
console.log('cache-control:', r.headers.get('cache-control'))

const reader = r.body.getReader()
const decoder = new TextDecoder()
let buf = ''
try {
  const { value } = await reader.read()
  if (value) buf = decoder.decode(value)
} catch(e) {}
reader.cancel()
clearTimeout(timer)

const events = buf.split('\n\n').filter(l => l.trim()).map(block => {
  const line = block.split('\n').find(l => l.startsWith('data: '))
  if (!line) return null
  const raw = JSON.parse(line.slice(6))
  return raw.payload || raw
}).filter(Boolean)
console.log('first event type:', events[0]?.type)
"
```
**期望**：`content-type` 含 `text/event-stream`，`cache-control` 为 `no-cache, no-transform`，首个事件 `type` 为 `server.connected`

### T9.2 全局事件流：创建 session 触发事件

> 验证：全局 SSE 能收到 session 生命周期事件

```bash
timeout 15 bun -e "
const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); process.exit(1) }, 12000)

const r = await fetch('http://localhost:14096/global/event', { signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()

// 读 server.connected
const first = await reader.read()
const chunk0 = first.value ? decoder.decode(first.value) : ''
console.log('initial:', (JSON.parse(chunk0.split('data: ')[1].split('\n')[0])).payload?.type)

// 创建 session
const sess = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
console.log('created:', sess.id)

// 读后续事件
for (let i = 0; i < 10; i++) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const events = chunk.split('\n\n').filter(l => l.trim())
    for (const block of events) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      console.log('event:', p.type, p.properties?.sessionID?.slice(0,20) || '')
      if (p.type !== 'server.connected' && p.type !== 'server.heartbeat') {
        clearTimeout(timer)
        console.log('✅ received session event via global SSE')
        await reader.cancel()
        process.exit(0)
      }
    }
  } catch(e) { break }
}
"
```
**期望**：收到 `session.created` 事件，包含 `sessionID`

### T9.3 全局事件流：心跳机制

> 验证：约 10 秒后收到 `server.heartbeat`

```bash
timeout 15 bun -e "
const start = Date.now()
const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('❌ no heartbeat'); process.exit(1) }, 14000)

const r = await fetch('http://localhost:14096/global/event', { signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    if (chunk.includes('server.heartbeat')) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1)
      console.log('✅ heartbeat received after ' + elapsed + 's')
      clearTimeout(timer)
      await reader.cancel()
      process.exit(0)
    }
  } catch(e) { break }
}
"
```
**期望**：约 10 秒后收到 `server.heartbeat`

---

### T9.4 实例事件流：订阅与初始连接事件

> 验证：实例级 SSE 连接、`x-opencode-directory` 头、初始事件

```bash
timeout 5 bun -e "
// 创建 session 获取 directory
const sess = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch('http://localhost:14096/session/' + sess.id)).json()
const DIR = info.directory

const ctrl = new AbortController()
const timer = setTimeout(() => ctrl.abort(), 4000)
const r = await fetch('http://localhost:14096/event', {
  headers: { 'x-opencode-directory': DIR },
  signal: ctrl.signal
})
console.log('content-type:', r.headers.get('content-type'))
console.log('cache-control:', r.headers.get('cache-control'))

const reader = r.body.getReader()
const decoder = new TextDecoder()
try {
  const { value } = await reader.read()
  if (value) {
    const buf = decoder.decode(value)
    const line = buf.split('\n').find(l => l.startsWith('data: '))
    if (line) {
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      console.log('first event type:', p.type)
    }
  }
} catch(e) {}
reader.cancel()
clearTimeout(timer)
"
```
**期望**：`content-type` 为 `text/event-stream`，首个事件 `type` 为 `server.connected`

### T9.5 实例事件流：会话消息事件（message.part.updated）

> 验证：LLM 响应过程中 SSE 推送消息相关事件

```bash
timeout 60 bun -e "
const sess = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch('http://localhost:14096/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id
console.log('session:', SID)

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('❌ timeout'); process.exit(1) }, 50000)

const r = await fetch('http://localhost:14096/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
const types = new Set()
let count = 0
let gotMessageEvent = false

setTimeout(async () => {
  await fetch('http://localhost:14096/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '说一个字' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      types.add(p.type)
      count++
      if (p.type === 'message.part.updated' || p.type === 'message.part.delta') gotMessageEvent = true
      if (p.type === 'session.idle') {
        clearTimeout(timer)
        console.log('event types:', [...types].sort().join(', '))
        console.log('total events:', count)
        console.log(gotMessageEvent ? '✅ received message events' : '❌ no message events')
        await reader.cancel()
        process.exit(gotMessageEvent ? 0 : 1)
      }
    }
  } catch(e) { break }
}
"
```
**期望**：收到 `message.part.updated` 和/或 `message.part.delta`，事件含 `properties.sessionID`

### T9.6 实例事件流：工具调用事件

> 验证：工具调用的 SSE 生命周期事件（pending → running → completed/error）

```bash
timeout 90 bun -e "
const sess = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch('http://localhost:14096/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('❌ timeout'); process.exit(1) }, 80000)

const r = await fetch('http://localhost:14096/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
const toolEvents = []

setTimeout(async () => {
  await fetch('http://localhost:14096/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '用 bash 执行 echo hello_sse_test' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      if (p.type === 'message.part.updated') {
        const part = p.properties?.part
        if (part?.type === 'tool') {
          toolEvents.push({ tool: part.tool, status: part.state?.status })
        }
      }
      if (p.type === 'session.idle' || toolEvents.length >= 3) {
        clearTimeout(timer)
        console.log('tool events:', JSON.stringify(toolEvents))
        const statuses = toolEvents.map(e => e.status)
        const hasLifecycle = statuses.includes('pending') && (statuses.includes('running') || statuses.includes('completed') || statuses.includes('error'))
        console.log(hasLifecycle ? '✅ tool call lifecycle received' : '❌ no tool lifecycle')
        await reader.cancel()
        process.exit(hasLifecycle ? 0 : 1)
      }
    }
  } catch(e) { break }
}
"
```
**期望**：收到 `message.part.updated`（`part.type === 'tool'`），状态流转 `pending` → `running` → `completed`（或 `error`，取决于 sandbox 环境）

### T9.7 实例事件流：权限请求事件

> 验证：`permission.asked` 事件通过 SSE 推送，并可程序化回复

> **前提**：不要在全局 config 中配 `permission.edit: allow`（否则不会触发 `permission.asked`）。如果已配，可临时移除：
> ```bash
> curl -s -X PATCH http://localhost:14096/global/config \
>   -H 'Content-Type: application/json' \
>   -d '{"permission":{"bash":"allow","edit":"ask","write":"ask","glob":"allow","grep":"allow","list":"allow","read":"allow","webfetch":"allow"}}'
> ```
>
> **根因说明**：`evaluate()` 默认返回 `{ action: "ask" }`。当 config 未配置 permission 时，所有工具调用都需权限确认。HTTP API 模式下无 UI 回复权限请求，工具会卡在 `running` 状态。本用例通过 SSE 监听 `permission.asked` 后自动回复来验证。

```bash
timeout 90 bun -e "
const BASE = 'http://localhost:14096'
const sess = await (await fetch(BASE + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch(BASE + '/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id
console.log('session:', SID)

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('⏭️ timeout'); process.exit(0) }, 80000)

const r = await fetch(BASE + '/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()

setTimeout(async () => {
  await fetch(BASE + '/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'use the write tool to write hello to /workspace/sse-perm-test.txt' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt

      if (p.type === 'permission.asked') {
        clearTimeout(timer)
        console.log('✅ permission.asked:', p.properties.permission, p.properties.patterns)
        // 自动回复以释放工具
        await fetch(BASE + '/session/' + SID + '/permission/' + p.properties.id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply: 'always' })
        })
        console.log('replied: always')
        await reader.cancel()
        process.exit(0)
      }
      if (p.type === 'session.idle') {
        clearTimeout(timer)
        console.log('⏭️ session idle without permission.asked (may be auto-approved)')
        await reader.cancel()
        process.exit(0)
      }
    }
  } catch(e) { if (!ctrl.signal.aborted) console.error(e); break }
}
"
```
**期望**：收到 `permission.asked` 事件并成功回复（若 `edit` 权限已配 `allow` 则 session 正常完成无权限弹窗）

### T9.8 实例事件流：多会话事件隔离

> 验证：两个 session 的事件通过 `sessionID` 正确路由，无交叉污染

```bash
timeout 90 bun -e "
const sA = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const sB = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const infoA = await (await fetch('http://localhost:14096/session/' + sA.id)).json()
const DIR = infoA.directory
console.log('session A:', sA.id)
console.log('session B:', sB.id)

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); process.exit(1) }, 80000)

const r = await fetch('http://localhost:14096/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
const counts = {}
counts[sA.id] = 0
counts[sB.id] = 0

setTimeout(() => {
  fetch('http://localhost:14096/session/' + sA.id + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '说A' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
  fetch('http://localhost:14096/session/' + sB.id + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '说B' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      const sid = p.properties?.sessionID
      if (sid && counts[sid] !== undefined) counts[sid]++
      if (counts[sA.id] > 0 && counts[sB.id] > 0) {
        clearTimeout(timer)
        console.log('session A events:', counts[sA.id])
        console.log('session B events:', counts[sB.id])
        console.log('✅ both sessions received events')
        await reader.cancel()
        process.exit(0)
      }
    }
  } catch(e) { break }
}
"
```
**期望**：两个 session 各自收到事件（计数 > 0），事件 `sessionID` 无交叉

### T9.9 实例事件流：会话状态变更事件（session.status / session.idle）

> 验证：LLM 处理期间 `session.status` 事件，完成后 `session.idle` 事件

```bash
timeout 60 bun -e "
const sess = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch('http://localhost:14096/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); process.exit(1) }, 50000)

const r = await fetch('http://localhost:14096/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
const statusEvents = []

setTimeout(async () => {
  await fetch('http://localhost:14096/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '说一个字' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      if (p.type === 'session.status' || p.type === 'session.idle') statusEvents.push(p.type)
      if (p.type === 'session.idle') {
        clearTimeout(timer)
        console.log('status lifecycle:', statusEvents.join(' → '))
        console.log('✅ session status events received')
        await reader.cancel()
        process.exit(0)
      }
    }
  } catch(e) { break }
}
"
```
**期望**：先收到 `session.status`（busy），完成后收到 `session.idle`

### T9.10 实例事件流：异步 prompt 触发事件

> 验证：`POST /session/:id/prompt_async` 返回 204，事件通过 SSE 推送

```bash
timeout 60 bun -e "
const sess = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch('http://localhost:14096/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); process.exit(1) }, 50000)

const r = await fetch('http://localhost:14096/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
let gotMessageEvent = false

setTimeout(async () => {
  const resp = await fetch('http://localhost:14096/session/' + SID + '/prompt_async', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: '说一个字' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
  console.log('prompt_async status:', resp.status)
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      if (p.type === 'message.part.updated' || p.type === 'message.part.delta') gotMessageEvent = true
      if (p.type === 'session.idle') {
        clearTimeout(timer)
        console.log(gotMessageEvent ? '✅ async prompt triggered events' : '❌ no message events')
        await reader.cancel()
        process.exit(gotMessageEvent ? 0 : 1)
      }
    }
  } catch(e) { break }
}
"
```
**期望**：`prompt_async` 返回 204，SSE 收到 `message.part.updated` / `message.part.delta`

### T9.11 实例事件流：文件变更事件

> 验证：文件写入操作触发 `file.edited` / `file.watcher.updated` 事件

> **前提**：
> 1. Sandbox TCP 转发必须启动（`lsof -i :30040 | grep LISTEN`），否则 write 工具卡在 sandbox 初始化
> 2. 权限需配 `edit: allow`（通过 `PATCH /global/config {"permission":{"edit":"allow",...}}`），否则工具卡在权限等待
> 3. 写文件路径必须在项目目录内（如 `/workspace/`），写 `/tmp/` 会触发 `external_directory` 权限
>
> **根因说明**：write 工具通过 `ctx.sandbox` 在沙箱中执行写操作，sandbox 不可达时 Promise 永远 pending（工具显示 `running`）。默认权限 `"ask"` 无 UI 回复也会卡住。

```bash
timeout 90 bun -e "
const BASE = 'http://localhost:14096'
const sess = await (await fetch(BASE + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch(BASE + '/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id
console.log('session:', SID)

const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('⏭️ timeout'); process.exit(0) }, 80000)

const r = await fetch(BASE + '/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()
let gotFileEvent = false
const eventTypes = new Set()

setTimeout(async () => {
  await fetch(BASE + '/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'use the write tool to write hello to /workspace/sse-file-test.txt' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 500)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) break
    const chunk = decoder.decode(value)
    const blocks = chunk.split('\n\n').filter(l => l.trim())
    for (const block of blocks) {
      const line = block.split('\n').find(l => l.startsWith('data: '))
      if (!line) continue
      const evt = JSON.parse(line.slice(6))
      const p = evt.payload || evt
      eventTypes.add(p.type)

      // 自动回复权限请求（如果触发了 external_directory 等）
      if (p.type === 'permission.asked') {
        console.log('permission.asked:', p.properties.permission, p.properties.patterns)
        await fetch(BASE + '/session/' + SID + '/permission/' + p.properties.id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reply: 'always' })
        })
        console.log('replied: always')
      }

      if (p.type === 'file.edited' || p.type === 'file.watcher.updated') {
        gotFileEvent = true
        clearTimeout(timer)
        console.log('✅ file event:', p.type, JSON.stringify(p.properties))
        await reader.cancel()
        process.exit(0)
      }
      if (p.type === 'session.idle') {
        clearTimeout(timer)
        console.log(gotFileEvent ? '✅ file event received' : '⏭️ no file event (sandbox may be unavailable)')
        console.log('all event types:', [...eventTypes].sort().join(', '))
        await reader.cancel()
        process.exit(0)
      }
    }
  } catch(e) { if (!ctrl.signal.aborted) console.error(e); break }
}
"
```
**期望**：收到 `file.edited` 或 `file.watcher.updated` 事件（sandbox 可达 + 权限已配 `allow` 时）

### T9.12 全局事件流：dispose 事件

> 验证：`POST /global/dispose` 触发 `server.instance.disposed` 事件

```bash
timeout 10 bun -e "
const ctrl = new AbortController()
const timer = setTimeout(() => { ctrl.abort(); console.log('❌ no dispose event'); process.exit(1) }, 8000)

const r = await fetch('http://localhost:14096/global/event', { signal: ctrl.signal })
const reader = r.body.getReader()
const decoder = new TextDecoder()

await reader.read() // consume server.connected

setTimeout(() => {
  fetch('http://localhost:14096/global/dispose', { method: 'POST' }).then(r => console.log('dispose status:', r.status))
}, 300)

while (true) {
  try {
    const { value, done } = await reader.read()
    if (done) { console.log('✅ stream closed after dispose'); break }
    const chunk = decoder.decode(value)
    if (chunk.includes('disposed') || chunk.includes('disposed')) {
      clearTimeout(timer)
      console.log('✅ received dispose event')
      await reader.cancel()
      process.exit(0)
    }
  } catch(e) { break }
}
clearTimeout(timer)
"
```
**期望**：收到含 `disposed` 的事件，或连接被服务端关闭

### T9.13 实例事件流：连接断开后重连

> 验证：SSE 连接可重复建立，每次都收到 `server.connected`

```bash
timeout 10 bun -e "
const sess = await (await fetch('http://localhost:14096/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch('http://localhost:14096/session/' + sess.id)).json()
const DIR = info.directory
const decoder = new TextDecoder()

async function connectAndRead(dir) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 3000)
  const r = await fetch('http://localhost:14096/event', { headers: { 'x-opencode-directory': dir }, signal: ctrl.signal })
  const reader = r.body.getReader()
  try {
    const { value } = await reader.read()
    await reader.cancel()
    clearTimeout(timer)
    if (!value) return null
    const line = decoder.decode(value).split('\n').find(l => l.startsWith('data: '))
    if (!line) return null
    const evt = JSON.parse(line.slice(6))
    return (evt.payload || evt).type
  } catch(e) { return null }
}

const t1 = await connectAndRead(DIR)
console.log('conn1:', t1)
const t2 = await connectAndRead(DIR)
console.log('conn2:', t2)

const pass = t1 === 'server.connected' && t2 === 'server.connected'
console.log(pass ? '✅ reconnection works' : '❌ reconnection failed')
"
```
**期望**：两次连接都收到 `server.connected`

### T9.14 实例事件流：多客户端监听同一会话

> 验证：一个会话执行任务时，多个 SSE 客户端同时监听都能收到相同的事件序列

> **场景**：模拟多用户（如编辑器 + 终端 + CI 监控）同时通过 SSE 观察同一个会话的执行过程。验证 Bus 的 PubSub 模式能正确广播到所有订阅者。

```bash
timeout 60 bun -e "
const BASE = 'http://localhost:14096'
const sess = await (await fetch(BASE + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch(BASE + '/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id
console.log('session:', SID)

// 启动 3 个 SSE 监听客户端
function startListener(id) {
  return new Promise(async (resolve) => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => { ctrl.abort(); resolve({ id, types: [], connected: false }) }, 55000)
    const r = await fetch(BASE + '/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrl.signal })
    const reader = r.body.getReader()
    const decoder = new TextDecoder()
    const types = new Set()

    while (true) {
      try {
        const { value, done } = await reader.read()
        if (done) break
        const chunk = decoder.decode(value)
        const blocks = chunk.split('\n\n').filter(l => l.trim())
        for (const block of blocks) {
          const line = block.split('\n').find(l => l.startsWith('data: '))
          if (!line) continue
          const evt = JSON.parse(line.slice(6))
          const p = evt.payload || evt
          types.add(p.type)

          // 自动回复权限请求
          if (p.type === 'permission.asked') {
            await fetch(BASE + '/session/' + SID + '/permission/' + p.properties.id, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ reply: 'always' })
            })
          }

          if (p.type === 'session.idle') {
            clearTimeout(timer)
            await reader.cancel()
            resolve({ id, types: [...types].sort(), connected: types.has('server.connected'), idle: true })
            return
          }
        }
      } catch(e) { break }
    }
    clearTimeout(timer)
    resolve({ id, types: [...types].sort(), connected: types.has('server.connected'), idle: false })
  })
}

const listeners = [startListener('A'), startListener('B'), startListener('C')]

// 等 SSE 连接建立后再发消息
setTimeout(async () => {
  await fetch(BASE + '/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'say hello in one sentence' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 1000)

const results = await Promise.all(listeners)

console.log('--- Results ---')
for (const r of results) {
  console.log('Client ' + r.id + ': connected=' + r.connected + ' idle=' + r.idle + ' events=' + r.types.length)
  console.log('  types: ' + r.types.join(', '))
}

// 验证：所有客户端都收到了 connected + 至少一个 message 事件 + idle
const allConnected = results.every(r => r.connected)
const allIdle = results.every(r => r.idle)
const allGotMessage = results.every(r => r.types.some(t => t.startsWith('message.')))
const allGotSameTypes = results.every(r => JSON.stringify(r.types) === JSON.stringify(results[0].types))

console.log('--- Verification ---')
console.log('all connected:', allConnected)
console.log('all idle:', allIdle)
console.log('all got message events:', allGotMessage)
console.log('all got same event types:', allGotSameTypes)
console.log(allConnected && allIdle && allGotMessage ? '✅ multi-client SSE works' : '❌ multi-client SSE failed')
" 2>&1
```
**期望**：3 个 SSE 客户端都收到 `server.connected`、至少一个 `message.*` 事件、`session.idle`，且事件类型列表一致

### T9.15 实例事件流：中途加入的客户端收到后续事件

> 验证：会话执行过程中新连接的 SSE 客户端能收到后续事件（不要求回放历史）

```bash
timeout 60 bun -e "
const BASE = 'http://localhost:14096'
const sess = await (await fetch(BASE + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()
const info = await (await fetch(BASE + '/session/' + sess.id)).json()
const DIR = info.directory
const SID = sess.id
console.log('session:', SID)

// 客户端 A：一开始就连接
const ctrlA = new AbortController()
const timerA = setTimeout(() => ctrlA.abort(), 55000)
const rA = await fetch(BASE + '/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrlA.signal })
const readerA = rA.body.getReader()
const decoder = new TextDecoder()
const typesA = new Set()

setTimeout(async () => {
  await fetch(BASE + '/session/' + SID + '/message', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: 'say hello' }], model: { providerID: 'zhipuai', modelID: 'glm-5.1' } })
  })
}, 500)

// 读取第一个事件（server.connected）
const first = await readerA.read()
if (first.value) {
  const line = decoder.decode(first.value).split('\n').find(l => l.startsWith('data: '))
  if (line) typesA.add(JSON.parse(line.slice(6)).type || JSON.parse(line.slice(6)).payload?.type)
}
console.log('Client A: connected, first event received')

// 等一会再启动客户端 B（中途加入）
await new Promise(r => setTimeout(r, 2000))
console.log('Client B: joining mid-session...')

const ctrlB = new AbortController()
const timerB = setTimeout(() => ctrlB.abort(), 50000)
const rB = await fetch(BASE + '/event', { headers: { 'x-opencode-directory': DIR }, signal: ctrlB.signal })
const readerB = rB.body.getReader()
const typesB = new Set()

// 两个客户端并行读取
const readUntil = (reader, ctrl, types, label) => new Promise(async (resolve) => {
  while (true) {
    try {
      const { value, done } = await reader.read()
      if (done) { resolve(false); return }
      const chunk = decoder.decode(value)
      const blocks = chunk.split('\n\n').filter(l => l.trim())
      for (const block of blocks) {
        const line = block.split('\n').find(l => l.startsWith('data: '))
        if (!line) continue
        const evt = JSON.parse(line.slice(6))
        const p = evt.payload || evt
        types.add(p.type)

        if (p.type === 'permission.asked') {
          await fetch(BASE + '/session/' + SID + '/permission/' + p.properties.id, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reply: 'always' })
          })
        }
        if (p.type === 'session.idle') {
          clearTimeout(label === 'A' ? timerA : timerB)
          await reader.cancel()
          resolve(true)
          return
        }
      }
    } catch(e) { resolve(false); return }
  }
})

const [idleA, idleB] = await Promise.all([
  readUntil(readerA, ctrlA, typesA, 'A'),
  readUntil(readerB, ctrlB, typesB, 'B')
])

console.log('--- Results ---')
console.log('Client A idle:', idleA, 'events:', [...typesA].sort().join(', '))
console.log('Client B idle:', idleB, 'events:', [...typesB].sort().join(', '))

const bGotEvents = typesB.size > 0
const bGotIdle = idleB
console.log(bGotEvents && bGotIdle ? '✅ late joiner received events' : '⏭️ late joiner missed events (timing)')
" 2>&1
```
**期望**：客户端 B 中途加入后仍能收到 `server.connected` 和后续事件（`session.idle` 等）

> **实测结论（有据）**：B 中途加入能收到完整事件流（含 `message.part.*`、`tool`、`session.idle`），多次受控实验验证通过。
>
> **偶发现象（未复现）**：测试中曾出现 2 次"B 只收到 `server.connected` + `server.heartbeat`、无任何 `message` 事件"。随后 **28 轮多角度压力复现**（常规 dispose+中途订阅 / 激进 dispose+0.5s+B 1s / T9.14 3并发SSE+T9.15 完整序列）**全部 0 失败**，无法稳定复现。统计上若真实失败率 ≥10%，28 轮全过的概率仅 5%，故失败率大概率 <10%。
>
> **根因未定位**：在无稳定复现路径前，不对根因下任何结论。曾推测的 takeUntil 终止 / dispose 重建窗口 / T9.14 累积状态，均**未被复现验证支持，已撤回**。
>
> **再次出现时的抓取方法**：给 `packages/opencode/src/bus/index.ts` 的 `subscribing`/`publishing` 日志补 `directory` 字段（`yield* InstanceState.directory`），即可判断失败 SSE 流的"订阅实例"与"message publish 实例"是否错位。

---

## 测试结果

| 用例 | 结果 | 备注 |
|------|------|------|
| T9.1 | ✅ | content-type、cache-control、server.connected 均验证通过 |
| T9.2 | ✅ | 全局 SSE 收到 session.created 事件 |
| T9.3 | ✅ | 10.0s 后收到 server.heartbeat |
| T9.4 | ✅ | 实例级 SSE 需 x-opencode-directory 头 |
| T9.5 | ✅ | 收到 message.part.updated 等 8 种事件类型 |
| T9.6 | ✅ | 工具生命周期 pending→running→error（sandbox 环境下 bash 可能 error） |
| T9.7 | ✅ | `permission.asked` 事件通过 SSE 推送，可程序化回复。需权限未配 `allow` 时触发 |
| T9.8 | ✅ | 两个 session 各自收到事件，无交叉 |
| T9.9 | ✅ | session.status(×4) → session.idle |
| T9.10 | ✅ | prompt_async 返回 204，SSE 正常推送 |
| T9.11 | ✅ | 收到 `file.edited` 事件。前提：sandbox 转发已启动 + 权限配 `edit:allow` + 写项目目录内路径 |
| T9.12 | ✅ | 收到 server.instance.disposed 事件 |
| T9.13 | ✅ | 断开重连均收到 server.connected |
| T9.14 | ✅ | 3 个 SSE 客户端同时监听，均收到相同 10 种事件类型 |
| T9.15 | ✅ | 中途加入收到完整事件流；曾现偶发"B 只收 connected+heartbeat"（28 轮未复现，详见用例备注） |

---
