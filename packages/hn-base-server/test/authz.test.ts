/**
 * ReBAC 授权层测试（真实 PG，独立 schema）。
 * 覆盖：owner / 跨用户 / 组织成员 / parent 继承 / 过期 / listObjects 与 check 一致性。
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { check, deleteTuples, listObjects, writeTuples } from "../src/authz/index.js"
import { env } from "../src/config/env.js"
import { ensureSchema } from "../src/db/ensure-schema.js"
import { db, pool, schema } from "../src/db/index.js"

const S = env.databaseSchema
let seq = 0
const uid = (p: string) => `${p}_${Date.now()}_${seq++}`

async function insertUser(id: string, email: string) {
  await pool.query(
    `INSERT INTO "${S}"."user" (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, email, email],
  )
}

async function insertMember(orgId: string, userId: string, role: string) {
  await pool.query(
    `INSERT INTO "${S}"."member" (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`,
    [uid("mem"), orgId, userId, role],
  )
}

async function insertOrg(id: string, slug: string) {
  await pool.query(
    `INSERT INTO "${S}"."organization" (id, name, slug) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [id, slug, slug],
  )
}

beforeAll(async () => {
  await ensureSchema(pool, S)
})

afterAll(async () => {
  await pool.end()
})

describe("authz/check", () => {
  it("owner 可读；其他人不可读", async () => {
    const alice = uid("user")
    const bob = uid("user")
    await insertUser(alice, `${alice}@e.com`)
    await insertUser(bob, `${bob}@e.com`)
    const reqId = uid("req")
    await writeTuples(db, [
      { resourceType: "requirement", resourceId: reqId, relation: "owner", subjectType: "user", subjectId: alice },
    ])
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(true)
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "write", object: { type: "requirement", id: reqId } })).toBe(true)
    expect(await check(db, { subject: { type: "user", id: bob }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(false)
  })

  it("组织成员可读，非成员不可读", async () => {
    const alice = uid("user")
    const bob = uid("user")
    const org = uid("org")
    await insertUser(alice, `${alice}@e.com`)
    await insertUser(bob, `${bob}@e.com`)
    await insertOrg(org, uid("slug"))
    await insertMember(org, alice, "member")

    const reqId = uid("req")
    await writeTuples(db, [
      { resourceType: "requirement", resourceId: reqId, relation: "viewer", subjectType: "org", subjectId: org },
    ])
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(true)
    expect(await check(db, { subject: { type: "user", id: bob }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(false)
  })

  it("viewer 不能写（权限 = 关系的组合）", async () => {
    const alice = uid("user")
    const org = uid("org")
    await insertUser(alice, `${alice}@e.com`)
    await insertOrg(org, uid("slug"))
    await insertMember(org, alice, "viewer")
    const reqId = uid("req")
    await writeTuples(db, [
      { resourceType: "requirement", resourceId: reqId, relation: "viewer", subjectType: "org", subjectId: org },
    ])
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(true)
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "write", object: { type: "requirement", id: reqId } })).toBe(false)
  })

  it("parent 继承：会话继承需求的读权限", async () => {
    const alice = uid("user")
    const bob = uid("user")
    await insertUser(alice, `${alice}@e.com`)
    await insertUser(bob, `${bob}@e.com`)
    const reqId = uid("req")
    const sid = uid("ses")
    await writeTuples(db, [
      { resourceType: "requirement", resourceId: reqId, relation: "owner", subjectType: "user", subjectId: alice },
      { resourceType: "session", resourceId: sid, relation: "parent", subjectType: "requirement", subjectId: reqId },
    ])
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "session", id: sid } })).toBe(true)
    expect(await check(db, { subject: { type: "user", id: bob }, permission: "read", object: { type: "session", id: sid } })).toBe(false)
  })

  it("过期元组立即失效", async () => {
    const alice = uid("user")
    await insertUser(alice, `${alice}@e.com`)
    const reqId = uid("req")
    await writeTuples(db, [
      {
        resourceType: "requirement",
        resourceId: reqId,
        relation: "viewer",
        subjectType: "user",
        subjectId: alice,
        expiresAt: Date.now() - 1000,
      },
    ])
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(false)
  })

  it("删除元组后立即失去权限（白名单语义）", async () => {
    const alice = uid("user")
    await insertUser(alice, `${alice}@e.com`)
    const reqId = uid("req")
    await writeTuples(db, [
      { resourceType: "requirement", resourceId: reqId, relation: "owner", subjectType: "user", subjectId: alice },
    ])
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(true)
    await deleteTuples(db, { resourceType: "requirement", resourceId: reqId })
    expect(await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "requirement", id: reqId } })).toBe(false)
  })

  it("未定义权限默认拒绝", async () => {
    const alice = uid("user")
    await insertUser(alice, `${alice}@e.com`)
    expect(
      await check(db, { subject: { type: "user", id: alice }, permission: "fly", object: { type: "requirement", id: uid("req") } }),
    ).toBe(false)
  })
})

describe("authz/listObjects 与 check 一致", () => {
  it("列表只包含可读资源，且与逐条 check 结果一致", async () => {
    const alice = uid("user")
    const bob = uid("user")
    await insertUser(alice, `${alice}@e.com`)
    await insertUser(bob, `${bob}@e.com`)

    const mine = uid("req")
    const others = uid("req")
    await writeTuples(db, [
      { resourceType: "requirement", resourceId: mine, relation: "owner", subjectType: "user", subjectId: alice },
      { resourceType: "requirement", resourceId: others, relation: "owner", subjectType: "user", subjectId: bob },
    ])

    const ids = await listObjects(db, { subject: { type: "user", id: alice }, permission: "read", type: "requirement" })
    expect(ids).toContain(mine)
    expect(ids).not.toContain(others)

    for (const id of [mine, others]) {
      const direct = await check(db, { subject: { type: "user", id: alice }, permission: "read", object: { type: "requirement", id } })
      expect(ids.includes(id)).toBe(direct)
    }
  })
})
