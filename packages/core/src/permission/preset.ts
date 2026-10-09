export * as PermissionPreset from "./preset.js"

import { Permission } from "@opencode/schema/permission"

const rule = (action: string, effect: Permission.Effect, resource = "*"): Permission.Rule => ({
  action,
  resource,
  effect,
})

const readActions = ["read", "glob", "grep", "webfetch", "websearch", "skill", "question"] as const

const readOnlyRules: Permission.Ruleset = [
  rule("*", "deny"),
  ...readActions.map((action) => rule(action, "allow")),
  rule("read", "ask", "*.env"),
  rule("read", "ask", "*.env.*"),
  rule("read", "allow", "*.env.example"),
]

const workspaceWriteRules: Permission.Ruleset = [
  rule("*", "ask"),
  ...readActions.map((action) => rule(action, "allow")),
  rule("read", "ask", "*.env"),
  rule("read", "ask", "*.env.*"),
  rule("read", "allow", "*.env.example"),
  rule("edit", "allow"),
  rule("external_directory", "deny"),
]

// Full access states the external-directory grant explicitly instead of relying on the
// catch-all: a rule reader (or a later narrowing of `*`) must not silently drop it.
const fullAccessRules: Permission.Ruleset = [rule("*", "allow"), rule("external_directory", "allow")]

export function rules(preset: Permission.Preset): Permission.Ruleset {
  switch (preset) {
    case "read-only":
      return readOnlyRules.map((item) => ({ ...item }))
    case "workspace-write":
      return workspaceWriteRules.map((item) => ({ ...item }))
    case "full-access":
      return fullAccessRules.map((item) => ({ ...item }))
  }
}
