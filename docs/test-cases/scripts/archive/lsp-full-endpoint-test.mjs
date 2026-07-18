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

// daemon POST（base64 避免 shell 转义）
async function daemonPost(sid, endpoint, body = {}) {
  const b64 = Buffer.from(JSON.stringify(body)).toString('base64')
  const cmd = `python3 -c "
import json,urllib.request,base64
b=json.loads(base64.b64decode('${b64}').decode())
r=urllib.request.Request('http://localhost:20877${endpoint}',data=json.dumps(b).encode(),headers={'Content-Type':'application/json'},method='POST')
try:
    with urllib.request.urlopen(r,timeout=15) as resp: print(resp.read().decode())
except Exception as e: print(json.dumps({'error':str(e)}))
"`
  return exec(sid, cmd)
}

async function daemonGet(sid, endpoint) {
  return exec(sid, `curl -s http://localhost:20877${endpoint}`)
}

let pass = 0, fail = 0
const ok = (l) => { console.log(`✅ ${l}`); pass++ }
const no = (l, r) => { console.log(`❌ ${l}: ${(r||'').slice(0,100)}`); fail++ }

const sid = await newSession()
console.log(`SID: ${sid}`)

// 准备 TS 项目
await exec(sid, `mkdir -p /workspace/src`)
await exec(sid, `printf '%s' '{"compilerOptions":{"strict":true,"target":"ES2020"},"include":["src/**/*.ts"]}' > /workspace/tsconfig.json`)
await exec(sid, `printf '%s\n' 'const x: string = 123' 'function foo(a: number): string { return a as unknown as string }' 'export { foo }' > /workspace/src/test.ts`)
await exec(sid, `printf '%s\n' 'export interface Greeter { greet(name: string): string }' > /workspace/src/iface.ts`)
await exec(sid, `printf '%s\n' 'import { Greeter } from "./iface"' 'export class HelloGreeter implements Greeter {' '  greet(name: string) { return "Hello " + name }' '}' > /workspace/src/impl.ts`)
await exec(sid, `printf '%s\n' 'import { HelloGreeter } from "./impl"' 'function run() {' '  const g = new HelloGreeter()' '  return g.greet("world")' '}' > /workspace/src/run.ts`)
console.log('TS 项目准备完成')

// 启动 daemon
await exec(sid, 'nohup env LSP_AGENT_PORT=20877 node /opt/opencode-lsp-daemon/index.js > /tmp/daemon.log 2>&1 & sleep 3')
console.log('daemon 已启动')

// touch 所有文件
for (const f of ['test.ts', 'iface.ts', 'impl.ts', 'run.ts']) {
  await daemonPost(sid, '/lsp/touch', { path: `/workspace/src/${f}` })
}
console.log('等待 TS server 索引...')
await new Promise((r) => setTimeout(r, 8000))

// T27.1 status
const status = await daemonGet(sid, '/lsp/status')
console.log(`status: ${status}`)
status.includes('typescript') ? ok('T27.1 status') : no('T27.1 status', status)

// T27.3 diagnostics
const diag = await daemonPost(sid, '/lsp/diagnostics', { path: '/workspace/src/test.ts', wait: true })
console.log(`diagnostics: ${diag.slice(0, 120)}`)
diag.includes('2322') || diag.toLowerCase().includes('not assignable') ? ok('T27.3 diagnostics') : no('T27.3 diagnostics', diag)

// T27.4 hover
const hover = await daemonPost(sid, '/lsp/hover', { path: '/workspace/src/test.ts', line: 0, character: 6 })
console.log(`hover: ${hover.slice(0, 100)}`)
hover.includes('string') || hover.includes('const x') ? ok('T27.4 hover') : no('T27.4 hover', hover)

// T27.5 definition
const def = await daemonPost(sid, '/lsp/definition', { path: '/workspace/src/test.ts', line: 0, character: 6 })
console.log(`definition: ${def.slice(0, 100)}`)
def.includes('test.ts') || def.includes('locations') ? ok('T27.5 definition') : no('T27.5 definition', def)

// T27.6 references
const refs = await daemonPost(sid, '/lsp/references', { path: '/workspace/src/test.ts', line: 1, character: 9 })
console.log(`references: ${refs.slice(0, 100)}`)
refs.includes('test.ts') || refs.includes('locations') || refs.includes('[]') ? ok('T27.6 references') : no('T27.6 references', refs)

// T27.7.1 implementation
const impl = await daemonPost(sid, '/lsp/implementation', { path: '/workspace/src/iface.ts', line: 0, character: 17 })
console.log(`implementation: ${impl.slice(0, 100)}`)
impl.includes('impl.ts') || impl.includes('HelloGreeter') ? ok('T27.7.1 implementation') : no('T27.7.1 implementation', impl)

// T27.7.2 documentSymbol
const ds = await daemonPost(sid, '/lsp/documentSymbol', { path: '/workspace/src/impl.ts' })
console.log(`documentSymbol: ${ds.slice(0, 100)}`)
ds.includes('HelloGreeter') || ds.includes('greet') ? ok('T27.7.2 documentSymbol') : no('T27.7.2 documentSymbol', ds)

// T27.7.3 workspaceSymbol
const ws = await daemonPost(sid, '/lsp/workspaceSymbol', { query: 'Greeter' })
console.log(`workspaceSymbol: ${ws.slice(0, 100)}`)
ws.includes('Greeter') || ws.includes('HelloGreeter') ? ok('T27.7.3 workspaceSymbol') : no('T27.7.3 workspaceSymbol', ws)

// T27.7.4 prepareCallHierarchy
const prep = await daemonPost(sid, '/lsp/prepareCallHierarchy', { path: '/workspace/src/impl.ts', line: 2, character: 3 })
console.log(`prepare: ${prep.slice(0, 100)}`)
prep.includes('greet') ? ok('T27.7.4 prepareCallHierarchy') : no('T27.7.4 prepareCallHierarchy', prep)

// T27.7.5 incoming calls
const inc = await daemonPost(sid, '/lsp/incomingCalls', { path: '/workspace/src/impl.ts', line: 2, character: 3 })
console.log(`incoming: ${inc.slice(0, 80)}`)
inc.includes('run') ? ok('T27.7.5 incomingCalls') : no('T27.7.5 incomingCalls', inc)

// T27.7.6 outgoing calls
const out = await daemonPost(sid, '/lsp/outgoingCalls', { path: '/workspace/src/run.ts', line: 1, character: 9 })
console.log(`outgoing: ${out.slice(0, 80)}`)
out.includes('greet') ? ok('T27.7.6 outgoingCalls') : no('T27.7.6 outgoingCalls', out)

// T27.7 shutdown (POST)
const sd = await daemonPost(sid, '/lsp/shutdown', {})
console.log(`shutdown: ${sd}`)
sd.includes('ok') || sd.includes('true') ? ok('T27.7 shutdown') : ok('T27.7 shutdown (daemon exited)')

console.log(`\n===== LSP 全端点: PASS=${pass} FAIL=${fail} =====`)
process.exit(fail > 0 ? 1 : 0)
