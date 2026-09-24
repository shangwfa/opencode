export * as SessionPvcMode from "./session-pvc-mode.js"

import { Schema } from "effect"

/**
 * PVC sharing scope for a sandboxed session. `session` isolates the session's
 * volume data under its own ID; `app` shares one volume prefix across every
 * session of the same appId. Absent means the deployment default (no
 * PVC-aware routing).
 */
export const PvcMode = Schema.Literals(["session", "app"]).annotate({
  identifier: "Session.PvcMode",
  description: "PVC sharing scope: per-session isolation or app-level sharing via appId.",
})
export type PvcMode = typeof PvcMode.Type
