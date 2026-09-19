export * as SessionWatchdog from "./watchdog.js"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { Location } from "../location.js"
import { AbsolutePath } from "@opencode/core/schema"
import { Workspace } from "@opencode/schema/workspace"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { SessionEvent } from "./event.js"

/**
 * Watchdog for tool parts stuck in a non-terminal state. A process death
 * between `tool.called` and the terminal event leaves the projected part
 * running forever; the scan republishes `session.tool.failed` so projection
 * settles it, mirroring v1's watchdog semantics (timeout + "(watchdog)"
 * marker) on the event-sourced model.
 *
 * `shell` is deliberately unmonitored: legitimate long commands (installs,
 * dev servers) far exceed the timeout and would race real completion.
 */
const MONITORED_TOOLS = ["read", "write", "edit", "patch", "glob", "grep"] as const

const TIMEOUT_MS = (Number(process.env.OPENCODE_WATCHDOG_TIMEOUT_SEC) || 120) * 1000
const SCAN_INTERVAL_SECONDS = Number(process.env.OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC) || 15

export interface Interface {
  readonly scanOnce: Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWatchdog") {}

interface StuckPart {
  readonly sessionID: string
  readonly messageID: string
  readonly partID: string
  readonly directory: string
  readonly workspaceID: string | null
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const bus = yield* Bus.Service
    const scanOnce: Effect.Effect<number> = Effect.gen(function* () {
      const before = Date.now() - TIMEOUT_MS
      const rows = yield* db
        .all<StuckPart>(sql`
          select m.session_id as "sessionID", m.id as "messageID",
                 c->>'id' as "partID", s.directory as directory, s.workspace_id as "workspaceID"
          from session_message m
          join session_v2 s on s.id = m.session_id
          cross join jsonb_array_elements(m.data::jsonb->'content') c
          where c->>'type' = 'tool'
            and c->>'name' in (${sql.join(MONITORED_TOOLS.map((tool) => sql`${tool}`), sql`, `)})
            and c->'state'->>'status' in ('running', 'streaming')
            and coalesce((c->'time'->>'created')::bigint, m.time_created) < ${before}
          limit 200
        `)
        .pipe(Effect.orDie)
      for (const row of rows) {
        yield* bus
          .publish(
            SessionEvent.Tool.Failed,
            {
              sessionID: Session.ID.make(row.sessionID),
              assistantMessageID: SessionMessage.ID.make(row.messageID),
              id: row.partID,
              error: {
                type: "watchdog.timeout",
                message: `Tool execution timed out after ${Math.round(TIMEOUT_MS / 1000)}s (watchdog).`,
              },
              executed: false,
            },
            {
              location: Location.Ref.make({
                directory: AbsolutePath.make(row.directory),
                ...(row.workspaceID ? { workspaceID: Workspace.ID.make(row.workspaceID) } : {}),
              }),
            },
          )
          .pipe(Effect.catchCause((cause) => Effect.logWarning("watchdog settle failed", cause)))
      }
      if (rows.length > 0) yield* Effect.logInfo("session watchdog settled stuck parts", { count: rows.length })
      return rows.length
    })
    // Boot sweep settles orphans left by a previous process before steady-state scans.
    yield* Effect.logInfo("session watchdog armed", { timeoutMs: TIMEOUT_MS, scanSeconds: SCAN_INTERVAL_SECONDS }).pipe(
      Effect.andThen(scanOnce),
      Effect.repeat(Schedule.spaced(`${SCAN_INTERVAL_SECONDS} seconds`)),
      Effect.catchCause((cause) => Effect.logWarning("session watchdog scan failed", cause)),
      Effect.andThen(Effect.void),
      Effect.forkScoped,
    )
    return Service.of({ scanOnce })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Bus.node, Database.node] })
