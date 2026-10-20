/**
 * 审计日志写入。
 * 原则：不阻塞业务（失败只告警），不记录 secret。
 */
import type { Context } from "hono"
import { db } from "../db/index.js"
import { auditLog } from "../db/schema.js"

export type AuditResult = "allow" | "deny"

export type AuditInput = {
  actorType?: "user" | "service" | "system"
  actorId?: string
  /** 形如 requirement.create / git_provider.delete / session.read / auth.deny */
  action: string
  resourceType?: string
  resourceId?: string
  result?: AuditResult
  metadata?: Record<string, unknown>
}

function clientIp(c: Context): string | undefined {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    undefined
  )
}

export async function writeAudit(input: AuditInput, c?: Context): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: `aud_${crypto.randomUUID().replace(/-/g, "")}`,
      actorType: input.actorType ?? (input.actorId ? "user" : "system"),
      actorId: input.actorId ?? null,
      action: input.action,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      result: input.result ?? "allow",
      ip: c ? clientIp(c) : null,
      userAgent: c?.req.header("user-agent") ?? null,
      metadata: (input.metadata ?? null) as never,
      timeCreated: Date.now(),
    })
  } catch (error) {
    console.warn("[hn-base-server] 审计写入失败", String(error))
  }
}

/** 越权/非法访问统一记录（对外仍返回 404） */
export async function writeDeny(
  c: Context,
  input: Omit<AuditInput, "result"> & { actorId?: string },
): Promise<void> {
  await writeAudit({ ...input, result: "deny" }, c)
}
