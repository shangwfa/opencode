import { Duration, Effect, Schedule } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import { Log } from "@opencode-ai/core/util/log"
import { Database } from "../storage/db"
import { PartTable } from "./session.pg"
import type { MessageID, SessionID } from "./schema"

const log = Log.create({ service: "tool-execution-lease" })
const ownerID = randomUUID()
const heartbeatInterval = Duration.seconds(30)
export const leaseDurationMs = 2 * 60 * 1000

export function refresh(input: { sessionID: SessionID; messageID: MessageID; callID: string; now?: number }) {
  if (Database.dialect !== "pg") return Effect.succeed(false)
  const now = input.now ?? Date.now()
  return Effect.tryPromise({
    try: () => Database.Client()
      .update(PartTable)
      .set({
        data: sql`jsonb_set(
          ${PartTable.data},
          '{state,metadata}',
          COALESCE(${PartTable.data}->'state'->'metadata', '{}'::jsonb) || jsonb_build_object(
            'watchdog',
            jsonb_build_object('owner', ${ownerID}::text, 'leaseUntil', ${now + leaseDurationMs}::bigint)
          )
        )`,
        time_updated: now,
      })
      .where(and(
        eq(PartTable.session_id, input.sessionID),
        eq(PartTable.message_id, input.messageID),
        sql`${PartTable.data}->>'type' = 'tool'`,
        sql`${PartTable.data}->>'callID' = ${input.callID}`,
        sql`${PartTable.data}->'state'->>'status' = 'running'`,
      ))
      .returning({ id: PartTable.id })
      .then((rows: Array<{ id: string }>) => rows.length > 0),
    catch: (error) => new Error(`tool execution lease refresh failed: ${String(error)}`),
  })
}

export function maintain(input: { sessionID: SessionID; messageID: MessageID; callID: string }) {
  if (Database.dialect !== "pg") return Effect.never
  return refresh(input).pipe(
    Effect.catchCause((cause) => {
      log.error("tool execution lease refresh failed", { callID: input.callID, cause: String(cause) })
      return Effect.succeed(false)
    }),
    Effect.repeat(Schedule.spaced(heartbeatInterval)),
    Effect.andThen(Effect.never),
  )
}

export * as ToolExecutionLease from "./tool-execution-lease"
