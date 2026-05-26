/**
 * 沙箱端口暴露 & HTTP 服务外部访问测试
 *
 * 测试流程：
 * 1. 直接使用 @alibaba-group/opensandbox SDK 创建沙箱
 * 2. 在沙箱内启动一个 Python HTTP 服务（监听指定端口）
 * 3. 通过 sb.getEndpointUrl(port) 获取外部可访问地址
 * 4. 从宿主机 fetch 该地址，验证是否能正常访问
 * 5. 清理沙箱
 *
 * 用法：
 *   cd packages/opencode
 *   OPENCODE_SANDBOX_DOMAIN=<your-domain> bun run test/sandbox-endpoint-test.ts
 *
 * 环境变量（必填）：
 *   OPENCODE_SANDBOX_DOMAIN   - OpenSandbox 服务地址，如 172.18.32.15:30040
 *
 * 环境变量（可选）：
 *   OPENCODE_SANDBOX_API_KEY  - API 密钥
 *   OPENCODE_SANDBOX_IMAGE    - 沙箱镜像（默认 registry.shadow-rpa.net/infra/xybot-sandbox-coder:latest）
 *   HTTP_PORT                 - 沙箱内 HTTP 服务端口（默认 9999，避免与 opensandbox 的 8080 冲突）
 */

import { Sandbox, ConnectionConfig } from "@alibaba-group/opensandbox"

const DOMAIN = process.env.OPENCODE_SANDBOX_DOMAIN
const API_KEY = process.env.OPENCODE_SANDBOX_API_KEY ?? ""
const IMAGE = process.env.OPENCODE_SANDBOX_IMAGE ?? "registry.shadow-rpa.net/infra/xybot-sandbox-coder:latest"
const PORT = Number(process.env.HTTP_PORT ?? "9999")

function log(tag: string, ...args: unknown[]) {
  console.log(`[${new Date().toISOString()}] [${tag}]`, ...args)
}

