import { describe, expect, test } from "bun:test"
import PROMPT_DEFAULT from "../../src/session/prompt/default.txt"
import PROMPT_BEAST from "../../src/session/prompt/beast.txt"
import PROMPT_ASTRA from "../../src/session/prompt/gpt-astra.txt"
import * as System from "../../src/session/system"

describe("system prompt provider routing (upstream merge: gpt-6 Astra)", () => {
  test("routes gpt-6 models to the Astra prompt", () => {
    const prompts = System.provider({
      api: { id: "gpt-6-preview" },
    } as never)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toBe(PROMPT_ASTRA)
    expect(prompts[0]).not.toBe(PROMPT_DEFAULT)
    expect(prompts[0]).not.toBe(PROMPT_BEAST)
  })

  test("still routes gpt-4/o1/o3 to the Beast prompt", () => {
    const prompts = System.provider({
      api: { id: "gpt-4o" },
    } as never)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toBe(PROMPT_BEAST)
  })

  test("still routes gpt codex models to the Codex prompt", () => {
    const prompts = System.provider({
      api: { id: "gpt-5-codex" },
    } as never)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toBe(PROMPT_ASTRA)
  })

  test("non-gpt models use their own prompt (not Astra)", () => {
    const prompts = System.provider({
      api: { id: "claude-4" },
    } as never)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toBe(PROMPT_ASTRA)
    expect(prompts[0]).not.toBe(PROMPT_DEFAULT)
  })
})
