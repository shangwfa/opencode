/**
 * SaaS Project 测试台本地服务
 *
 * 功能：
 * 1. 托管 ui.html（前端测试页面）
 * 2. 代理 GitHub OAuth token 交换（解决 CORS 限制）
 *
 * 用法：
 *   bun run docs/test-cases/saas-project/base/serve.ts
 *
 * 然后浏览器打开 http://localhost:3456
 *
 * GitHub OAuth App 配置：
 *   Homepage URL: http://localhost:3456
 *   Authorization callback URL: http://localhost:3456/oauth/callback
 */
import { file } from "bun"
import path from "path"

const PORT = 3456
const DIR = path.dirname(new URL(import.meta.url).pathname)
const UI_FILE = path.join(DIR, "ui.html")

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url)

    // CORS
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders })
    }

    // ── OAuth callback: GitHub 重定向回这里 ──
    if (url.pathname === "/oauth/callback") {
      const code = url.searchParams.get("code")
      const state = url.searchParams.get("state")
      const error = url.searchParams.get("error")

      if (error) {
        return new Response(renderErrorPage(error), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        })
      }

      // 302 重定向到首页，code 通过 URL hash 带回（hash 不发到服务端）
      const redirect = `/#oauth-code=${encodeURIComponent(code || "")}&oauth-state=${encodeURIComponent(state || "")}`
      return Response.redirect(redirect, 302)
    }

    // ── OAuth token 交换代理 ──
    if (url.pathname === "/oauth/exchange" && req.method === "POST") {
      try {
        const body = await req.json()
        const res = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            client_id: body.clientId,
            client_secret: body.clientSecret,
            code: body.code,
            redirect_uri: body.redirectUri,
          }),
        })
        const data = await res.json()
        return new Response(JSON.stringify(data), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        })
      }
    }

    // ── 托管 UI ──
    if (url.pathname === "/" || url.pathname === "/ui.html") {
      const html = await file(UI_FILE).text()
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      })
    }

    return new Response("Not found", { status: 404 })
  },
})

console.log(`SaaS Project 测试台已启动: http://localhost:${server.port}`)
console.log(`GitHub OAuth callback URL: http://localhost:${server.port}/oauth/callback`)
console.log("")
console.log("按 Ctrl+C 停止")

function renderErrorPage(error: string) {
  return `<!DOCTYPE html><html><body>
<h2>❌ 授权失败</h2>
<p>${error}</p>
<p><a href="/">返回测试台</a></p>
</body></html>`
}
