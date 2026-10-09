import { expect, test } from "bun:test"
import { Permission } from "@opencode/core/permission"
import { PermissionPreset } from "@opencode/core/permission/preset"

test("permission presets map to the expected ordered Agent rules", () => {
  const readOnly = PermissionPreset.rules("read-only")
  expect(Permission.evaluate("read", "src/index.ts", readOnly).effect).toBe("allow")
  expect(Permission.evaluate("read", ".env", readOnly).effect).toBe("ask")
  expect(Permission.evaluate("read", ".env.example", readOnly).effect).toBe("allow")
  expect(Permission.evaluate("edit", "src/index.ts", readOnly).effect).toBe("deny")
  expect(Permission.evaluate("shell", "git status", readOnly).effect).toBe("deny")
  expect(Permission.evaluate("subagent", "reviewer", readOnly).effect).toBe("deny")

  const workspaceWrite = PermissionPreset.rules("workspace-write")
  expect(Permission.evaluate("read", "src/index.ts", workspaceWrite).effect).toBe("allow")
  expect(Permission.evaluate("edit", "src/index.ts", workspaceWrite).effect).toBe("allow")
  expect(Permission.evaluate("shell", "git status", workspaceWrite).effect).toBe("ask")
  expect(Permission.evaluate("external_directory", "/tmp/outside", workspaceWrite).effect).toBe("deny")
  expect(Permission.evaluate("mcp/deploy", "*", workspaceWrite).effect).toBe("ask")

  const fullAccess = PermissionPreset.rules("full-access")
  expect(Permission.evaluate("edit", "/workspace/src/index.ts", fullAccess).effect).toBe("allow")
  expect(Permission.evaluate("external_directory", "/tmp/outside", fullAccess).effect).toBe("allow")
  expect(fullAccess).toContainEqual({ action: "external_directory", resource: "*", effect: "allow" })
})

test("permission preset rules are returned as fresh arrays", () => {
  const first = [...PermissionPreset.rules("full-access")]
  first.push({ action: "read", resource: "*", effect: "deny" })
  expect(PermissionPreset.rules("full-access")).toEqual([
    { action: "*", resource: "*", effect: "allow" },
    { action: "external_directory", resource: "*", effect: "allow" },
  ])
})
