/**
 * 存量会话归属迁移（P3）。
 *
 * 把 SaaS 中已有的会话归入指定组织（默认 `legacy`），写入 relation_tuple:
 *   (session, <id>, viewer, org, <orgId>)
 *
 * 用法：
 *   bun run scripts/migrate-legacy.mjs --org <orgId>            # dry-run，只统计
 *   bun run scripts/migrate-legacy.mjs --org <orgId> --apply    # 实际写入
 *   bun run scripts/migrate-legacy.mjs --user <userId> --apply  # 归到个人（个人资源，无需组织）
 *
 * 幂等：relation_tuple 有唯一索引，重复执行不会产生重复行。
 * 回滚：`--rollback` 删除本次写入的 legacy 元组（按 viewer@org + session 类型）。
 */
import pg from "pg"

const DB_URL = process.env.BASE_DATABASE_URL ?? "postgres://postgres:ab123456@127.0.0.1:5432/opencode-v2-up"
const SCHEMA = process.env.BASE_DATABASE_SCHEMA ?? "hn_base"
const SAAS_URL = process.env.OPENCODE_SAAS_URL ?? "http://localhost:14096"
const SAAS_PASSWORD = process.env.OPENCODE_PASSWORD ?? ""

const args = process.argv.slice(2)
const apply = args.includes("--apply")
const rollback = args.includes("--rollback")
const orgIndex = args.indexOf("--org")
const userIndex = args.indexOf("--user")
const orgId = orgIndex >= 0 ? args[orgIndex + 1] : undefined
const userId = userIndex >= 0 ? args[userIndex + 1] : undefined
/** 目标主体：组织或用户（个人资源） */
const subjectType = userId ? "user" : "org"
const subjectId = userId ?? orgId

if (!subjectId) {
  console.error("用法: bun run scripts/migrate-legacy.mjs (--org <orgId> | --user <userId>) [--apply] [--rollback]")
  process.exit(1)
}

function saasAuth() {
  return "Basic " + Buffer.from(`opencode:${SAAS_PASSWORD}`).toString("base64")
}

const pool = new pg.Pool({ connectionString: DB_URL })

try {
  // 1) 校验主体
  if (subjectType === "org") {
    const org = await pool.query(`SELECT id, name FROM "${SCHEMA}"."organization" WHERE id = $1`, [subjectId])
    if (org.rows.length === 0) {
      console.error(`组织不存在: ${subjectId}`)
      process.exit(1)
    }
    console.log(`目标组织: ${org.rows[0].name} (${subjectId})`)
  } else {
    const u = await pool.query(`SELECT id, email FROM "${SCHEMA}"."user" WHERE id = $1`, [subjectId])
    if (u.rows.length === 0) {
      console.error(`用户不存在: ${subjectId}`)
      process.exit(1)
    }
    console.log(`目标用户: ${u.rows[0].email} (${subjectId})`)
  }

  if (rollback) {
    const del = await pool.query(
      `DELETE FROM "${SCHEMA}"."relation_tuple"
       WHERE resource_type = 'session' AND relation = 'viewer' AND subject_type = $2 AND subject_id = $1
       RETURNING id`,
      [subjectId, subjectType],
    )
    console.log(`已回滚 ${del.rowCount} 条会话归属元组`)
    await pool.end()
    process.exit(0)
  }

  // 2) 拉 SaaS 会话
  const res = await fetch(`${SAAS_URL}/session`, { headers: { authorization: saasAuth() } })
  if (!res.ok) {
    console.error(`拉取 SaaS 会话失败: ${res.status}`)
    process.exit(1)
  }
  const sessions = await res.json()
  if (!Array.isArray(sessions)) {
    console.error("SaaS 会话响应不是数组")
    process.exit(1)
  }
  console.log(`SaaS 会话总数: ${sessions.length}`)

  // 3) 已有归属
  const existing = await pool.query(
    `SELECT resource_id FROM "${SCHEMA}"."relation_tuple"
     WHERE resource_type = 'session' AND relation = 'viewer' AND subject_type = $2 AND subject_id = $1`,
    [subjectId, subjectType],
  )
  const owned = new Set(existing.rows.map((r) => r.resource_id))
  const targets = sessions.map((s) => s.id).filter((id) => typeof id === "string" && !owned.has(id))

  console.log(`已归属: ${owned.size}，待迁移: ${targets.length}`)
  if (targets.length > 0) {
    console.log("示例:", targets.slice(0, 5).join(", "))
  }

  if (!apply) {
    console.log("\n[dry-run] 未写入。加 --apply 执行。")
    await pool.end()
    process.exit(0)
  }

  // 4) 批量写入
  const now = Date.now()
  let inserted = 0
  const batchSize = 500
  for (let i = 0; i < targets.length; i += batchSize) {
    const batch = targets.slice(i, i + batchSize)
    for (const sessionId of batch) {
      const r = await pool.query(
        `INSERT INTO "${SCHEMA}"."relation_tuple"
         (id, resource_type, resource_id, relation, subject_type, subject_id, created_by, time_created)
         VALUES ($1,'session',$2,'viewer',$3,$4,'migration',$5)
         ON CONFLICT DO NOTHING`,
        [`rt_${crypto.randomUUID().replace(/-/g, "")}`, sessionId, subjectType, subjectId, now],
      )
      inserted += r.rowCount ?? 0
    }
  }
  console.log(`已写入 ${inserted} 条会话归属元组`)

  // 5) 审计
  await pool.query(
    `INSERT INTO "${SCHEMA}"."audit_log"
     (id, actor_type, actor_id, action, resource_type, resource_id, result, metadata, time_created)
     VALUES ($1,'system','migration','migration.legacy_sessions',$2,$3,'allow',$4,$5)`,
    [
      `aud_${crypto.randomUUID().replace(/-/g, "")}`,
      subjectType === "org" ? "org" : "user",
      subjectId,
      JSON.stringify({ inserted, total: targets.length }),
      now,
    ],
  )
} finally {
  await pool.end()
}
