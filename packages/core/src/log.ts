export * as Log from "./log.js"

import { and, asc, eq, gt, or, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Log as LogSchema } from "@opencode/schema/log"
import type { SessionSchema } from "./session/schema.js"
import { Database } from "./database/database.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { currentTraceId } from "@opencode/util/observability/otlp"
import { LogTable } from "./log/sql.js"

export const ID = LogSchema.ID
export type ID = typeof ID.Type

export const Info = LogSchema.Info
export type Info = LogSchema.Info

export const Source = LogSchema.Source
export type Source = LogSchema.Source

export interface RecordInput {
  readonly sessionID: SessionSchema.ID
  readonly source: LogSchema.Source
  readonly detail?: Record<string, unknown>
}

export interface ListInput {
  readonly sessionID: SessionSchema.ID
  /** Page size; omitted returns the full audit trail for the Session. */
  readonly limit?: number
  /** Cursor: last entry ID of the previous page. Entries after it, oldest first. */
  readonly after?: ID
}

export interface Interface {
  /**
   * Persist one audit entry after the audited operation completed. Writes are
   * synchronous on the Session's database; a failed audit write is a defect so a
   * partial mutation never reports success silently.
   */
  readonly record: (input: RecordInput) => Effect.Effect<Info>
  /** Oldest-first audit entries for one Session, optionally paged by `after` cursor. */
  readonly list: (input: ListInput) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Log") {}

const detailValue = (detail: Record<string, unknown> | undefined) => {
  if (detail === undefined) return undefined
  const bytes = Buffer.byteLength(JSON.stringify(detail), "utf8")
  if (bytes <= LogSchema.MaxDetailBytes) return detail
  return { truncated: true, bytes }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db

    const record = Effect.fn("Log.record")(function* (input: RecordInput) {
      const now = Date.now()
      const id = ID.create()
      const detail = detailValue(input.detail)
      // Best-effort trace correlation: `undefined` (audit NULL) when OTLP is
      // not configured or no span is active, so audit writes never depend on
      // telemetry being present.
      const traceId = yield* currentTraceId.pipe(Effect.catch(() => Effect.succeed(undefined)))
      yield* db
        .insert(LogTable)
        .values({ id, session_id: input.sessionID, source: input.source, detail, trace_id: traceId, time_created: now })
        .run()
        .pipe(Effect.orDie)
      return Info.make({
        id,
        sessionID: input.sessionID,
        source: input.source,
        ...(detail === undefined ? {} : { detail }),
        ...(traceId === undefined ? {} : { traceId }),
        time: { created: now },
      })
    })

    const list = Effect.fnUntraced(function* (input: ListInput) {
      // Cursor pagination over (time_created, id): `after` is the last ID of the
      // previous page, so every entry can be reached without a hard cap. Without
      // `limit` the whole audit trail for the Session is returned.
      const cursor =
        input.after === undefined
          ? undefined
          : yield* db
              .select({ time: LogTable.time_created })
              .from(LogTable)
              .where(eq(LogTable.id, input.after))
              .get()
              .pipe(Effect.orDie)
      const query = db
        .select()
        .from(LogTable)
        .where(
          input.after === undefined
            ? eq(LogTable.session_id, input.sessionID)
            : cursor === undefined
              // Unknown cursor (pruned with its Session): nothing follows it.
              ? and(eq(LogTable.session_id, input.sessionID), sql`false`)
              : and(
                  eq(LogTable.session_id, input.sessionID),
                  or(
                    gt(LogTable.time_created, cursor.time),
                    and(eq(LogTable.time_created, cursor.time), gt(LogTable.id, input.after)),
                  ),
                ),
        )
        .orderBy(asc(LogTable.time_created), asc(LogTable.id))
      const scoped = input.limit === undefined ? query : query.limit(input.limit)
      const rows = yield* scoped
        .all()
        .pipe(Effect.orDie)
      return rows.map(
        (row): Info => ({
          id: row.id,
          sessionID: row.session_id,
          source: row.source,
          ...(row.detail === null ? {} : { detail: row.detail }),
          ...(row.trace_id === null ? {} : { traceId: row.trace_id }),
          time: { created: row.time_created },
        }),
      )
    })

    return Service.of({ record, list })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
