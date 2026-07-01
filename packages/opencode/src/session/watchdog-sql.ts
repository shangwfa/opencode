import { and, sql } from "drizzle-orm"
import { PartTable } from "./session.pg"

export const MONITORED_TOOLS = ["read", "write", "edit", "apply_patch", "glob", "grep", "ls"] as const

export function runningToolCondition(startBefore: number, dialect: "sqlite" | "pg" = "sqlite") {
  const toolList = sql.raw(MONITORED_TOOLS.map((t) => `'${t}'`).join(", "))
  if (dialect === "pg") {
    return and(
      sql`${PartTable.data}->>'type' = 'tool'`,
      sql`${PartTable.data}->>'tool' IN (${toolList})`,
      sql`${PartTable.data}->'state'->>'status' = 'running'`,
      sql`(${PartTable.data}->'state'->'time'->>'start')::bigint < ${startBefore}`,
    )
  }
  return and(
    sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
    sql`json_extract(${PartTable.data}, '$.tool') IN (${toolList})`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
    sql`json_extract(${PartTable.data}, '$.state.time.start') < ${startBefore}`,
  )
}
