import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { isWatchdogTimeout, settleWatchdogTimeout } from "../../src/session/processor"

function part(input: { status: "error" | "completed"; timeout?: boolean }) {
  const base = {
    id: PartID.make("prt_watchdog_settle"),
    messageID: MessageID.make("msg_watchdog_settle"),
    sessionID: SessionID.make("ses_watchdog_settle"),
    type: "tool" as const,
    callID: "call_watchdog_settle",
    tool: "read",
  }
  if (input.status === "completed") {
    return {
      ...base,
      state: {
        status: "completed" as const,
        input: {},
        output: "ok",
        title: "read",
        metadata: {},
        time: { start: 1, end: 2 },
      },
    }
  }
  return {
    ...base,
    state: {
      status: "error" as const,
      input: {},
      error: "failed",
      metadata: input.timeout ? { timeout: true } : {},
      time: { start: 1, end: 2 },
    },
  }
}

describe("processor watchdog settlement", () => {
  test("settles a tool call already terminated by watchdog", async () => {
    let settled = 0
    const timedOut = part({ status: "error", timeout: true })

    expect(isWatchdogTimeout(timedOut)).toBe(true)
    expect(await Effect.runPromise(settleWatchdogTimeout(timedOut, Effect.sync(() => settled++)))).toBe(true)
    expect(settled).toBe(1)
  })

  test("does not settle unrelated terminal states", async () => {
    let settled = 0
    const settle = Effect.sync(() => settled++)

    expect(await Effect.runPromise(settleWatchdogTimeout(part({ status: "error" }), settle))).toBe(false)
    expect(await Effect.runPromise(settleWatchdogTimeout(part({ status: "completed" }), settle))).toBe(false)
    expect(settled).toBe(0)
  })
})
