/**
 * 测试沙箱 endpoint 是否可直接从宿主机访问
 *
 * 参照 local-test-env.md 的环境配置：
 *   - TCP 转发：0.0.0.0:30040 → 172.18.32.15:30040（Sandbox API）
 *   - 容器通过 host.docker.internal:30040 访问 Sandbox API
 *
 * 用法：
 *   cd packages/opencode
 *   bun run test/sandbox-direct-access-test.ts
 *
 * 脚本会自动检测 TCP 转发是否在运行。
 */

import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"

const DOMAIN = process.env.OPENCODE_SANDBOX_DOMAIN ?? "localhost:30040"
const API_KEY = process.env.OPENCODE_SANDBOX_API_KEY ?? ""
const PORT = 9999

function log(tag: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args)
}

async function main() {
  log("CONFIG", { DOMAIN, PORT, hasKey: !!API_KEY })

  const config = new ConnectionConfig({
    domain: DOMAIN,
    protocol: "http",
    ...(API_KEY ? { apiKey: API_KEY } : {}),
  })

  // 1. 创建沙箱
  log("CREATE", "创建沙箱...")
  const sb = await Sandbox.create({
    connectionConfig: config,
    timeoutSeconds: 300,
    resource: { cpu: "1", memory: "2Gi" },
  })
  log("CREATE", `沙箱已创建, id=${sb.id}`)

  try {
    // 2. 沙箱内启动 HTTP 服务
    await sb.files.writeFiles([{
      path: "/tmp/server.py",
      data: `
import http.server, json
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({
            "status": "ok",
            "path": self.path,
            "sandbox_id": "${sb.id}",
        }).encode())
    def log_message(self, *a): pass
http.server.HTTPServer(("0.0.0.0", ${PORT}), H).serve_forever()
`,
    }])

    await sb.commands.run(`python3 /tmp/server.py`, { background: true })
    log("SERVER", `启动 HTTP 服务 port=${PORT}...`)
    await new Promise(r => setTimeout(r, 3000))

    // 沙箱内验证
    const internal = await sb.commands.run(`curl -sf --max-time 3 http://localhost:${PORT}/ping`)
    const internalOut = internal.logs.stdout.map(m => m.text).join("").trim()
    log("INTERNAL", `沙箱内 curl: ${internalOut || "(空)"}`)

    // 3. 获取 endpoint
    const ep = await sb.getEndpoint(PORT)
    const url = await sb.getEndpointUrl(PORT)
    log("ENDPOINT", `getEndpoint(${PORT}) → ${JSON.stringify(ep)}`)
    log("ENDPOINT", `getEndpointUrl(${PORT}) → ${url}`)
    log("ENDPOINT", `endpoint 字段: ${ep.endpoint}`)

    // 4. 宿主机 fetch 测试
    let accessible = false
    console.log("\n--- 宿主机直接访问测试 ---")

    try {
      log("FETCH", `请求: GET ${url}`)
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) })
      const body = await res.text()
      log("FETCH", `status=${res.status}, body=${body.slice(0, 200)}`)
      accessible = res.status === 200
    } catch (e: any) {
      log("FETCH", `失败: ${e.message}`)
    }

    // 带路径
    if (accessible) {
      try {
        const r2 = await fetch(`${url}/some/path`, { signal: AbortSignal.timeout(10000) })
        const b2 = await r2.text()
        log("FETCH", `GET /some/path → status=${r2.status}, body=${b2.slice(0, 200)}`)
      } catch (e: any) {
        log("FETCH", `带路径请求失败: ${e.message}`)
      }
    }

    // 5. 输出结论
    console.log("\n" + "=".repeat(60))
    if (accessible) {
      console.log("✅ 沙箱可直接访问！")
      console.log(`   endpoint: ${url}`)
      console.log(`   浏览器可直接打开该地址，无需 opencode proxy`)
    } else {
      console.log("❌ 沙箱不可直接访问")
      console.log(`   endpoint 返回了 ${url}，但宿主机无法连接`)
      console.log(`   需要通过 opencode sandbox-proxy 转发`)
    }
    console.log("=".repeat(60))
  } finally {
    log("CLEANUP", "销毁沙箱...")
    await sb.kill().catch(() => {})
    await sb.close().catch(() => {})
    log("CLEANUP", "完成")
  }
}

main().catch(e => { console.error("FATAL:", e); process.exit(1) })
