import { execFileSync } from "node:child_process"
import path from "node:path"
import { afterAll, beforeEach, describe, expect } from "bun:test"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Database } from "@opencode/core/database/database"
import type { FilesImpl } from "@opencode/core/environment/files"
import { Workspace } from "@opencode/core/workspace"
import { WorkspaceDriver } from "@opencode/core/workspace/driver"
import { WorkspaceDocker } from "@opencode/core/workspace/docker"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { testEffect } from "./lib/effect"

// Real docker integration; skipped when the daemon is unreachable.
const dockerAvailable = (() => {
  try {
    execFileSync("docker", ["version", "--format", "1"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

describe.skipIf(!dockerAvailable)("workspace docker driver", () => {
  const it = testEffect(
    AppNodeBuilder.build(
      LayerNode.group([
        Database.node,
        WorkspaceDriver.node,
        Workspace.configured({ idleThreshold: "5 minutes", pollInterval: "1 minute" }),
      ]),
      [
        WorkspaceDriver.node.replace(
          WorkspaceDocker.registryNode("docker", {
            image: "node:24-slim",
            installAgent: path.join(import.meta.dir, "../../containers/sandbox/fs-agent.mjs"),
          }),
        ),
      ],
    ),
  )

  // Leak guard: everything created here uses the deterministic opencode-ws- prefix.
  afterAll(() => {
    try {
      const stale = execFileSync("docker", ["ps", "-aq", "--filter", "name=opencode-ws-"], { encoding: "utf8" })
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
      for (const id of stale) execFileSync("docker", ["rm", "-f", "-v", id], { stdio: "ignore" })
    } catch {
      // best-effort cleanup only
    }
  })

  let workspaceID: Workspace.ID
  beforeEach(() => {
    workspaceID = Workspace.ID.create()
  })

  const containerOf = (id: Workspace.ID) => `opencode-ws-${id}`
  const containerState = (container: string) =>
    execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", container], { encoding: "utf8" }).trim()

  it.live(
    "creates, provisions, connects and destroys a workspace",
    () =>
      Effect.gen(function* () {
        const workspace = yield* Workspace.Service
        const id = yield* workspace.create({ provider: "docker" })

        const info = yield* workspace.provision(id)
        expect(info.binding.containerName).toBe(containerOf(id))
        expect(containerState(containerOf(id))).toBe("true")

        const driver = yield* workspace.connect(id)
        const handle = yield* driver.spawner.spawn(
          ChildProcess.make("sh", ["-c", "echo -n sandbox-ok > /tmp/opencode-probe.txt"], {}),
        )
        expect(Number(yield* handle.exitCode)).toBe(0)

        const result = yield* workspace.destroy(id)
        expect(result.destroyed).toBe(true)
        expect(() => containerState(containerOf(id))).toThrow()
      }),
    120_000,
  )

  it.live(
    "create is idempotent per workspace id",
    () =>
      Effect.gen(function* () {
        const registry = yield* WorkspaceDriver.RegistryService
        const driver = yield* registry.get("docker")
        const first = yield* driver.create({ workspaceID })
        const second = yield* driver.create({ workspaceID })
        expect(second.binding.containerName).toBe(first.binding.containerName)
        const listed = execFileSync(
          "docker",
          ["ps", "-aq", "--filter", `label=dev.opencode.workspace=${workspaceID}`],
          { encoding: "utf8" },
        )
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
        expect(listed).toHaveLength(1)
        yield* driver.destroy({ workspaceID, binding: second.binding })
      }),
    120_000,
  )

  it.live(
    "files overrides round-trip inside the container",
    () =>
      Effect.gen(function* () {
        const registry = yield* WorkspaceDriver.RegistryService
        const driver = yield* registry.get("docker")
        const created = yield* driver.create({ workspaceID })
        const connected = yield* Effect.scoped(
          driver.connect({ workspaceID, binding: created.binding, saveBinding: () => Effect.void }),
        )
        const files = connected.overrides
        if (files === undefined || files.write === undefined) throw new Error("docker driver did not ship files overrides")
        // The docker driver always builds the full FilesImpl set; the Driver type models overrides as partial.
        const fs = files as FilesImpl

        yield* fs.write("/tmp/probe/hello.txt", new TextEncoder().encode("hi sandbox"))
        const info = yield* fs.stat("/tmp/probe/hello.txt")
        expect(info.type).toBe("file")
        expect(info.size).toBe(10)

        const read = yield* fs.read("/tmp/probe/hello.txt")
        expect(new TextDecoder().decode(read.bytes)).toBe("hi sandbox")

        const ranged = yield* fs.read("/tmp/probe/hello.txt", { offset: 3, length: 4 })
        expect(new TextDecoder().decode(ranged.bytes)).toBe("sand")

        const entries = yield* fs.list("/tmp/probe")
        expect(entries.map((entry) => entry.name)).toContain("hello.txt")

        yield* fs.move("/tmp/probe/hello.txt", "/tmp/probe/renamed.txt")
        expect((yield* fs.stat("/tmp/probe/renamed.txt")).size).toBe(10)
        const missing = yield* fs.stat("/tmp/probe/hello.txt").pipe(Effect.flip)
        expect(missing._tag).toBe("Environment.NotFound")

        yield* fs.mkdir("/tmp/probe/dir")
        yield* fs.remove("/tmp/probe")
        const gone = yield* fs.stat("/tmp/probe/renamed.txt").pipe(Effect.flip)
        expect(gone._tag).toBe("Environment.NotFound")

        yield* driver.destroy({ workspaceID, binding: created.binding })
      }),
    120_000,
  )

  it.live(
    "suspendForIdle stops the container and connect revives it",
    () =>
      Effect.gen(function* () {
        const registry = yield* WorkspaceDriver.RegistryService
        const driver = yield* registry.get("docker")
        const created = yield* driver.create({ workspaceID })
        const container = String(created.binding.containerName)

        let saved = created.binding
        const persist = (binding: WorkspaceDriver.Binding) => Effect.sync(() => (saved = binding))
        yield* driver.suspendForIdle({ workspaceID, binding: created.binding, saveBinding: persist })
        expect(containerState(container)).toBe("false")
        expect(saved.suspended).toBe(true)

        const revived = yield* Effect.scoped(driver.connect({ workspaceID, binding: saved, saveBinding: persist }))
        expect(containerState(container)).toBe("true")
        expect(saved.suspended).not.toBe(true)
        const handle = yield* revived.spawner.spawn(ChildProcess.make("echo", ["revived"], {}))
        expect(Number(yield* handle.exitCode)).toBe(0)

        yield* driver.destroy({ workspaceID, binding: saved })
      }),
    120_000,
  )
})
