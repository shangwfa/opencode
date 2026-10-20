/**
 * 短期签名 URL：给 <img>/<video>/下载 等无法携带 Authorization 的场景。
 * 签名绑定 sessionId + path + 过期时间，默认 5 分钟。
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "../config/env.js"

export const SIGNED_URL_TTL_MS = 5 * 60 * 1000

function secret(): string {
  return process.env.GIT_SECRET_KEY?.trim() || env.authSecret
}

export function signPath(sessionId: string, path: string, expiresAt: number): string {
  return createHmac("sha256", secret())
    .update(`${sessionId}\n${path}\n${expiresAt}`, "utf8")
    .digest("base64url")
}

export function verifyPath(
  sessionId: string,
  path: string,
  expiresAt: number,
  signature: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return false
  const expected = signPath(sessionId, path, expiresAt)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function buildSignedPath(sessionId: string, path: string, now = Date.now()) {
  const expiresAt = now + SIGNED_URL_TTL_MS
  const sig = signPath(sessionId, path, expiresAt)
  const query = new URLSearchParams({ path, exp: String(expiresAt), sig })
  return { url: `/api/public/fs/${encodeURIComponent(sessionId)}/content?${query.toString()}`, expiresAt }
}
