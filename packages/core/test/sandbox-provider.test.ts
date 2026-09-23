import { describe, expect } from "bun:test"
import { Effect, Exit } from "effect"
import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Global } from "@opencode/util/global"
import { filesystem } from "@opencode/util/effect/app-node-platform"
import { FSUtil } from "@opencode/util/fs-util"
import { testEffect } from "./lib/effect"

// Without OPENCODE_SANDBOX_ENABLED the provider layer builds in disabled mode:
// tools keep their local path and lifecycle helpers stay safe no-ops.
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, FSUtil.node, filesystem, Global.node, SandboxProvider.node])),
)

describe("SandboxProvider disabled layer", () => {
  it.effect("reports disabled and keeps lifecycle as no-ops", () =>
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      expect(provider.enabled).toBe(false)
      yield* provider.interrupt("ses_anything")
      yield* provider.destroy("ses_anything")
    }),
  )

  it.effect("refuses remote runs with a defect instead of silently executing locally", () =>
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      const exit = yield* provider
        .run({ sessionID: "ses_x", command: "echo hi", hostWorkdir: "/workspace", timeoutMs: 1000 })
        .pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})
