import { Effect } from "effect"
import { Bus } from "../bus.js"
import { SessionEvent } from "@opencode/schema/session-event"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Hitl } from "./index.js"

/**
 * Delivers a terminal tool result for an ask whose run never consumed it (v1's
 * answered-lost salvage). Terminal tool events only move `running` parts, so a
 * run that already settled its part makes this a safe CAS miss. Callers run it
 * before resuming suspended sessions so a resumed run's reloaded history shows
 * the user's answer instead of a dangling tool call.
 */
type BusService = Effect.Success<typeof Bus.Service>

export const backfillAll = (bus: BusService) =>
  Effect.gen(function* () {
    for (const kind of ["permission", "question"] as const) {
      yield* Effect.forEach(yield* Hitl.backfillables(kind), (action) => publish(bus, action), {
        discard: true,
      })
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("hitl boot backfill failed", cause)))

function publish(bus: BusService, action: Hitl.SweepAction) {
  const base = {
    sessionID: action.sessionID as Session.ID,
    assistantMessageID: action.messageID as SessionMessage.ID,
    id: action.toolID,
    executed: true,
    metadata: { hitl: { salvaged: true, requestID: action.id } },
  }
  if (action.status === "replied") {
    return bus
      .publish(SessionEvent.Tool.Success, {
        ...base,
        content: [
          {
            type: "text" as const,
            text:
              action.answer ??
              (action.id.startsWith("frm_") ? "The user answered the question." : "The user approved this action."),
          },
        ],
      })
      .pipe(Effect.andThen(Hitl.markBackfilled(action.id)))
  }
  return bus.publish(SessionEvent.Tool.Failed, {
    ...base,
    error: {
      type: action.status === "rejected" ? "permission.declined" : "instance-restart",
      message: action.status === "rejected" ? "The user declined this action." : "实例重启，请求未处理",
    },
  })
}
