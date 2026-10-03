// 测试真实脚本中的SQL/registry片段；PG用CTE模拟状态，不写业务表。
import { test, expect, afterAll } from "bun:test"
import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { Script } from "node:vm"

const source = readFileSync(new URL("./snapshot-restore-matrix-e2e.mjs", import.meta.url), "utf8")
const sql = source.match(/const ready = await db`([^`]+)`/)?.[1]?.replace("${sid}", "$1")
const registry = source.match(/registry=\$\(pnpm config get registry\); ([^`]+)`\)/)?.[1]
const db = process.env.OPENCODE_DATABASE_URL ? new Bun.SQL(process.env.OPENCODE_DATABASE_URL) : null
afterAll(async () => { if (db) await db.close() })

test("远端挂载脚本保持可编译", () => {
  const text = source.match(/const mounts = String.raw`([^`]+)`/)?.[1]
  expect(typeof text).toBe("string")
  expect(() => new Script(text)).not.toThrow()
})

test("registry接受等价尾斜杠且拒绝其他源", () => {
  expect(typeof registry).toBe("string")
  for (const [url, code] of [["https://registry.npmmirror.com", 0], ["https://registry.npmmirror.com/", 0], ["https://registry.npmjs.org/", 1], ["https://registry.npmmirror.com.evil/", 1]]) {
    const result = spawnSync("sh", ["-c", registry], { env: { ...process.env, registry: url }, encoding: "utf8" })
    expect(result.status).toBe(code)
  }
})

const pgTest = db ? test : test.skip
async function selected(rows) {
  const params = ["test-sid"]
  const values = rows.map((row) => {
    const start = params.length + 1
    params.push(row.id, row.state, row.source ?? "source", row.sid ?? "test-sid", row.scope ?? "session", row.time)
    return `($${start}::text,$${start + 1}::text,$${start + 2}::text,$${start + 3}::text,$${start + 4}::text,$${start + 5}::bigint)`
  }).join(",")
  expect(typeof sql).toBe("string")
  return await db.unsafe(`WITH session_snapshot(id,state,source_sandbox_id,session_id,scope,time_created) AS (VALUES ${values}) ${sql}`, params)
}

pgTest("已恢复stale仍是可重复恢复点", async () => {
  const rows = await selected([{ id: "consumed", state: "stale", time: 10 }])
  expect(rows[0]?.id).toBe("consumed")
})
pgTest("按创建时间选最新，不偏向ready", async () => {
  const rows = await selected([{ id: "older", state: "ready", time: 10 }, { id: "latest", state: "stale", time: 20 }])
  expect(rows[0]?.id).toBe("latest")
})
pgTest("排除不可恢复状态、其他会话与其他scope", async () => {
  const rows = await selected([
    { id: "expected", state: "ready", time: 10 },
    ...["creating", "failed", "deleting", "deleted"].map((state) => ({ id: state, state, time: 20 })),
    { id: "foreign", state: "ready", time: 30, sid: "other" },
    { id: "foreign-scope", state: "ready", time: 40, scope: "other" },
  ])
  expect(rows[0]?.id).toBe("expected")
})
pgTest("没有恢复点才返回空", async () => {
  expect(await selected([{ id: "failed", state: "failed", time: 10 }])).toEqual([])
})
