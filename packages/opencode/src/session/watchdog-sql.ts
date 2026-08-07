import { and, inArray, sql } from "drizzle-orm"
import { PartTable } from "./session.pg"

export const MONITORED_TOOLS = ["read", "write", "edit", "apply_patch", "glob", "grep", "ls"] as const

export function runningToolCondition(startBefore: number, dialect: "sqlite" | "pg" = "sqlite", callIDs?: string[]) {
  const toolList = sql.raw(MONITORED_TOOLS.map((t) => `'${t}'`).join(", "))
  if (dialect === "pg") {
    return and(
      sql`${PartTable.data}->>'type' = 'tool'`,
      sql`${PartTable.data}->>'callID' IS NOT NULL`,
      callIDs?.length ? inArray(sql<string>`${PartTable.data}->>'callID'`, callIDs) : undefined,
      sql`${PartTable.data}->>'tool' IN (${toolList})`,
      sql`${PartTable.data}->'state'->>'status' = 'running'`,
      sql`CASE
        WHEN jsonb_typeof(${PartTable.data}->'state'->'time'->'start') = 'number'
        THEN (${PartTable.data}->'state'->'time'->>'start')::bigint < ${startBefore}
        ELSE false
      END`,
    )
  }
  return and(
    sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
    sql`json_extract(${PartTable.data}, '$.callID') IS NOT NULL`,
    callIDs?.length ? inArray(sql<string>`json_extract(${PartTable.data}, '$.callID')`, callIDs) : undefined,
    sql`json_extract(${PartTable.data}, '$.tool') IN (${toolList})`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
    sql`json_extract(${PartTable.data}, '$.state.time.start') < ${startBefore}`,
  )
}
