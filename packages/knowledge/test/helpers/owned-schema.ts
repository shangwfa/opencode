import { randomUUID } from "node:crypto"

type Queryable = { query: (sql: string) => Promise<unknown> }

/** 清理权限来自成功创建的唯一 schema，不能来自继承的环境变量。 */
export function createOwnedTestSchema(suite: string) {
  if (!/^[a-z][a-z0-9_]{0,14}$/.test(suite)) throw new Error("Invalid E2E suite name")
  const name = `knowledge_test_${suite}_${randomUUID().replaceAll("-", "")}`
  let owned = false
  return Object.freeze({
    name,
    async prepare(pool: Queryable, actualSchema: string) {
      if (actualSchema !== name) throw new Error(`E2E database schema mismatch: expected ${name}, received ${actualSchema}; run suites with --isolate`)
      if (owned) throw new Error("E2E schema already prepared")
      await pool.query(`CREATE SCHEMA "${name}"`)
      owned = true
    },
    async cleanup(pool: Queryable) {
      if (!owned) return
      await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
      owned = false
    },
  })
}
