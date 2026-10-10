import { expect } from "bun:test"
import fs from "node:fs/promises"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Effect, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { SandboxWorkspace } from "../src/sandbox/workspace"
import { testEffect } from "./lib/effect"
import { tmpdirScoped } from "./fixture/tmpdir"

const it = testEffect(Layer.empty)

it.effect("successful probe checks write/read/remove before admission", () =>
  Effect.gen(function* () {
    let command = ""
    yield* SandboxWorkspace.ensureWritable(
      {
        commands: {
          run: async (value) => {
            command = value
            return { exitCode: 0 }
          },
        },
      },
      true,
    )
    expect(command).toContain("mkdir -p /workspace")
    expect(command).toContain("printf WORKSPACE_READY")
    expect(command).toContain('cat "$probe"')
    expect(command).toContain('rm -f "$probe"')
    expect(command).not.toContain("rm -rf")
  }),
)

for (const result of [{ exitCode: 1 }, { exitCode: null }, {}, { exitCode: 0, error: new Error("remote failure") }]) {
  it.effect(`probe fails closed for ${JSON.stringify(result)}`, () =>
    Effect.gen(function* () {
      expect(
        yield* SandboxWorkspace.ensureWritable({ commands: { run: async () => result } }, false).pipe(Effect.isFailure),
      ).toBe(true)
    }),
  )
}

it.effect("restored or mounted workspaces are never recreated", () =>
  Effect.gen(function* () {
    let command = ""
    yield* SandboxWorkspace.ensureWritable(
      {
        commands: {
          run: async (value) => {
            command = value
            return { exitCode: 0 }
          },
        },
      },
      false,
    )
    expect(command).not.toContain("mkdir")
  }),
)

it.live("transport failures remain readiness failures after bounded retries", () =>
  Effect.gen(function* () {
    let attempts = 0
    const result = yield* SandboxWorkspace.ensureWritable(
      {
        commands: {
          run: async () => {
            attempts++
            throw new Error("connection refused")
          },
        },
      },
      false,
    ).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    expect(attempts).toBe(8)
  }),
)

it.live("retries transient command transport failure before admitting a ready workspace", () =>
  Effect.gen(function* () {
    let attempts = 0
    yield* SandboxWorkspace.ensureWritable(
      {
        commands: {
          run: async () => {
            attempts++
            if (attempts < 3) throw new Error("command session is not ready")
            return { exitCode: 0 }
          },
        },
      },
      false,
    )
    expect(attempts).toBe(3)
  }),
)

it.effect("readiness has a bounded wait", () =>
  Effect.gen(function* () {
    const fiber = yield* SandboxWorkspace.ensureWritable(
      { commands: { run: () => new Promise(() => {}) } },
      false,
    ).pipe(Effect.isFailure, Effect.forkScoped)
    yield* TestClock.adjust("16 seconds")
    expect(yield* Fiber.join(fiber)).toBe(true)
  }),
)

it.live("the real probe preserves existing files and removes its temporary file", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const workspace = `${tmp.path}/workspace`
    yield* Effect.promise(() => fs.mkdir(workspace))
    yield* Effect.promise(() => fs.writeFile(`${workspace}/user.txt`, "KEEP"))
    yield* SandboxWorkspace.ensureWritable(
      {
        commands: {
          run: async (command) => {
            await promisify(execFile)("sh", ["-c", command.replaceAll("/workspace", workspace)])
            return { exitCode: 0 }
          },
        },
      },
      false,
    )
    expect(yield* Effect.promise(() => fs.readdir(workspace))).toEqual(["user.txt"])
    expect(yield* Effect.promise(() => fs.readFile(`${workspace}/user.txt`, "utf8"))).toBe("KEEP")
  }),
)

it.live("a missing restored workspace fails without recreating it", () =>
  Effect.gen(function* () {
    const tmp = yield* tmpdirScoped()
    const workspace = `${tmp.path}/missing-workspace`
    const result = yield* SandboxWorkspace.ensureWritable(
      {
        commands: {
          run: async (command) => {
            await promisify(execFile)("sh", ["-c", command.replaceAll("/workspace", workspace)])
            return { exitCode: 0 }
          },
        },
      },
      false,
    ).pipe(Effect.result)
    expect(result._tag).toBe("Failure")
    expect(
      yield* Effect.promise(() =>
        fs.stat(workspace).then(
          () => true,
          () => false,
        ),
      ),
    ).toBe(false)
  }),
)
