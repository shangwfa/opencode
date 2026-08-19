import { describe, expect, it } from "bun:test"
import { Effect, Layer, Ref, Context as EContext } from "effect"
import { GlobalBus } from "@/bus/global"
import { ExecFailed } from "@/sandbox/exec-failed"
import { SessionID } from "@/session/schema"
import { ExecRepair } from "@/sandbox/exec-repair"
import { SessionPrompt } from "@/session/prompt"
import { InstanceStore } from "@/project/instance-store"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { pollWithTimeout } from "../lib/effect"

/**
 * The exec-repair listener is now a GLOBAL layer that subscribes to GlobalBus
 * once, then per event loads the owning instance via InstanceStore.provide and
 * runs SessionPrompt.prompt inside it.
 *
 * We test the three behaviours:
 *   1. directory routing — only events with a directory the instance store can
 *      load actually call prompt,
 *   2. dedup — at most MAX_ATTEMPTS repairs per (session, command),
 *   3. wiring — it calls SessionPrompt.prompt with the failure context.
 *
 * The listener layer deps: InstanceStore.Service + SessionPrompt.Service. We
 * mock SessionPrompt (records calls) and provide a fake InstanceStore that
 * "loads" any directory into a minimal InstanceContext.
 */

const MAX_ATTEMPTS = 3

function fakeInstanceContext(directory: string): InstanceContext {
  return {
    directory,
    worktree: directory,
    project: { id: "proj_test", directory, vcs: undefined } as any,
  }
}

function publishEvent(directory: string, props: Partial<ExecFailed.Event> & { sessionID: string; command: string }) {
  ExecFailed.publish({
    sessionID: props.sessionID,
    execId: props.execId ?? "exec-x",
    command: props.command,
    ...(props.workingDirectory ? { workingDirectory: props.workingDirectory } : {}),
    directory,
    exitCode: props.exitCode ?? 1,
    status: props.status ?? "failed",
    outputPath: props.outputPath ?? "/workspace/.opencode/exec-logs/exec-x.log",
    hostOutputPath: props.hostOutputPath ?? "/host/.opencode/exec-logs/exec-x.log",
    errorSummary: props.errorSummary ?? "Error: boom",
  })
}

/**
 * Builds a test layer from the real ExecRepair.layer, providing a mock
 * SessionPrompt (records prompt texts) and a fake InstanceStore whose
 * `provide` runs the effect with an InstanceRef bound to the requested
 * directory.
 */
function listenerTestLayer(onPrompt: (text: string) => Effect.Effect<void>) {
  const mockPrompt = Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      prompt: (input: any) => {
        const text = input.parts.find((p: any) => p.type === "text")?.text ?? ""
        return onPrompt(text).pipe(Effect.as({} as any))
      },
    } as any),
  )

  const fakeStore = Layer.succeed(
    InstanceStore.Service,
    InstanceStore.Service.of({
      provide:
        (input: any, effect: any) =>
        Effect.gen(function* () {
          const ctx = fakeInstanceContext(input.directory)
          return yield* effect.pipe(Effect.provideService(InstanceRef, ctx))
        }),
      // The rest are unused by the listener; throw if accidentally called.
    } as any),
  )

  return ExecRepair.layer.pipe(Layer.provide(mockPrompt), Layer.provide(fakeStore))
}

describe("ExecRepair listener", () => {
  it("fires SessionPrompt.prompt for an event and rate-limits repeats", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([])

      yield* Layer.build(listenerTestLayer((text) => Ref.update(calls, (xs) => [...xs, text])))
      yield* Effect.yieldNow

      const sessionID = SessionID.make("ses_repair_1")
      const command = "npm run build"

      for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
        publishEvent("/host/mywork", { sessionID, command })
        yield* Effect.yieldNow
      }

      const fired = yield* pollWithTimeout(
        Ref.get(calls).pipe(Effect.map((items) => items.length === MAX_ATTEMPTS ? items : undefined)),
        "repair prompts were not admitted",
      )
      expect(fired.length).toBe(MAX_ATTEMPTS)
      expect(fired[0]).toContain(command)
      expect(fired[0]).toContain("full output saved to: /workspace/.opencode/exec-logs/exec-x.log")
      expect(fired[0]).toContain("package.json exists")
      expect(fired[0]).toContain("failure summary: Error: boom")
      expect(fired[0]).toContain("background: true")
    }).pipe(Effect.scoped, Effect.runPromise))

  it("different commands get independent attempt budgets", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make(0)

      yield* Layer.build(listenerTestLayer(() => Ref.update(calls, (n) => n + 1)))
      yield* Effect.yieldNow

      // Two distinct commands; each can fire up to MAX_ATTEMPTS.
      const sessionID = SessionID.make("ses_multi")
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        publishEvent("/host/w", { sessionID, command: "cmd-a" })
        yield* Effect.yieldNow
      }
      publishEvent("/host/w", { sessionID, command: "cmd-b" })
      yield* Effect.yieldNow

      // cmd-a exhausted (3), cmd-b fires once (1) → 4 total.
      const count = yield* pollWithTimeout(
        Ref.get(calls).pipe(Effect.map((value) => value === MAX_ATTEMPTS + 1 ? value : undefined)),
        "independent repair prompts were not admitted",
      )
      expect(count).toBe(MAX_ATTEMPTS + 1)
    }).pipe(Effect.scoped, Effect.runPromise))

  it("includes the failure summary when no sandbox log is available", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<string[]>([])
      yield* Layer.build(listenerTestLayer((text) => Ref.update(calls, (xs) => [...xs, text])))
      yield* Effect.yieldNow

      publishEvent("/host/unavailable", {
        sessionID: SessionID.make("ses_unavailable"),
        command: "npm run build",
        outputPath: "",
        hostOutputPath: "/host/unavailable/.opencode/exec-logs/exec-x.log",
        errorSummary: "Error: sandbox is unavailable",
      })
      const prompt = yield* pollWithTimeout(
        Ref.get(calls).pipe(Effect.map((items) => items[0])),
        "repair prompt was not admitted",
      )
      expect(prompt).toContain("package.json exists")
      expect(prompt).toContain("Error: sandbox is unavailable")
      expect(prompt).not.toContain("full output saved to")
    }).pipe(Effect.scoped, Effect.runPromise))
})
