import { createHmac, timingSafeEqual } from "node:crypto"
import { env } from "../config/env.js"

const TICKET_TTL_MS = 10 * 60 * 1000

type TicketPayload = { baseId: string; key: string; exp: number }

function sign(value: string): string {
  return createHmac("sha256", env.authSecret).update(value).digest("base64url")
}

/** 生成一次性上传票据：浏览器跨端口 PUT 正文时无需携带会话。 */
export function createUploadTicket(baseId: string, key: string): string {
  const payload: TicketPayload = { baseId, key, exp: Date.now() + TICKET_TTL_MS }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${encoded}.${sign(encoded)}`
}

/** 校验票据：必须匹配当前知识库与上传 key，且未过期。 */
export function verifyUploadTicket(ticket: string | undefined | null, baseId: string, key: string): boolean {
  if (!ticket) return false
  const [encoded, signature] = ticket.split(".")
  if (!encoded || !signature) return false
  const expected = sign(encoded)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as TicketPayload
    return payload.baseId === baseId && payload.key === key && payload.exp > Date.now()
  } catch {
    return false
  }
}
