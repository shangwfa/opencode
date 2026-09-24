import { describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { SandboxProvider, assembleStreamText } from "@opencode/core/sandbox/provider"
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

describe("assembleStreamText", () => {
  // execd emits one stream event per output line with the newline stripped.
  test("restores line structure from per-line events", () => {
    expect(assembleStreamText(["/workspace/a.ts", "/workspace/b.ts", "/workspace/c.ts"])).toBe(
      "/workspace/a.ts\n/workspace/b.ts\n/workspace/c.ts",
    )
  })

  test("keeps a single line without a trailing newline", () => {
    expect(assembleStreamText(["done"])).toBe("done")
    expect(assembleStreamText(["1"])).toBe("1")
  })

  test("returns empty output for no events", () => {
    expect(assembleStreamText([])).toBe("")
  })

  test("never fuses lines into one string", () => {
    const fused = assembleStreamText(["line1", "line2"])
    expect(fused).toContain("\n")
    expect(fused.split("\n")).toEqual(["line1", "line2"])
  })

  test("round-trips through the line-oriented glob parser shape", () => {
    const lines = assembleStreamText(["f1.txt", "f2.txt", "f3.txt"]).split("\n").filter((line) => line.length > 0)
    expect(lines).toEqual(["f1.txt", "f2.txt", "f3.txt"])
  })
})

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
