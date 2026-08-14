import { describe, expect, it } from "bun:test"
import { Effect, Layer, Context } from "effect"
import { GlobalBus } from "@/bus/global"
import { ExecFailed } from "@/sandbox/exec-failed"
import { SandboxProvider } from "@/tool/sandbox-provider"
import type { SessionID } from "@/session/schema"
import type { Sandbox, WriteEntry } from "@alibaba-group/opensandbox"

/**
 * Pure-logic tests for ExecFailed.detect / summarize. No services required.
 */
describe("ExecFailed.detect", () => {
  it("returns failed when exit is non-zero and output matches an error pattern", () => {
    const result = ExecFailed.detect({
      exitCode: 1,
      status: "completed",
      stdout: "",
      stderr: "Error: cannot find module 'foo'",
    })
    expect(result.failed).toBe(true)
    expect(result.errorSummary).toContain("cannot find module")
  })

  it("returns failed on EADDRINUSE-style syscall errors", () => {
    const result = ExecFailed.detect({
      exitCode: null,
      status: "failed",
      stdout: "",
      stderr: "listen EADDRINUSE",
    })
    expect(result.failed).toBe(true)
  })

  it("does not fire on a clean zero-exit command", () => {
    expect(
      ExecFailed.detect({
        exitCode: 0,
        status: "completed",
        stdout: "all good",
        stderr: "",
      }).failed,
    ).toBe(false)
  })

  it("does not fire on non-zero exit without an error pattern (e.g. grep no-match)", () => {
    expect(
      ExecFailed.detect({
        exitCode: 1,
        status: "completed",
        stdout: "",
        stderr: "",
      }).failed,
    ).toBe(false)
  })

  it("does not fire when stderr has benign noise but exit is 0", () => {
    expect(
      ExecFailed.detect({
        exitCode: 0,
        status: "completed",
        stdout: "ok",
        stderr: "WARN deprecated",
      }).failed,
    ).toBe(false)
  })

  it("detects timeout status", () => {
    expect(
      ExecFailed.detect({
        exitCode: null,
        status: "timed_out",
        stdout: "running... Error: timeout",
        stderr: "",
      }).failed,
    ).toBe(true)
  })
})

describe("ExecFailed.summarize", () => {
  it("returns the full output when under the limit", () => {
    expect(ExecFailed.summarize("short output")).toBe("short output")
  })

  it("tails when output exceeds the limit", () => {
    const big = "x".repeat(5000)
    const out = ExecFailed.summarize(big)
    expect(out.length).toBeLessThan(big.length)
    expect(out.startsWith("...[truncated]...")).toBe(true)
    expect(out.endsWith("xxx")).toBe(true)
  })
})

/**
 * Builds an in-memory Sandbox that records written files. Used to verify the
 * full-output log landing inside the sandbox workspace.
 */
function recordingSandbox(): { sb: Sandbox; files: Map<string, string> } {
  const files = new Map<string, string>()
  const sb = {
    files: {
      createDirectories: async (entries: { path: string }[]) => {
        for (const e of entries) files.set(e.path + "/", "")
        return Promise.resolve()
      },
      writeFiles: async (entries: WriteEntry[]) => {
        for (const e of entries) files.set(e.path, typeof e.data === "string" ? e.data : "")
        return Promise.resolve()
      },
    },
  } as unknown as Sandbox
  return { sb, files }
}

/**
 * A fake SandboxProvider.Interface that always returns the same in-memory sb.
 */
function fakeProvider(sb: Sandbox): SandboxProvider.Interface {
  return {
    get: () => Effect.succeed(sb),
    getOrCreate: () => Effect.succeed(sb),
    destroy: () => Effect.void,
    destroyById: () => Effect.void,
    destroyAll: () => Effect.void,
    cleanupSessionVolume: () => Effect.void,
    keepAlive: () => Effect.void,
    touch: () => Effect.void,
    release: () => Effect.void,
    isKeepAlive: () => Effect.succeed(false),
    runInSession: () => Effect.succeed({} as any),
    runDetached: () => Effect.succeed({} as any),
    interrupt: () => Effect.void,
    register: () => Effect.void,
    getEndpoint: () => Effect.succeed("http://endpoint"),
  }
}

