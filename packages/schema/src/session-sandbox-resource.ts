export * as SessionSandboxResource from "./session-sandbox-resource.js"

import { Schema } from "effect"
import { optional } from "./schema.js"

export const Info = Schema.Struct({
  cpu: Schema.String,
  memory: Schema.String,
  /**
   * Per-session container image. Omitted or blank means the deployment default
   * (`OPENCODE_SANDBOX_IMAGE`), matching the V1 line, where a session without an
   * image used the instance default.
   */
  image: optional(Schema.String),
  /**
   * Workspace persistence mode for this session. `snapshot` keeps the workspace
   * on the sandbox rootfs and persists it through sandbox snapshots taken
   * before recycle (see docs/sandbox-snapshot-design.md); the deployment
   * default (`OPENCODE_SANDBOX_VOLUME_TYPE`) applies when omitted.
   */
  persistMode: optional(Schema.Literals(["pvc", "snapshot", "none"])),
}).annotate({ identifier: "Session.SandboxResource" })
export interface Info extends Schema.Schema.Type<typeof Info> {}
