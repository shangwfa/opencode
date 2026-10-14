/** 只读扫描；显式设置 KNOWLEDGE_DATABASE_URL，发现碰撞退出码 1，运行失败退出码 2。 */
import { Pool } from "pg"
import { findIndexCollisions, type IndexOwner } from "../src/data-table/services/index-identity-audit.js"

let pool: Pool | undefined
try {
  const connectionString = process.env.KNOWLEDGE_DATABASE_URL
  const schema = process.env.KNOWLEDGE_DATABASE_SCHEMA ?? "knowledge"
  if (!connectionString) throw new Error("Set KNOWLEDGE_DATABASE_URL explicitly")
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) throw new Error("Invalid schema identifier")
  pool = new Pool({ connectionString })
  const client = await pool.connect()
  try {
    await client.query("BEGIN READ ONLY")
    const owners: IndexOwner[] = []
    for (const [domain, table] of [["data-table", "databases"], ["rag", "knowledge_bases"]] as const) {
      const exists = await client.query("SELECT to_regclass($1) AS name", [`"${schema}"."${table}"`])
      if (!exists.rows[0].name) continue
      const result = await client.query(`SELECT id, index_name FROM "${schema}"."${table}" ORDER BY id`)
      owners.push(...result.rows.map(row => ({ domain, id: row.id, indexName: row.index_name })))
    }
    const collisions = findIndexCollisions(owners)
    await client.query("COMMIT")
    console.log(JSON.stringify({ schema, registeredOwners: owners.length, collisions }, null, 2))
    if (collisions.length) process.exitCode = 1
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 2
} finally {
  await pool?.end()
}
