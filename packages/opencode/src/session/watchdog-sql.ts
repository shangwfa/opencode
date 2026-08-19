import { and, inArray, or, sql } from "drizzle-orm"
import { PartTable } from "./session.pg"

export const MONITORED_TOOLS = ["read", "write", "edit", "apply_patch", "glob", "grep", "list", "lsp", "todowrite"] as const

// bash 不纳入监控：npm install / dev server 等合法长跑命令远超 watchdog 超时，
// 标记会与真实完成状态竞争写 part。bash 的挂死由工具自身的超时兜底。

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
        ELSE ${PartTable.time_created} < ${startBefore}
      END`,
    )
  }
  return and(
    sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
    sql`json_extract(${PartTable.data}, '$.callID') IS NOT NULL`,
    callIDs?.length ? inArray(sql<string>`json_extract(${PartTable.data}, '$.callID')`, callIDs) : undefined,
    sql`json_extract(${PartTable.data}, '$.tool') IN (${toolList})`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
    sql`coalesce(json_extract(${PartTable.data}, '$.state.time.start'), ${PartTable.time_created}) < ${startBefore}`,
  )
}

export function watchdogToolCondition(input: {
  startBefore: number
  orphanBefore: number
  now: number
  dialect: "sqlite" | "pg"
  callIDs: string[]
}) {
  if (input.dialect !== "pg") {
    if (input.callIDs.length === 0) return and(runningToolCondition(input.startBefore, input.dialect), sql`1 = 0`)
    return runningToolCondition(input.startBefore, input.dialect, input.callIDs)
  }
  const local = input.callIDs.length
    ? inArray(sql<string>`${PartTable.data}->>'callID'`, input.callIDs)
    : sql`false`
  return and(
    runningToolCondition(input.startBefore, input.dialect),
    or(
      local,
      sql`CASE
        WHEN jsonb_typeof(${PartTable.data}->'state'->'metadata'->'watchdog'->'leaseUntil') = 'number'
        THEN (${PartTable.data}->'state'->'metadata'->'watchdog'->>'leaseUntil')::bigint <= ${input.now}
        ELSE CASE
          WHEN jsonb_typeof(${PartTable.data}->'state'->'time'->'start') = 'number'
          THEN (${PartTable.data}->'state'->'time'->>'start')::bigint < ${input.orphanBefore}
          ELSE ${PartTable.time_created} < ${input.orphanBefore}
        END
      END`,
    ),
  )
}
