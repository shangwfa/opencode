import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { WebSocket } from "../../../packages/server/node_modules/ws/wrapper.mjs"

assert.ok(process.env.PG_URL?.endsWith("-proxy-test"))
const base = process.env.BASE
const output = process.env.STRESS_OUT
const headers = { authorization: `Basic ${Buffer.from(`opencode:${process.env.OPENCODE_PASSWORD}`).toString("base64")}`, "content-type": "application/json" }
const report = { cases: [], events: [], codeMode: "真实 dev server + shell API，无模型轮次" }
let id, stream, controller
const api = async (path, method = "GET", body, timeout = 300000) => {
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
  assert.ok(response.ok, `${method} ${path}: HTTP ${response.status}: ${response.ok ? "" : (await response.text()).slice(0, 500)}`)
  return response.status === 204 ? null : response.json()
}
const pg = (sql) => execFileSync("psql", [process.env.PG_URL, "-X", "-A", "-t", "-q", "-c", sql], { encoding: "utf8" }).trim()
const proxy = (port, path = "/") => `/api/session/${id}/proxy/${port}${path}`
async function shell(command, timeoutSeconds = 240) {
  await api(`/api/session/${id}/shell`, "POST", { command, timeoutSeconds }, (timeoutSeconds + 30) * 1000)
  const messages = (await api(`/api/session/${id}/message?order=asc&limit=200`)).data
  const result = messages.filter((value) => value.type === "shell").at(-1)
  assert.equal(result.exit, 0, `${command.slice(0, 80)}: ${(result.output?.output ?? "").slice(-1000)}`)
  return result.output?.output ?? ""
}
async function get(port, path = "/") {
  const response = await fetch(base + proxy(port, path), { headers, redirect: "manual", signal: AbortSignal.timeout(90000) })
  return { status: response.status, type: response.headers.get("content-type"), body: await response.text(), disposition: response.headers.get("content-disposition") }
}
async function check(name, test) {
  try { const details = await test(); report.cases.push({ name, passed: true, details }); console.log(`✓ ${name}`) }
  catch (error) { report.cases.push({ name, passed: false, error: error.message }); console.log(`✗ ${name}: ${error.message.slice(0, 250)}`) }
}
try {
  await mkdir(output, { recursive: true })
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    try { if ((await fetch(base + "/api/info", { headers, signal: AbortSignal.timeout(5000) })).ok) { ready = true; break } } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  assert.ok(ready, "Docker SaaS 未就绪")
  id = (await api("/api/session", "POST", { title: "aliyun-proxy-real-apps" })).data.id
  report.sessionID = id
  await writeFile(`${output}/fixture.json`, JSON.stringify({ sessionID: id, base }, null, 2))
  controller = new AbortController()
  const subscribed = await fetch(`${base}/api/session/${id}/event`, { headers, signal: controller.signal })
  assert.equal(subscribed.status, 200)
  stream = (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    for await (const chunk of subscribed.body) {
      buffer += decoder.decode(chunk, { stream: true })
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        if (!line.startsWith("data:")) continue
        const event = JSON.parse(line.slice(5))
        report.events.push(event)
        if (/shell|preview/.test(event.type)) console.log(`公共 SSE ${event.type} ${event.data?.shell?.status ?? ""}`)
      }
    }
  })().catch((error) => { if (!controller.signal.aborted) report.streamError = error.message })
  await api(`/api/experimental/session/${id}/keep-alive`, "POST", { enabled: true, boot: true })
  report.binding = JSON.parse(pg(`SELECT json_build_object('id',id,'remote',remote_name,'state',state,'keepAlive',keep_alive)::text FROM sandbox WHERE session_id='${id}'`))
  const files = {
    "vite/package.json": JSON.stringify({ private: true, type: "module", dependencies: { vite: "5.4.21", "@vitejs/plugin-react": "4.7.0", react: "18.3.1", "react-dom": "18.3.1", "react-router-dom": "6.30.1", "lodash-es": "4.17.21" } }),
    "vite/vite.config.mjs": "import react from '@vitejs/plugin-react'; export default {plugins:[react()],server:{allowedHosts:true}}",
    "vite/index.html": '<!doctype html><html><head><title>Proxy Vite</title></head><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>',
    "vite/hash.html": '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/hash.tsx"></script></body></html>',
    "vite/src/main.tsx": 'import React from "react"; import {createRoot} from "react-dom/client"; import {BrowserRouter} from "react-router-dom"; import App from "/src/App.tsx"; import "/src/style.css"; createRoot(document.getElementById("root")).render(<BrowserRouter basename={window.__OC_PROXY_PREFIX__ ?? "/"}><App/></BrowserRouter>);',
    "vite/src/App.tsx": '/** 中文 JSDoc */ import React, {useEffect} from "react"; import {Routes,Route,Link} from "react-router-dom"; import logo from "/src/assets/bg.png"; export default function App(){useEffect(()=>{Promise.all([import("./lazy.ts"),import("lodash-es")]).then(([m,l])=>{window.__proxyDynamic={lazy:m.default,camel:l.camelCase("proxy works")}})},[]);return <><nav><Link to="/">Home</Link><Link to="/about">About</Link></nav><img src={logo}/><Routes><Route path="/" element={<h1>Home Page</h1>}/><Route path="/about" element={<h1>About Page</h1>}/><Route path="/contact" element={<h1>Contact Page</h1>}/></Routes></>}',
    "vite/src/hash.tsx": 'import React from "react";import {createRoot} from "react-dom/client";import {HashRouter,Routes,Route} from "react-router-dom";createRoot(document.getElementById("root")).render(<HashRouter><Routes><Route path="/about" element={<h1>Hash About Page</h1>}/></Routes></HashRouter>);',
    "vite/src/lazy.ts": 'export default "LAZY-PROXY-OK"',
    "vite/src/style.css": 'body { background-image:url(/src/assets/bg.png); }',
    "next/package.json": JSON.stringify({ private: true, dependencies: { next: "14.2.35", react: "18.3.1", "react-dom": "18.3.1" } }),
    "next/app/layout.js": 'export default function Layout({children}){return <html><body>{children}</body></html>}',
    "next/app/page.js": 'import Link from "next/link";export default function Page(){return <main><h1>Next Home Page</h1><Link href="/about">Next About</Link></main>}',
    "next/app/about/page.js": 'export default function Page(){return <h1>Next About Page</h1>}',
    "next/app/contact/page.js": 'export default function Page(){return <h1>Next Contact Page</h1>}',
    "next/next.config.mjs": 'export default {}',
  }
  const encoded = Buffer.from(JSON.stringify(files)).toString("base64")
  await shell(`node -e 'const fs=require("fs"),path=require("path");const files=JSON.parse(Buffer.from("${encoded}","base64"));for(const [name,data] of Object.entries(files)){const target=path.join("/workspace/proxy-apps",name);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,data)}fs.mkdirSync("/workspace/proxy-apps/vite/src/assets",{recursive:true});fs.writeFileSync("/workspace/proxy-apps/vite/src/assets/bg.png",Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=","base64"))'`)
  console.log("真实 Vite/Next ▶ 安装固定版本依赖")
  await shell("cd /workspace/proxy-apps/vite && npm install --no-audit --no-fund", 300)
  await shell("cd /workspace/proxy-apps/next && npm install --no-audit --no-fund", 300)
  await shell('(cd /workspace/proxy-apps/vite && nohup ./node_modules/.bin/vite --host 0.0.0.0 --port 5173 >/tmp/proxy-vite.log 2>&1 </dev/null &) ; (cd /workspace/proxy-apps/next && NEXT_TELEMETRY_DISABLED=1 nohup ./node_modules/.bin/next dev -H 0.0.0.0 -p 3000 >/tmp/proxy-next.log 2>&1 </dev/null &) ; echo started')
  for (const port of [5173, 3000]) {
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await get(port)).status === 200) { ready = true; break } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1500))
    }
    assert.ok(ready, `真实 dev server ${port} 未就绪`)
  }
  await check("T11.1–5 Vite HTML/React refresh/JS import", async () => {
    const html = await get(5173)
    assert.equal(html.status, 200)
    assert.ok(html.body.includes(`data-oc-prefix="${proxy(5173, "")}"`))
    assert.ok(html.body.includes(`${proxy(5173, "")}/@react-refresh`))
    assert.ok(!html.body.includes('from "/@react-refresh"'))
    assert.notEqual(html.disposition?.trim().toLowerCase(), "attachment", "网关裸 attachment 头未被剥离")
    const main = await get(5173, "/src/main.tsx")
    assert.ok(main.type.includes("javascript"))
    assert.ok(!/from\s*["']\/(?!api\/session)/.test(main.body))
    return { status: html.status, moduleContentType: main.type, disposition: html.disposition }
  })
  await check("T11.7/36 CSS 与图片模块重写且真实可达", async () => {
    const css = await get(5173, "/src/style.css?direct")
    assert.ok(css.body.includes(proxy(5173, "/src/assets/bg.png")))
    const module = await get(5173, "/src/assets/bg.png?import")
    assert.ok(module.body.includes(`export default "${proxy(5173, "/src/assets/bg.png")}"`))
    const image = await fetch(base + proxy(5173, "/src/assets/bg.png"), { headers })
    const bytes = new Uint8Array(await image.arrayBuffer())
    assert.equal(image.status, 200)
    assert.ok(image.headers.get("content-type").includes("image/png"))
    assert.deepEqual([...bytes.slice(0, 8)], [137,80,78,71,13,10,26,10])
    return { contentType: image.headers.get("content-type"), bytes: bytes.length }
  })
  await check("T11.37/40 动态 import、JSDoc import 和模块 MIME", async () => {
    const app = await get(5173, "/src/App.tsx")
    assert.ok(!/from\s*["']\/(?!api\/session)/.test(app.body))
    assert.ok(app.body.includes(proxy(5173, "/src/lazy.ts")))
    assert.ok(app.body.includes(proxy(5173, "/node_modules/.vite/deps/lodash-es.js")))
    report.jsdocAnchorSurvived = /\*\/\s*import/.test(app.body)
    const refs = [...app.body.matchAll(/(?:from\s*|import\s*\()(["'])(\/[^"']+)\1/g)].map((match) => match[2])
    for (const ref of [...new Set(refs)]) {
      assert.ok(ref.startsWith(proxy(5173, "")), `残留根路径 ${ref}`)
      const response = await fetch(base + ref, { headers })
      assert.equal(response.status, 200, ref)
      assert.ok(/javascript/.test(response.headers.get("content-type")), `${ref}: MIME ${response.headers.get("content-type")}`)
      await response.body.cancel()
    }
    return { moduleCount: new Set(refs).size }
  })
  await check("T11.30 @vite/client 占位符与类型", async () => {
    const client = await get(5173, "/@vite/client")
    assert.equal(client.status, 200)
    assert.ok(client.type.includes("javascript"))
    assert.ok(!client.body.includes("data-oc-prefix"))
    assert.ok(!/__HMR_[A-Z_]+__|__SERVER_HOST__/.test(client.body))
    return { contentType: client.type }
  })
  await check("T11.31 真实 Vite HMR connected → update", async () => {
    const socket = new WebSocket(base.replace(/^http/, "ws") + proxy(5173), "vite-hmr", { headers })
    const received = []
    const connected = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Vite HMR connected 超时")), 20000)
      socket.on("error", reject)
      socket.on("message", (bytes) => { const message = JSON.parse(String(bytes)); received.push(message); if (message.type === "connected") { clearTimeout(timer); resolve() } })
    })
    try {
      await connected
      await shell("printf '\\n// HMR probe\\n' >> /workspace/proxy-apps/vite/src/App.tsx")
      const until = Date.now() + 15000
      while (Date.now() < until && !received.some((message) => message.type === "update")) await new Promise((resolve) => setTimeout(resolve, 200))
      assert.ok(received.some((message) => message.type === "update" && message.updates?.some((update) => /App\.tsx/.test(update.path))), JSON.stringify(received))
      return { messages: received }
    } finally { socket.close() }
  })
  await check("T11.11 Next /、/about、/contact", async () => {
    for (const path of ["/", "/about", "/contact"]) assert.equal((await get(3000, path)).status, 200, path)
  })
  await check("T11.12 Next webpack publicPath（含 app router 兜底）", async () => {
    const html = await get(3000)
    const chunks = [...new Set([...html.body.matchAll(/src="([^"]*\/_next\/static\/chunks\/[^"]*\.js[^"]*)"/g)].map((match) => match[1]))]
    let publicPath = null
    for (const path of chunks) {
      const response = await fetch(base + path, { headers })
      if (!response.ok) continue
      const js = await response.text()
      if (/__webpack_require__\.p\s*=\s*"/.test(js)) {
        publicPath = js.match(/__webpack_require__\.p\s*=\s*"([^"]*)"/)?.[1]
        assert.ok(publicPath?.startsWith(proxy(3000, "")), `webpack publicPath 未含 proxy prefix: ${publicPath}`)
        break
      }
    }
    for (const path of chunks) assert.ok(path.startsWith(proxy(3000, "")) || path.startsWith("http"), `chunk 未重写: ${path}`)
    return { chunks: chunks.length, publicPath }
  })
  await check("T11.13 Next RSC：src/href 属性严格重写 + flight 残留仅限转义字符串 + 运行时兜底", async () => {
    const html = await get(3000)
    const attributes = [...html.body.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((match) => match[1])
    const unprefixedAttributes = attributes.filter((value) => !value.startsWith(proxy(3000, "")) && !value.startsWith("http"))
    assert.equal(unprefixedAttributes.length, 0, JSON.stringify(unprefixedAttributes.slice(0, 8)))
    const flightResiduals = html.body.match(/(?<=["\\])\/(?!api\/session\/|\/)(?:_next|about|contact|favicon)[^"\\]*/g) ?? []
    for (const ref of new Set(flightResiduals)) {
      const response = await fetch(base + ref, { headers, redirect: "manual" })
      const type = response.headers.get("content-type") ?? ""
      const asset = /^\/_next\/.+\.(css|js|mjs|woff2?|png|jpe?g|svg|ico)$/i.test(ref)
      try {
        if (asset) assert.ok(response.status === 200 && /(css|javascript|font|image)/.test(type), `运行时兜底失败 ${ref}: ${response.status} ${type}`)
        else assert.equal(response.status, 200, `路由兜底失败 ${ref}: ${response.status}`)
      } finally { await response.body.cancel() }
    }
    return { attributes: attributes.length, flightResiduals: flightResiduals.length, flightAssets: [...new Set(flightResiduals)].filter((ref) => /^\/_next\/.+\.(css|js|mjs|woff2?|png|jpe?g|svg|ico)$/i.test(ref)).length }
  })
  await check("T11.33 无服务端口状态与响应体", async () => {
    const response = await fetch(base + proxy(19999), { headers, signal: AbortSignal.timeout(30000) })
    const body = await response.text()
    report.deadPort = { status: response.status, body: body.slice(0, 3000) }
    assert.ok([502,504].includes(response.status), `HTTP ${response.status}: ${body.slice(0, 500)}`)
  })
  await check("T17.3/安全 endpoint 不泄漏流量令牌；匿名直连 403；匿名 proxy 被拒", async () => {
    const info = await api(`/api/session/${id}/endpoint/5173`)
    assert.ok(!JSON.stringify(info).includes("e2b-traffic-access-token"), "endpoint 响应包含流量令牌")
    const anonymous = await fetch(base + proxy(5173), { signal: AbortSignal.timeout(30000) })
    report.anonymousProxy = anonymous.status
    await anonymous.body.cancel()
    const remote = pg(`SELECT remote_name FROM sandbox WHERE session_id='${id}'`)
    const direct = await fetch(`https://5173-${remote}.cn-hangzhou.sandbox.aliyuncs.com/`, { signal: AbortSignal.timeout(30000) })
    await direct.body.cancel()
    assert.equal(direct.status, 403, `匿名直连返回 ${direct.status}`)
    return { anonymousProxy: anonymous.status, anonymousDirect: direct.status, directUrl: info.directUrl }
  })
  report.fixtureReady = true
  report.passed = report.cases.every((value) => value.passed)
  await writeFile(`${output}/fixture.json`, JSON.stringify({ sessionID: id, base, fixtureReady: true, binding: report.binding }, null, 2))
} catch (error) { report.error = error.message; report.passed = false }
finally {
  if (controller) controller.abort()
  await stream
  if (id && (!report.fixtureReady || process.env.KEEP_PROXY_FIXTURE !== "1")) {
    try { await api(`/api/session/${id}`, "DELETE"); report.cleaned = true } catch (error) { report.cleanupError = error.message }
  }
  await mkdir(output, { recursive: true })
  await writeFile(`${output}/result.json`, JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ sessionID: id, fixtureReady: report.fixtureReady, passed: report.passed, error: report.error, checks: report.cases.length }))
  if (!report.passed) process.exitCode = 1
}
