#!/usr/bin/env bun
const BASE = process.env.BASE || 'http://localhost:14096'

async function exec(sid, command) {
  const r = await fetch(`${BASE}/session/${sid}/exec`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command }),
  })
  const d = await r.json()
  return d.stdout?.trim() || ''
}

async function newSession() {
  const r = await fetch(`${BASE}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  const { id } = await r.json()
  await fetch(`${BASE}/session/${id}/keep-alive`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, boot: true }),
  })
  return id
}

let pass = 0, fail = 0
const ok = (l) => { console.log(`✅ ${l}`); pass++ }
const no = (l, r) => { console.log(`❌ ${l}: ${r}`); fail++ }

const sid = await newSession()
console.log(`SID: ${sid}`)

// 1. 准备 TS 项目
await exec(sid, `echo '{"compilerOptions":{"strict":true}}' > /workspace/tsconfig.json`)
await exec(sid, `echo 'const x: number = "wrong-type"' > /workspace/smoke.ts`)

// 2. 手动启动 daemon（不依赖 AI write 工具）
await exec(sid, 'nohup env LSP_AGENT_PORT=20877 node /opt/opencode-lsp-daemon/index.js > /tmp/daemon.log 2>&1 & sleep 3')
console.log('daemon 已启动')

// 3. status
const status = await exec(sid, 'curl -s http://localhost:20877/lsp/status')
console.log(`status: ${status}`)
status.includes('typescript') ? ok('status') : no('status', status)

// 4. touch + diagnostics（自动重试 3 次，每次 5s）
await exec(sid, `curl -s -X POST http://localhost:20877/lsp/touch -H 'Content-Type: application/json' -d '{"path":"/workspace/smoke.ts"}'`)
let diag = ''
for (let i = 1; i <= 3; i++) {
  await new Promise((r) => setTimeout(r, 5000))
  diag = await exec(sid, `curl -s -X POST http://localhost:20877/lsp/diagnostics -H 'Content-Type: application/json' -d '{"path":"/workspace/smoke.ts","wait":true}'`)
  console.log(`diagnostics[${i}]: ${diag.slice(0, 100)}`)
  if (diag.includes('2322') || diag.toLowerCase().includes('not assignable')) break
}
diag.includes('2322') || diag.toLowerCase().includes('not assignable')
  ? ok('diagnostics') : no('diagnostics', diag.slice(0, 80))

// 5. hover
const hover = await exec(sid, `curl -s -X POST http://localhost:20877/lsp/hover -H 'Content-Type: application/json' -d '{"path":"/workspace/smoke.ts","line":0,"character":6}'`)
console.log(`hover: ${hover.slice(0, 100)}`)
hover.includes('number') || hover.includes('const x') ? ok('hover') : no('hover', hover.slice(0, 80))

console.log(`\n===== LSP Smoke: PASS=${pass} FAIL=${fail} =====`)
process.exit(fail > 0 ? 1 : 0)
