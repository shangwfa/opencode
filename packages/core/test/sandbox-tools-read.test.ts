import { describe, expect, it } from "bun:test"
import { Effect, Exit } from "effect"
import { read } from "@opencode/core/sandbox/tools"
import type { SandboxProvider } from "@opencode/core/sandbox/provider"
import { Permission } from "@opencode/core/permission"
import { Location } from "@opencode/core/location"

const location = { directory: "/workspace" } as unknown as Location.Interface
const context = {
  sessionID: "ses_read_test",
  messageID: "msg_read_test",
  id: "call_read_test",
  agent: "build",
} as never

describe("SandboxTools.read", () => {
  it("reads V1-layout resources only under the resolved resource owner and still checks read permission", async () => {
    const accessed: string[] = []
    const target = "/home/sandbox/.local/share/opencode/session-skills/ses_owner/demo/snapshot/scripts/run.sh"
    let denied = false
    const deps = {
      location,
      skillResourceRoot: "/home/sandbox/.local/share/opencode/session-skills/ses_owner",
      provider: {
        fileStat: (_session: string, file: string) =>
          Effect.sync(() => {
            accessed.push(file)
            return { isDirectory: false }
          }),
        fileReadBytes: () => Effect.succeed(Buffer.from("echo OK")),
        fileRead: () => Effect.succeed("echo OK"),
      } as unknown as SandboxProvider.Interface,
      permission: {
        assert: () => (denied ? Effect.fail(new Error("permission denied")) : Effect.void),
      } as unknown as Permission.Interface,
    }
    expect(await Effect.runPromise(read(deps, { path: target }, context))).toMatchObject({
      type: "text-page",
      content: "echo OK",
    })
    expect(accessed).toEqual([target])
    accessed.length = 0
    denied = true
    expect(Exit.isFailure(await Effect.runPromise(Effect.exit(read(deps, { path: target }, context))))).toBe(true)
    denied = false
    for (const file of [
      target.replace("ses_owner/", "ses_other/"),
      target.replace("ses_owner/", "ses_owner-suffix/"),
      "/home/sandbox/.local/share/opencode/session-skills/ses_owner/../../secret.txt",
      "/home/sandbox/secret.txt",
    ]) {
      expect(Exit.isFailure(await Effect.runPromise(Effect.exit(read(deps, { path: file }, context))))).toBe(true)
    }
    expect(accessed).toEqual([])
  })
  it("checks the relative resource permission before reading sandbox files", async () => {
    const order: string[] = []
    const calls: unknown[] = []
    const deps = {
      location,
      provider: {
        fileStat: (_sessionID: string, path: string) =>
          Effect.sync(() => {
            order.push("stat")
            expect(path).toBe("/workspace/private.txt")
            return { isDirectory: false }
          }),
        fileReadBytes: () => Effect.succeed(Buffer.from("secret")),
        fileRead: () =>
          Effect.sync(() => {
            order.push("read")
            return "secret"
          }),
      } as unknown as SandboxProvider.Interface,
      permission: {
        assert: (input: unknown) =>
          Effect.sync(() => {
            order.push("permission")
            calls.push(input)
          }),
      } as unknown as Permission.Interface,
    }

    const output = await Effect.runPromise(read(deps, { path: "private.txt" }, context))
    expect(output).toMatchObject({ type: "text-page", content: "secret" })
    expect(order).toEqual(["permission", "stat", "read"])
    expect(calls[0]).toMatchObject({
      action: "read",
      resources: ["private.txt"],
      save: ["*"],
      sessionID: "ses_read_test",
      agent: "build",
      source: { type: "tool", messageID: "msg_read_test", id: "call_read_test" },
    })
  })

  it("does not stat or read a file when permission is denied", async () => {
    const accessed: string[] = []
    const deps = {
      location,
      provider: {
        fileStat: () => Effect.sync(() => accessed.push("stat")),
        fileReadBytes: () => Effect.succeed(Buffer.from("secret")),
        fileRead: () => Effect.sync(() => accessed.push("read")),
      } as unknown as SandboxProvider.Interface,
      permission: {
        assert: () => Effect.fail(new Error("permission denied")),
      } as unknown as Permission.Interface,
    }

    const exit = await Effect.runPromise(Effect.exit(read(deps, { path: "private.txt" }, context)))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(accessed).toEqual([])
  })
})
