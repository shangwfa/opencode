import { test, expect, describe } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

describe("session-agent permission object syntax", () => {
  test("specer permission: edit whitelist matches relative path", () => {
    const parsed = Agent.CreateInput.safeParse({
      name: "specer",
      permission: {
        read: "allow",
        edit: {
          "*": "deny",
          "analysis/9f06e4c6/spec/*.md": "allow",
          "analysis/9f06e4c6/suggest-step.json": "allow",
        },
        bash: "deny",
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const ruleset = Permission.fromConfig(parsed.data.permission ?? {})
    expect(Permission.evaluate("edit", "analysis/9f06e4c6/spec/spec.md", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "analysis/9f06e4c6/suggest-step.json", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/components/index.tsx", ruleset).action).toBe("deny")
    expect(Permission.evaluate("read", "src/components/index.tsx", ruleset).action).toBe("allow")
    expect(Permission.evaluate("bash", "git status", ruleset).action).toBe("deny")
  })

  test("specer permission: **/ prefix does NOT match relative path (known wildcard limitation)", () => {
    const parsed = Agent.CreateInput.safeParse({
      name: "specer",
      permission: {
        edit: {
          "*": "deny",
          "**/analysis/9f06e4c6/spec/*.md": "allow",
        },
      },
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return

    const ruleset = Permission.fromConfig(parsed.data.permission ?? {})
    expect(Permission.evaluate("edit", "analysis/9f06e4c6/spec/spec.md", ruleset).action).toBe("deny")
  })
})
