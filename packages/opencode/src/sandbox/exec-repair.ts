export * as ExecRepair from "./exec-repair"

import { Effect, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import { InstanceStore } from "@/project/instance-store"
import { EffectBridge } from "@/effect/bridge"
import { SessionPrompt } from "@/session/prompt"
import { SessionID } from "@/session/schema"
import { ExecFailed } from "@/sandbox/exec-failed"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { withSessionLock } from "@/server/routes/instance/httpapi/handlers/session-lock"
import { BusBridge } from "@/bus/bus-bridge"

/**
 * Maximum self-repair attempts for the same (session, command) before giving up.
 * Prevents infinite repair loops when a command is fundamentally broken.
 */
const MAX_ATTEMPTS = 3

/**
 * Global listener that turns sandbox exec failures into a self-repair prompt
 * for the main session agent. It subscribes to the global bus once at startup,
 * and per event: loads the owning instance by directory, enters its context via
 * InstanceStore.provide, and admits a synthetic user message asking the agent to
 * analyze the saved output, fix the code, and retry.
 *
 * The agent retries on its own (via its bash/shell tool, which re-enters the
 * sandbox exec path); the listener only admits the initial repair message and
 * rate-limits repeats per (session, command).
 *
 * Registered globally (not per-instance) so it survives without an active
 * instance and routes each event to its owning directory on demand.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const store = yield* InstanceStore.Service
    const promptSvc = yield* SessionPrompt.Service
    const bridge = yield* EffectBridge.make()

    // Dedup state: (sessionID + normalized command) -> attempts. In-memory only;
    // a process restart resets the budget, which is acceptable for a repair hint.
    const attempts = new Map<string, number>()
    const key = (sessionID: string, command: string) => `${sessionID}\0${command}`

    const handler = (event: GlobalEvent) => {
      // The owner Pod already handles this failure. Replayed bridge events
      // must not enqueue one repair prompt per replica.
      if (BusBridge.isRemoteEvent(event)) return
      const payload = event.payload
      if (!payload || payload.type !== ExecFailed.EVENT_TYPE) return
      const props = payload.properties as ExecFailed.Event
      const directory = event.directory ?? ""

      const k = key(props.sessionID, props.command)
      const count = attempts.get(k) ?? 0
      if (count >= MAX_ATTEMPTS) return
      attempts.set(k, count + 1)

      const remaining = MAX_ATTEMPTS - (count + 1)
      // Extract the project directory from the command (first `cd <dir>` segment).
      const cdMatch = props.command.match(/\bcd\s+(\S+)/)
      const projectDir = cdMatch ? `/workspace/${cdMatch[1].replace(/^["']|["']$/g, "")}` : "/workspace"
      const lines = [
        `A sandbox command failed in /workspace. Follow these steps:`,
        ``,
        `1. Check if ${projectDir}/package.json exists with: ls ${projectDir}/package.json`,
        `   - If it exists: the project is already set up. Only fix the specific bug, do NOT recreate it.`,
        `   - If it does NOT exist: the project needs to be created from scratch.`,
        `2. Fix the bug in ${projectDir}. The failure summary above contains the error.`,
        `3. Re-run: cd ${projectDir.replace("/workspace/", "")} && npm run dev -- --host 0.0.0.0 --port 5173`,
        `   Use background: true for dev servers, and set workdir to ${projectDir}.`,
        ``,
        `Command that failed:`,
        `- command: \`${props.command}\``,
        `- exit code: ${props.exitCode}`,
        `- failure summary: ${props.errorSummary}`,
        ...(props.outputPath ? [`- full output saved to: ${props.outputPath}`] : []),
        ...(remaining > 0 ? [`- repair attempts remaining for this command: ${remaining}`] : []),
      ].join("\n")

      // Load the owning instance and run the prompt inside its context.
      // Fire-and-forget via the bridge; never blocks EventEmitter dispatch.
      bridge.fork(
        store
          .provide(
            { directory },
            withSessionLock(
              SessionID.make(props.sessionID),
              promptSvc.prompt({
                sessionID: SessionID.make(props.sessionID),
                parts: [{ type: "text", text: lines, synthetic: true }],
              }),
            ),
          )
          .pipe(
            Effect.catch(() =>
              Effect.sync(() => {
                const current = attempts.get(k) ?? 0
                if (current <= 1) attempts.delete(k)
                else attempts.set(k, current - 1)
              }),
            ),
          ),
      )
    }

    GlobalBus.on("event", handler)
    yield* Effect.addFinalizer(() => Effect.sync(() => GlobalBus.off("event", handler)))
  }),
)

export const node = makeGlobalNode({
  name: "exec-repair",
  layer,
  deps: [InstanceStore.node, SessionPrompt.node, SandboxProvider.node],
})
