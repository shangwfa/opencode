import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { WebSocket } from "../../../packages/server/node_modules/ws/wrapper.mjs"

const base = process.env.BASE.replace(/\/$/, "")
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
const request = (path, init = {}) => fetch(base + path, { ...init, headers, signal: AbortSignal.timeout(180000) })
const created = await request("/api/session", { method: "POST", body: JSON.stringify({ title: "aliyun-preview" }) })
assert.equal(created.status, 200)
const session = (await created.json()).data
const source = `require('node:http').createServer((req,res)=>{if(req.url==='/main.js'){res.setHeader('content-type','text/javascript');res.end('window.aliyunPreview=true')}else if(req.url==='/redirect'){res.writeHead(302,{location:'/target'});res.end()}else if(req.url==='/target'){res.end('ALIYUN-TARGET')}else{res.setHeader('content-type','text/html');res.end('<html><body>ALIYUN-PREVIEW<script src="/main.js"></script></body></html>')}}).listen(18080,'0.0.0.0')`
const shell = await request(`/api/session/${session.id}/shell`, { method: "POST", body: JSON.stringify({ command:
  `printf '%s' '${source.replaceAll("'", `'\\''`)}' > /workspace/preview.cjs; nohup node /workspace/preview.cjs >/tmp/aliyun-preview.log 2>&1 </dev/null & sleep 1; ${"flock -x -o /tmp/opencode-codemode-runner.pid.lock -c 'nohup node /opt/opencode-codemode-runner.mjs >/tmp/aliyun-runner.log 2>&1 </dev/null & sleep 1'"}`,
}) })
assert.equal(shell.status, 204)
const endpoint = await request(`/api/session/${session.id}/endpoint/18080`)
assert.equal(endpoint.status, 200)
const info = await endpoint.json()
assert.equal(info.directUrl, null)
assert.equal(info.proxyUrl, null)
assert.match(info.url, /\/proxy\/18080\//)
assert.ok(!JSON.stringify(info).includes("e2b-traffic-access-token"))
const prefix = `/api/session/${session.id}/proxy/18080`
const html = await request(`${prefix}/`)
assert.equal(html.status, 200)
assert.match(await html.text(), /ALIYUN-PREVIEW/)
const asset = await request(`${prefix}/main.js`)
assert.equal(asset.status, 200)
assert.match(await asset.text(), /aliyunPreview/)
const redirected = await request(`${prefix}/redirect`, { redirect: "manual" })
assert.equal(redirected.status, 302)
assert.match(redirected.headers.get("location"), /\/proxy\/18080\/target$/)
assert.equal(await (await request(`${prefix}/target`)).text(), "ALIYUN-TARGET")
const query = `SELECT remote_name FROM sandbox WHERE session_id='${session.id}'`
const remote = execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", query], { encoding: "utf8" }).trim()
assert.equal((await fetch(`https://18080-${remote}.cn-hangzhou.sandbox.aliyuncs.com/`)).status, 403)
const websocket = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error("preview WebSocket timed out")) }, 20000)
  const socket = new WebSocket(`${(process.env.BASE_DIRECT ?? base).replace(/^http/, "ws")}/api/session/${session.id}/proxy/9911/`, { headers })
  socket.on("open", () => socket.send(JSON.stringify({ type: "execute", executionID: "aliyun-preview-ws", code: "return 7", web: false, tools: [], limits: {} })))
  socket.on("error", (error) => { clearTimeout(timer); reject(error) })
  socket.on("message", (bytes) => {
    const frame = JSON.parse(String(bytes))
    if (frame.type === "execution.result") { clearTimeout(timer); socket.close(); resolve(frame.result) }
    if (frame.type === "execution.error") { clearTimeout(timer); socket.close(); reject(new Error(frame.message)) }
  })
})
assert.equal(websocket.ok, true)
assert.equal(websocket.value, 7)
const report = { passed: true, http: true, assets: true, redirect: true, websocket: true, anonymousStatus: 403, credentialsServerOnly: true }
await mkdir(process.env.STRESS_OUT, { recursive: true })
await writeFile(`${process.env.STRESS_OUT}/preview-report.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report))