describe("ExecFailed.maybeTrigger", () => {
  it("writes the full output into the sandbox and publishes a global event on failure", () =>
    Effect.gen(function* () {
      const { sb, files } = recordingSandbox()
      const provider = fakeProvider(sb)

      let received: any = null
      const handler = (event: any) => {
        if (event.payload?.type === ExecFailed.EVENT_TYPE) received = event
      }
      GlobalBus.on("event", handler)

      yield* ExecFailed.maybeTrigger({
        provider,
        rootID: "ses_test_root",
        directory: "/host/work",
        execId: "exec-1",
        command: "npm run build",
        workingDirectory: "/host/work",
        exitCode: 1,
        status: "failed",
        stdout: "",
        stderr: "Error: cannot find module 'missing'",
      })

      GlobalBus.off("event", handler)

      // Event published and routed to the owning directory.
      expect(received).not.toBeNull()
      expect(received.directory).toBe("/host/work")
      const props = received.payload.properties
      expect(props.sessionID).toBe("ses_test_root")
      expect(props.command).toBe("npm run build")
      expect(props.exitCode).toBe(1)
      expect(props.hostOutputPath).toContain(".opencode/exec-logs/exec-1.log")
      expect(props.errorSummary).toContain("cannot find module")

      // Full output landed in the sandbox.
      expect(files.has(props.outputPath)).toBe(true)
      expect(files.get(props.outputPath)).toContain("## stderr")
      expect(files.get(props.outputPath)).toContain("cannot find module 'missing'")
    }).pipe(Effect.runPromise))

  it("is a no-op when the command succeeded", () =>
    Effect.gen(function* () {
      const { sb, files } = recordingSandbox()
      const provider = fakeProvider(sb)

      let fired = false
      const handler = (event: any) => {
        if (event.payload?.type === ExecFailed.EVENT_TYPE) fired = true
      }
      GlobalBus.on("event", handler)

      yield* ExecFailed.maybeTrigger({
        provider,
        rootID: "ses_test_root",
        directory: "/host/work",
        execId: "exec-2",
        command: "true",
        exitCode: 0,
        status: "completed",
        stdout: "",
        stderr: "",
      })

      GlobalBus.off("event", handler)
      expect(fired).toBe(false)
      expect(files.size).toBe(0)
    }).pipe(Effect.runPromise))

  it("still publishes when the sandbox is unreachable (no log file)", () =>
    Effect.gen(function* () {
      // Provider whose get() returns null — simulates a destroyed/unreachable sandbox.
      const provider: SandboxProvider.Interface = {
        ...fakeProvider({} as Sandbox),
        get: () => Effect.succeed(null),
      }

      let received: any = null
      const handler = (event: any) => {
        if (event.payload?.type === ExecFailed.EVENT_TYPE) received = event
      }
      GlobalBus.on("event", handler)

      yield* ExecFailed.maybeTrigger({
        provider,
        rootID: "ses_test_root",
        directory: "/host/work",
        execId: "exec-3",
        command: "exit 2",
        exitCode: 2,
        status: "failed",
        stdout: "fatal: boom",
        stderr: "",
      })

      GlobalBus.off("event", handler)
      expect(received).not.toBeNull()
      expect(received.payload.properties.outputPath).toBe("")
      // Host path is still derived from the directory even without a log file.
      expect(received.payload.properties.hostOutputPath).toContain(".opencode/exec-logs/exec-3.log")
    }).pipe(Effect.runPromise))

  it("publishes an empty outputPath when writing the log fails", () =>
    Effect.gen(function* () {
      const provider = fakeProvider({
        files: {
          createDirectories: async () => undefined,
          writeFiles: async () => {
            throw new Error("disk full")
          },
        },
      } as unknown as Sandbox)
      let received: any = null
      const handler = (event: any) => {
        if (event.payload?.type === ExecFailed.EVENT_TYPE) received = event
      }
      GlobalBus.on("event", handler)

      yield* ExecFailed.maybeTrigger({
        provider,
        rootID: "ses_test_root",
        directory: "/host/work",
        execId: "exec-4",
        command: "npm run build",
        exitCode: 1,
        status: "failed",
        stdout: "",
        stderr: "Error: disk full",
      })

      GlobalBus.off("event", handler)
      expect(received.payload.properties.outputPath).toBe("")
    }).pipe(Effect.runPromise))
})
