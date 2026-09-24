export * as SessionStream from "./session-stream"

/**
 * Session-scoped SSE helpers shared by `session.event` and `session.prompt_stream`. They are pure
 * so the stream wiring in the handler stays thin and the routing rules are unit-testable.
 */

/** True when a public event carries the sessionID that a session-scoped stream is filtered to. */
export const sessionEventFilter = (sessionID: string) => (event: { readonly data: unknown }) => {
  const data = event.data
  return typeof data === "object" && data !== null && "sessionID" in data && data.sessionID === sessionID
}

/**
 * Terminal predicate for `prompt_stream`. The stream ends only after the admitted inbox item has
 * been delivered and that execution reached a terminal state, so a queued prompt never ends on the
 * previous round's completion. Frames before delivery, other inbox items, and unparsable frames do
 * not end the stream.
 */
export const makePromptStreamTakeUntil = (inboxID: string) => {
  let delivered = false
  return (frame: string) => {
    let event: { type?: string; data?: { inboxID?: string } }
    try {
      event = JSON.parse(frame.startsWith("data: ") ? (frame.slice(6).split("\n", 1)[0] ?? "") : "")
    } catch {
      return false
    }
    if (event.type === "session.inbox.delivered" && event.data?.inboxID === inboxID) delivered = true
    return (
      delivered &&
      (event.type === "session.execution.succeeded" ||
        event.type === "session.execution.failed" ||
        event.type === "session.execution.interrupted")
    )
  }
}
