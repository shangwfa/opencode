import assert from "node:assert/strict"
import test from "node:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { serializeHistory } from "../../src/session/compaction"

test("V1 compaction history keeps complete tool output and includes a stable header", () => {
  const output = "full tool output\n".repeat(400)
  const message = {
    info: {
      id: "msg_history_1",
      role: "assistant",
      sessionID: "ses_history_1",
      agent: "assistant",
      time: { created: Date.parse("2026-09-03T00:00:00.000Z") },
    },
    parts: [
      {
        id: "prt_history_1",
        messageID: "msg_history_1",
        sessionID: "ses_history_1",
        type: "tool",
        tool: "bash",
        callID: "call_history_1",
        state: {
          status: "completed",
          input: { command: "printf output" },
          output,
          time: {},
        },
      },
    ],
  } as unknown as SessionV1.WithParts

  const serialized = serializeHistory(message)

  assert.match(serialized, /^## msg_history_1 \| assistant \| 2026-09-03T00:00:00\.000Z/)
  assert.ok(serialized.includes(output))
  assert.doesNotMatch(serialized, /\[truncated\]/)
})
