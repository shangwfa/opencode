import { expect, test } from "bun:test"
import { Instructions } from "@opencode/core/instructions/index"
import { SessionAgentsMd } from "@opencode/core/session/agents-md"

test("does not inherit Session AGENTS.md instruction state when forking", () => {
  const values: Instructions.Values = {
    [SessionAgentsMd.Key]: Instructions.Hash.make("a".repeat(64)),
    "api/entry": Instructions.Hash.make("b".repeat(64)),
  }

  expect(SessionAgentsMd.fork(values)).toEqual({ "api/entry": Instructions.Hash.make("b".repeat(64)) })
})
