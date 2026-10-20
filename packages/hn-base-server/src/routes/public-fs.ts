/**
 * 公开文件访问（无用户认证，靠短期签名）。
 * 用于 <img>/<video>/下载 等无法携带 Authorization 的场景。
 */
import { Hono } from "hono"
import { saasFetch } from "../lib/saas.js"
import { errors } from "../lib/errors.js"
import { verifyPath } from "../lib/signed-url.js"

export const publicFsRoutes = new Hono()

publicFsRoutes.get("/:sessionId/content", async (c) => {
  const sessionId = c.req.param("sessionId")
  const path = c.req.query("path") ?? ""
  const exp = Number(c.req.query("exp") ?? 0)
  const sig = c.req.query("sig") ?? ""
  if (!path) throw errors.invalid("缺少 path", "path")
  if (!verifyPath(sessionId, path, exp, sig)) {
    // 签名无效与资源不存在统一 404，避免探测
    throw errors.notFound("file")
  }

  const query = new URLSearchParams({ path, sessionID: sessionId })
  const res = await saasFetch(`/file/content?${query.toString()}`)
  if (!res.ok) throw errors.notFound("file")
  const contentType = res.headers.get("content-type") ?? "application/octet-stream"

  // 写回时也带上短缓存，避免每次 <img> 都穿透
  if (contentType.startsWith("image/") || contentType.startsWith("application/octet-stream") || contentType.startsWith("video/")) {
    return new Response(res.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": `private, max-age=${Math.max(0, Math.floor((exp - Date.now()) / 1000))}`,
      },
    })
  }
  const data = await res.json().catch(() => ({ content: "" }))
  return c.json(data)
})
