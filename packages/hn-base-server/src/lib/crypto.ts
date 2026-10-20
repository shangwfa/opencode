/**
 * 凭据加解密（AES-256-GCM）。
 * 密钥来自 GIT_SECRET_KEY；未配置时从 BETTER_AUTH_SECRET 派生（仅开发可接受）。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"
import { env } from "../config/env.js"

function key(): Buffer {
  const raw = process.env.GIT_SECRET_KEY?.trim() || env.authSecret
  return scryptSync(raw, "hn-base-server/git", 32)
}

/** 返回 iv.tag.ciphertext（base64 段落） */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(".")
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(".")
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("凭据格式无效")
  const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(ivB64, "base64"))
  decipher.setAuthTag(Buffer.from(tagB64, "base64"))
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8")
}

/** 日志/响应中脱敏 */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return "****"
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`
}