async function waitPort(sb: Sandbox, port: number, max = 30, interval = 1000) {
  for (let i = 0; i < max; i++) {
    try {
      const ep = await sb.getEndpoint(port)
      if (ep?.endpoint) {
        log("PORT", `port ${port} ready: ${ep.endpoint}`)
        return ep
      }
    } catch {
      // 端口还没暴露
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`port ${port} not ready after ${max * interval}ms`)
}

async function main() {
  if (!DOMAIN) {
    console.error(`
错误：未设置 OPENCODE_SANDBOX_DOMAIN 环境变量。

用法：
  OPENCODE_SANDBOX_DOMAIN=<地址> bun run test/sandbox-endpoint-test.ts

示例：
  OPENCODE_SANDBOX_DOMAIN=172.18.32.15:30040 bun run test/sandbox-endpoint-test.ts
  OPENCODE_SANDBOX_DOMAIN=172.18.32.15:30040 OPENCODE_SANDBOX_API_KEY=sk-xxx bun run test/sandbox-endpoint-test.ts
`)
    process.exit(1)
  }

  log("CONFIG", { DOMAIN, IMAGE, PORT, hasKey: !!API_KEY })

  // ── 1. 创建连接配置 ──
  const config = new ConnectionConfig({
    domain: DOMAIN,
    protocol: "http",
    ...(API_KEY ? { apiKey: API_KEY } : {}),
  })
  log("STEP1", "ConnectionConfig 已创建")

  // ── 2. 创建沙箱 ──
  log("STEP2", "正在创建沙箱...")
  const sb = await Sandbox.create({
    connectionConfig: config,
    image: IMAGE,
    timeoutSeconds: 300,
    resource: { cpu: "1", memory: "2Gi" },
  })
  log("STEP2", `沙箱已创建, id=${sb.id}`)

  try {
    // ── 3. 检查沙箱健康状态 ──
    const healthy = await sb.isHealthy()
    log("STEP3", `沙箱健康状态: ${healthy}`)
    if (!healthy) throw new Error("沙箱不健康")

    // ── 4. 在沙箱中写入一个 Python HTTP 服务 ──
    const server = `
import http.server
import json

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        body = json.dumps({
            "status": "ok",
            "message": "Hello from sandbox!",
            "path": self.path
        })
        self.wfile.write(body.encode())

    def log_message(self, format, *args):
        pass

httpd = http.server.HTTPServer(("0.0.0.0", ${PORT}), Handler)
print(f"Server listening on 0.0.0.0:${PORT}", flush=True)
httpd.serve_forever()
`
    await sb.files.writeFiles([{ path: "/tmp/server.py", data: server }])
    log("STEP4", "HTTP 服务脚本已写入 /tmp/server.py")

    // ── 5. 后台启动 HTTP 服务 ──
    log("STEP5", `在沙箱内启动 HTTP 服务 (port ${PORT})...`)

    // 方式1: 用 background 选项运行
    const bg = await sb.commands.run(`python3 /tmp/server.py`, { background: true })
    log("STEP5", `后台命令已提交, id=${bg.id ?? "N/A"}`)

    // 等待进程启动
    await new Promise((r) => setTimeout(r, 3000))

    // 验证进程 + 沙箱内 curl
    const ps = await sb.commands.run(`ps aux | grep server.py | grep -v grep || echo "NOT_FOUND"`)
    const psOut = ps.logs.stdout.map((m) => m.text).join("")
    log("STEP5", `进程状态: ${psOut.trim()}`)

    // 如果方式1没启动成功，尝试方式2: shell 内 & 后台
    if (psOut.includes("NOT_FOUND")) {
      log("STEP5", "方式1未启动进程，尝试 shell 后台方式...")
      await sb.commands.run(`bash -c 'python3 /tmp/server.py > /tmp/server.log 2>&1 &'`)
      await new Promise((r) => setTimeout(r, 3000))

      const ps2 = await sb.commands.run(`ps aux | grep server.py | grep -v grep || echo "NOT_FOUND"`)
      const ps2Out = ps2.logs.stdout.map((m) => m.text).join("")
      log("STEP5", `进程状态(重试): ${ps2Out.trim()}`)

      if (ps2Out.includes("NOT_FOUND")) {
        const errLog = await sb.commands.run("cat /tmp/server.log 2>/dev/null || echo '(无日志)'")
        const errText = errLog.logs.stdout.map((m) => m.text).join("")
        log("STEP5", `服务日志: ${errText}`)
        throw new Error("HTTP 服务启动失败")
      }
    }

    // 沙箱内 curl 验证
    const curlResult = await sb.commands.run(`curl -s --max-time 3 http://localhost:${PORT}/test || echo "CURL_FAIL"`)
    const curlOutput = curlResult.logs.stdout.map((m) => m.text).join("")
    log("STEP5", `沙箱内 curl 结果: ${curlOutput}`)

    // ── 6. 等待端口暴露并获取外部地址 ──
    log("STEP6", `等待端口 ${PORT} 暴露...`)
    await waitPort(sb, PORT)

    const url = await sb.getEndpointUrl(PORT)
    log("STEP6", `外部可访问地址: ${url}`)

    // ── 7. 从宿主机访问沙箱服务 ──
    log("STEP7", "从宿主机发起 HTTP 请求...")

    // 测试根路径
    const r1 = await fetch(url)
    const body1 = await r1.json()
    log("STEP7", `GET / → status=${r1.status}, body=${JSON.stringify(body1)}`)

    // 测试自定义路径
    const r2 = await fetch(`${url}/api/hello`)
    const body2 = await r2.json()
    log("STEP7", `GET /api/hello → status=${r2.status}, body=${JSON.stringify(body2)}`)

    // ── 8. 验证结果 ──
    const pass1 = r1.status === 200 && body1.status === "ok"
    const pass2 = r2.status === 200 && body2.path === "/api/hello"

    log("RESULT", pass1 ? "PASS: 根路径访问正常" : "FAIL: 根路径访问失败")
    log("RESULT", pass2 ? "PASS: 自定义路径访问正常" : "FAIL: 自定义路径访问失败")
    log("RESULT", pass1 && pass2 ? "全部测试通过！沙箱服务可通过外部地址访问" : "部分测试失败")

  } finally {
    // ── 9. 清理 ──
    log("CLEANUP", "正在销毁沙箱...")
    await sb.kill().catch(() => {})
    await sb.close().catch(() => {})
    log("CLEANUP", "沙箱已清理")
  }
}

main().catch((err) => {
  console.error("FATAL:", err)
  process.exit(1)
})
