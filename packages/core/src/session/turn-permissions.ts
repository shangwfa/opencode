export * as SessionTurnPermissions from "./turn-permissions.js"

import type { Permission } from "@opencode/schema/permission"
import type { SessionMessage } from "@opencode/schema/session-message"
import { PermissionPreset } from "../permission/preset.js"

/** Resolves permission inputs attached to the exact user prompt that owns this assistant turn. */
export function resolve(message: SessionMessage.Info | undefined): Permission.Ruleset | undefined {
  if (!message || message.type !== "user") return undefined
  if (message.preset === undefined && message.permissions === undefined) return undefined
  return [
    ...(message.preset === undefined ? [] : PermissionPreset.rules(message.preset)),
    ...(message.permissions ?? []),
  ]
}
