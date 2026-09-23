// 从上游 sqlite 迁移链导出完整 schema，并翻译为 PostgreSQL DDL。
// 用法：bun dump-pg-schema.ts > ../src/database/pg-schema.sql
import { writeFileSync } from "node:fs"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { Database } from "./src/database/database.js"
import { LayerNode } from "@opencode/util/effect/layer-node.js"

const program = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const rows = yield* db.all<{ name: string; type: string; sql: string }>(
    sql`SELECT name, type, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rootpage`,
  )
  return rows
})

type Stmt = { name: string; type: string; sql: string }

const translateType = (ddl: string) =>
  ddl
    .replace(/`/g, '"')
    .replace(/\bbegin\s+(deferred|immediate|exclusive)\b/gi, "BEGIN")
    .replace(/\binteger\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi, "serial PRIMARY KEY")
    .replace(/\bblob\b/gi, "bytea")
    .replace(/\breal\b/gi, "double precision")
    .replace(/\bnumeric\b/gi, "double precision")
    .replace(/\binteger\b/gi, "bigint")

// 把 CREATE TABLE 里的 FK 约束抽出来，放到最后以 ALTER TABLE 方式补建
const FK_RE = /,\s*(CONSTRAINT "[^"]+" FOREIGN KEY \([^)]*\) REFERENCES "[^"]+"\s*\([^)]*\)(?:\s+ON (?:DELETE|UPDATE) (?:CASCADE|SET NULL|SET DEFAULT|RESTRICT|NO ACTION))*)/g

const stmts = await Effect.runPromise(program.pipe(Effect.provide(LayerNode.compile(Database.node)))) as Stmt[]

const tables: string[] = []
const indexes: string[] = []
const fkAlters: string[] = []

for (const row of stmts) {
  if (row.type === "table") {
    let ddl = row.sql.replace(/`/g, '"')
    const tableName = /CREATE TABLE "([^"]+)"/.exec(ddl)?.[1] ?? row.name
    let fks: string[] = []
    ddl = ddl.replace(FK_RE, (_m, clause: string) => {
      fks.push(`ALTER TABLE "${tableName}" ADD ${clause};`)
      return ""
    })
    tables.push(translateType(ddl) + ";")
    for (const fk of fks) fkAlters.push(translateType(fk))
  } else if (row.type === "index") {
    indexes.push(translateType(row.sql.replace(/`/g, '"')) + ";")
  }
  // trigger/view：上游迁移链暂无，忽略
}
console.error(`tables=${tables.length} indexes=${indexes.length} fks=${fkAlters.length}`)

const out = [
  "-- 自动生成：上游 sqlite 迁移链的 PG 翻译（dump-pg-schema.ts 产出）",
  "-- 顺序：全部表（无 FK）-> 索引 -> FK 约束",
  ...tables,
  "",
  ...indexes,
  "",
  ...fkAlters,
  "",
]
writeFileSync(new URL("./src/database/pg-schema.sql", import.meta.url), out.join("\n"))
console.error("pg-schema.sql written")
