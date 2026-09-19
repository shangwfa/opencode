import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { CodeModePolicy } from "@/tool/code-mode-policy"
import { Tool } from "@/tool/tool"

const def = (id: string) =>
  ({
    id,
    description: id,
    parameters: Schema.Unknown,
    execute: () => {
      throw new Error("not executable")
    },
  }) as Tool.Def

const tools = ["execute", "invalid", "question", "task", "skill", "read", "glob", "write", "custom"].map(def)

describe("code mode policy", () => {
  test("preserves off and MCP-only modes", () => {
    expect(CodeModePolicy.select("off", tools)).toEqual([])
    expect(CodeModePolicy.select("mcp", tools)).toEqual([])
  })

  test("read mode exposes only the curated read-only tools", () => {
    expect(CodeModePolicy.select("read", tools).map((tool) => tool.id)).toEqual(["read", "glob"])
  })

  test("all mode includes product tools but excludes orchestration controls", () => {
    expect(CodeModePolicy.select("all", tools).map((tool) => tool.id)).toEqual(["read", "glob", "write", "custom"])
  })
})
