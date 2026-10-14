/**
 * Vercel Function 入口（Hono on Vercel）。
 *
 * 与 src/server.ts 的差异：serverless 环境不监听端口，直接导出 Hono app（含 .fetch）。
 * 路由（/api/** 与 /mcp/**）由 vercel.json rewrites 引到本 function，原始 URL 不变。
 */
import { createKnowledgeApp } from "../src/app.js"
import { ensureNoProxyForInnerHost } from "../src/providers/inner-proxy.js"

// inner 代理启用时，防止 HTTP(S)_PROXY 劫持内网主机（同 server.ts）
ensureNoProxyForInnerHost()

// 顶层 await：冷启动执行一次 initDatabase（幂等），函数实例复用时跳过
const app = await createKnowledgeApp()

export default app
