import { beforeEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import type { FilesImpl } from "@opencode/core/environment/files"
import { Workspace } from "@opencode/core/workspace"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { SandboxOpenSandbox } from "@opencode/sandbox/opensandbox"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"

// Real OpenSandbox server integration; skipped unless a domain is configured
// (env names match the v1 sandbox fleet flags).
const domain = process.env["OPENCODE_SANDBOX_DOMAIN"]
const serverAvailable = domain !== undefined && domain.length > 0

const options: SandboxOpenSandbox.Options = {
  domain: domain ?? "localhost:8080",
  protocol: (process.env["OPENCODE_SANDBOX_PROTOCOL"] as "https" | "http" | undefined) ?? "http",
  ...(process.env["OPENCODE_SANDBOX_API_KEY"] === undefined
    ? {}
    : { apiKey: process.env["OPENCODE_SANDBOX_API_KEY"] }),
  ...(process.env["OPENCODE_SANDBOX_IMAGE"] === undefined
    ? {}
    : { image: process.env["OPENCODE_SANDBOX_IMAGE"] }),
  snapshotWaitMs: 120_000,
}

describe.skipIf(!serverAvailable)("opensandbox workspace driver", () => {
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        WorkspaceDriver.node,
        Workspace.configured({ idleThreshold: "5 minutes", pollInterval: "1 minute" }),
      ]),
      [WorkspaceDriver.node.replace(SandboxOpenSandbox.registryNode("opensandbox", options))],
    ),
  )

  let workspaceID: Workspace.ID
  beforeEach(() => {
    workspaceID = Workspace.ID.create()
  })

  it.live(
    "creates, connects and destroys a workspace",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Service
        const id = yield* workspace.create({ provider: "opensandbox" })

        const info = yield* workspace.provision(id)
        expect(typeof info.binding.sandboxId).toBe("string")

        const driver = yield* workspace.connect(id)
        const files = driver.overrides
        if (files === undefined || files.write === undefined) throw new Error("no files overrides")
        const fs = files as FilesImpl

        yield* fs.write("/tmp/opencode-probe.txt", new TextEncoder().encode("sandbox-ok"))
        const read = yield* fs.read("/tmp/opencode-probe.txt")
        expect(new TextDecoder().decode(read.bytes)).toBe("sandbox-ok")

        const result = yield* workspace.destroy(id)
        expect(result.destroyed).toBe(true)
      }),
    300_000,
  )

  it.live(
    "suspendForIdle snapshots to Ready before killing, and connect restores from it",
    () =>
      Effect.gen(function* () {
        const registry = yield* WorkspaceDriver.RegistryService
        const driver = yield* registry.get("opensandbox")
        const created = yield* driver.create({ workspaceID })
        const sandboxId = String(created.binding.sandboxId)

        yield* Effect.scoped(
          driver.connect({ workspaceID, binding: created.binding, saveBinding: () => Effect.void }),
        ).pipe(
          Effect.flatMap((connected) => {
            const fs = connected.overrides as FilesImpl
            return fs.write("/tmp/keep-me.txt", new TextEncoder().encode("survives suspension"))
          }),
        )

        let saved = created.binding
        const persist = (binding: WorkspaceDriver.Binding) => Effect.sync(() => (saved = binding))
        yield* driver.suspendForIdle({ workspaceID, binding: created.binding, saveBinding: persist })
        expect(typeof saved.snapshotId).toBe("string")

        // The source sandbox only dies after the snapshot is Ready (v1 invariant).
        const killed = yield* Effect.promise(() =>
          SandboxOpenSandbox.isSandboxGone(options, sandboxId),
        )
        expect(killed).toBe(true)

        const revived = yield* Effect.scoped(
          driver.connect({ workspaceID, binding: saved, saveBinding: persist }),
        )
        const fs = revived.overrides as FilesImpl
        const read = yield* fs.read("/tmp/keep-me.txt")
        expect(new TextDecoder().decode(read.bytes)).toBe("survives suspension")

        yield* driver.destroy({ workspaceID, binding: saved })
      }),
    600_000,
  )

  it.live(
    "create restores from the newest Ready snapshot when the sandbox is gone",
    () =>
      Effect.gen(function* () {
        const registry = yield* WorkspaceDriver.RegistryService
        const driver = yield* registry.get("opensandbox")
        const first = yield* driver.create({ workspaceID })
        yield* Effect.scoped(
          driver.connect({ workspaceID, binding: first.binding, saveBinding: () => Effect.void }),
        ).pipe(
          Effect.flatMap((connected) => {
            const fs = connected.overrides as FilesImpl
            return fs.write("/tmp/restore-me.txt", new TextEncoder().encode("restored from snapshot"))
          }),
        )

        let saved = first.binding
        yield* driver.suspendForIdle({
          workspaceID,
          binding: first.binding,
          saveBinding: (b) => Effect.sync(() => (saved = b)),
        })

        // No binding and no live sandbox: create must fall back to the Ready snapshot.
        const recreated = yield* driver.create({ workspaceID })
        expect(String(recreated.binding.sandboxId)).not.toBe(String(first.binding.sandboxId))

        const connected = yield* Effect.scoped(
          driver.connect({ workspaceID, binding: recreated.binding, saveBinding: () => Effect.void }),
        )
        const fs = connected.overrides as FilesImpl
        const read = yield* fs.read("/tmp/restore-me.txt")
        expect(new TextDecoder().decode(read.bytes)).toBe("restored from snapshot")

        yield* driver.destroy({ workspaceID, binding: recreated.binding })
      }),
    600_000,
  )
})
