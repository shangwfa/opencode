/**
 * Git webhook 接收（公开端点，靠签名校验，不走用户认证）。
 *
 * 幂等：webhook_event(provider, event_id) 唯一索引。
 * 事件：PR/MR merged → 更新 requirement_change；该需求全部变更已合并 → 需求 done。
 */
import { Hono } from "hono"
import { createHmac, timingSafeEqual } from "node:crypto"
import { and, eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { requirement, requirementChange, webhookEvent } from "../db/schema.js"
import { errors } from "../lib/errors.js"
import { loadGitInstance } from "../lib/git/instance.js"

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}

export function verifyGitHub(signature: string | undefined, body: string, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) return false
  const expected = createHmac("sha256", secret).update(body, "utf8").digest("hex")
  return safeEqual(signature.slice("sha256=".length), expected)
}

function id(): string {
  return `wh_${crypto.randomUUID().replace(/-/g, "")}`
}

export const gitWebhookRoutes = new Hono()

gitWebhookRoutes.post("/:provider/:instanceId", async (c) => {
  const provider = c.req.param("provider")
  const instanceId = c.req.param("instanceId")
  if (provider !== "github" && provider !== "gitlab") throw errors.invalid("不支持的 provider", "provider")

  const body = await c.req.text()

  // 读实例 + 凭据（token 同时作为 webhook secret；如需独立 secret 可扩展 git_provider_instance）
  const { instance, token } = await loadGitInstance(db, instanceId)
  if (instance.type !== provider) throw errors.invalid("provider 与实例不匹配", "provider")

  if (provider === "github") {
    if (!verifyGitHub(c.req.header("x-hub-signature-256"), body, token)) {
      throw errors.unauthorized("签名校验失败")
    }
  } else {
    if (!safeEqual(c.req.header("x-gitlab-token") ?? "", token)) {
      throw errors.unauthorized("签名校验失败")
    }
  }

  const eventId =
    provider === "github"
      ? (c.req.header("x-github-delivery") ?? "")
      : (c.req.header("x-gitlab-event-uuid") ?? "")
  if (!eventId) throw errors.invalid("缺少事件 ID", "event_id")

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(body) as Record<string, unknown>
  } catch {
    throw errors.invalid("payload 不是合法 JSON")
  }

  const eventType =
    provider === "github"
      ? (c.req.header("x-github-event") ?? "")
      : ((payload.object_kind as string | undefined) ?? "")

  // 幂等：插入成功才处理；冲突说明已处理过
  const inserted = await db
    .insert(webhookEvent)
    .values({
      id: id(),
      provider,
      eventId,
      eventType,
      payload: payload as never,
      status: "received",
      timeCreated: Date.now(),
    })
    .onConflictDoNothing()
    .returning({ id: webhookEvent.id })
  if (inserted.length === 0) return c.json({ ok: true, duplicate: true })

  try {
    const result = await handleEvent(provider, eventType, payload, instanceId)
    await db
      .update(webhookEvent)
      .set({ status: "processed" })
      .where(and(eq(webhookEvent.provider, provider), eq(webhookEvent.eventId, eventId)))
    return c.json({ ok: true, ...result })
  } catch (error) {
    await db
      .update(webhookEvent)
      .set({ status: "failed", error: error instanceof Error ? error.message : String(error) })
      .where(and(eq(webhookEvent.provider, provider), eq(webhookEvent.eventId, eventId)))
    throw error
  }
})

type HandleResult = { change?: string; requirement?: string; status?: string }

async function handleEvent(
  provider: string,
  eventType: string,
  payload: Record<string, unknown>,
  instanceId: string,
): Promise<HandleResult> {
  // 提取（provider 中立）：PR/MR 号 + 是否合并
  let number: number | undefined
  let merged = false
  let repoPath: string | undefined

  if (provider === "github") {
    if (eventType !== "pull_request") return {}
    const action = payload.action
    const pr = payload.pull_request as { number?: number; merged?: boolean } | undefined
    const repo = payload.repository as { full_name?: string } | undefined
    if (action !== "closed" || !pr?.merged) return {}
    number = pr.number
    merged = true
    repoPath = repo?.full_name
  } else {
    if (eventType !== "merge_request") return {}
    const attrs = payload.object_attributes as { iid?: number; state?: string } | undefined
    const project = payload.project as { path_with_namespace?: string } | undefined
    if (attrs?.state !== "merged") return {}
    number = attrs.iid
    merged = true
    repoPath = project?.path_with_namespace
  }

  if (!number || !merged) return {}

  // 找对应的变更记录（按 provider 实例 + 编号）；不限定实例时按仓库路径匹配更复杂，
  // 这里使用 requirement_change 的 provider_instance_id（webhook 已挂在具体实例下）
  // 必须按 provider 实例过滤：不同 GitLab/GitHub 实例的 PR 编号会重复
  const rows = await db
    .select()
    .from(requirementChange)
    .where(
      and(
        eq(requirementChange.providerInstanceId, instanceId),
        eq(requirementChange.number, number),
      ),
    )
  const candidate = rows[0]
  if (!candidate) return {}
  void repoPath

  const now = Date.now()
  await db
    .update(requirementChange)
    .set({ state: "merged", timeMerged: now })
    .where(eq(requirementChange.id, candidate.id))

  const all = await db
    .select({ state: requirementChange.state })
    .from(requirementChange)
    .where(eq(requirementChange.requirementId, candidate.requirementId))
  const allMerged = all.length > 0 && all.every((x) => x.state === "merged")

  let status: string | undefined
  if (allMerged) {
    const reqRows = await db
      .select({ id: requirement.id, status: requirement.status })
      .from(requirement)
      .where(eq(requirement.id, candidate.requirementId))
      .limit(1)
    const req = reqRows[0]
    if (req && req.status === "pending_publish") {
      await db.update(requirement).set({ status: "done", timeUpdated: now }).where(eq(requirement.id, req.id))
      status = "done"
    }
  }

  return { change: candidate.id, requirement: candidate.requirementId, status }
}
