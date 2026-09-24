import { describe, expect } from "bun:test"
import { Effect, Exit, Layer, Cause } from "effect"
import { write } from "@opencode/core/sandbox/tools"
import type { SandboxProvider } from "@opencode/core/sandbox/provider"
import { Permission } from "@opencode/core/permission"
import { Location } from "@opencode/core/location"
import { testEffect } from "./lib/effect"

const location = { directory: "/workspace" } as unknown as Location.Interface

type Files = Map<string, string>

const makeDeps = (files: Files) => {
  const writes: Array<[string, string]> = []
  const asserts: unknown[] = []
  const provider = {
    enabled: true,
    fileStat: (_sessionID: string, path: string) => Effect.succeed(files.has(path) ? { isDirectory: false } : null),
    fileRead: (_sessionID: string, path: string) => Effect.succeed(files.has(path) ? files.get(path)! : null),
    fileWrite: (_sessionID: string, path: string, data: string) =>
      Effect.sync(() => {
        writes.push([path, data])
        files.set(path, data)
      }),
    run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }),
  } as unknown as SandboxProvider.Interface
  const permission = {
    assert: (input: unknown) => Effect.sync(() => asserts.push(input)),
  } as unknown as Permission.Interface
  return { deps: { provider, location, permission }, writes, asserts }
}

const context = (sessionID: string) =>
  ({ sessionID, messageID: "msg_test", id: "call_test", agent: "build" }) as never

const diffs: Array<{ resource: string; before: string; after: string; change: string }> = []
const fileDiff = (resource: string, before: string, after: string, change: "added" | "modified") => {
  const entry = { resource, before, after, change }
  diffs.push(entry)
  return entry
}

const it = testEffect(Layer.empty)

describe("SandboxTools.write", () => {
  it.effect("reports existed=true for an empty existing file (stat semantics)", () =>
    Effect.gen(function* () {
      const files = new Map([["/workspace/empty.txt", ""]]) as Files
      const { deps, writes, asserts } = makeDeps(files)
      const result = yield* write(
        deps,
        { path: "empty.txt", content: "filled" },
        context("ses_sb_write_empty"),
        fileDiff,
      )
      // The V1 bug derived existence from `!!content` and misreported empty
      // files as new; stat-based semantics must keep existed=true here.
      expect(result).toMatchObject({ operation: "write", existed: true, resource: "empty.txt" })
      expect(writes).toEqual([["/workspace/empty.txt", "filled"]])
      expect(asserts).toHaveLength(1)
      expect(diffs.at(-1)).toMatchObject({ resource: "empty.txt", before: "", after: "filled", change: "modified" })
    }),
  )

  it.effect("reports existed=false for a missing file and diffs as added", () =>
    Effect.gen(function* () {
      const { deps, writes } = makeDeps(new Map())
      const result = yield* write(
        deps,
        { path: "new.txt", content: "created" },
        context("ses_sb_write_new"),
        fileDiff,
      )
      expect(result).toMatchObject({ existed: false, resource: "new.txt" })
      expect(writes).toEqual([["/workspace/new.txt", "created"]])
      expect(diffs.at(-1)).toMatchObject({ before: "", change: "added" })
    }),
  )

  it.effect("propagates non-404 stat failures without writing", () =>
    Effect.gen(function* () {
      const provider = {
        enabled: true,
        fileStat: () => Effect.fail(new Error("getFileInfo failed: connection reset")),
        fileRead: () => Effect.succeed(null),
        fileWrite: () => Effect.sync(() => {
          throw new Error("must not write")
        }),
        run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }),
      } as unknown as SandboxProvider.Interface
      const deps = { provider, location, permission: { assert: () => Effect.void } as unknown as Permission.Interface }
      const exit = yield* Effect.exit(
        write(deps, { path: "any.txt", content: "x" }, context("ses_sb_write_err"), fileDiff),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        const message = Cause.prettyErrors(exit.cause).map((error) => error.message).join("\n")
        expect(message).toContain("getFileInfo failed")
      }
    }),
  )
})
