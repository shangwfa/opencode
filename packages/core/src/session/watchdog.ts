export * as SessionWatchdog from "./watchdog.js"

import { Context, DateTime, Duration, Effect, Layer, Schedule } from "effect"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionExecution } from "./execution.js"
import { SessionMessage } from "./message.js"
import { SessionStore } from "./store.js"

/**
 * Watchdog for stuck tool executions (V1 `session/watchdog.ts` parity).
 *
 * A tool fiber that hangs (sandbox HTTP call that never returns, a plugin
 * that ignores interruption) leaves its tool part `running` forever and pins
 * the session turn. This service periodically inspects the tool parts of
 * *actively executing* sessions and interrupts the execution once a running
 * tool exceeds the timeout budget:
 *
 * - Interruption is the whole remedy: the runner's settlement path
 *   (`failUnsettledTools`) publishes `session.tool.failed` for every
 *   unsettled tool inside an uninterruptible mask, and message projection
 *   only applies `failed` while the part is still `running`/`streaming` —
 *   projection itself is the compare-and-set that V1 implemented by hand.
 * - The execution fiber's interrupt propagates to the sandbox command layer
 *   (`onInterrupt` aborts the controller), releasing remote work.
 * - Orphaned parts from a dead process are not handled here: restart
 *   recovery (`SessionRestart.resumeSuspendedSessions`) re-drains suspended
 *   sessions and the drain-start `settleStaleToolCalls` sweep settles them.
 *
 * Long-running legitimate tools (subagent sessions) are exempted by name and
 * can be configured through `OPENCODE_WATCHDOG_EXEMPT_TOOLS`.
 */

export interface Config {
  /** Running-tool age budget before the execution is interrupted. */
  readonly timeoutMs: number
  readonly scanInterval: Duration.Duration
  readonly initialDelay: Duration.Duration
  /** Tool names exempt from the budget (legitimate long-runners). */
  readonly exemptTools: ReadonlySet<string>
}

const DEFAULT_TIMEOUT_SECONDS = 120
const DEFAULT_SCAN_INTERVAL_SECONDS = 60
const DEFAULT_EXEMPT_TOOLS = ["subagent", "task", "question"]

const positiveNumber = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  return {
    timeoutMs: positiveNumber(env["OPENCODE_WATCHDOG_TIMEOUT_SEC"], DEFAULT_TIMEOUT_SECONDS) * 1000,
    scanInterval: Duration.seconds(
      positiveNumber(env["OPENCODE_WATCHDOG_SCAN_INTERVAL_SEC"], DEFAULT_SCAN_INTERVAL_SECONDS),
    ),
    initialDelay: Duration.seconds(10),
    exemptTools: new Set(
      (env["OPENCODE_WATCHDOG_EXEMPT_TOOLS"] ?? DEFAULT_EXEMPT_TOOLS.join(","))
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  }
}

export interface Interface {
  /** False when disabled via `OPENCODE_WATCHDOG_TIMEOUT_SEC=0`. */
  readonly enabled: boolean
  /** Runs one scan cycle; also the integration-test entry point. */
  readonly scanOnce: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionWatchdog") {}

/** Tool parts still `running` past the budget for one active session. */
const expiredTools = (messages: ReadonlyArray<SessionMessage.Info>, config: Config, now: number) => {
  const expired = new Map<string, string>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const tool of message.content) {
      if (tool.type !== "tool") continue
      if (tool.state.status !== "running") continue
      if (config.exemptTools.has(tool.name)) continue
      const ran = tool.time.ran
      if (ran === undefined) continue
      if (now - DateTime.toEpochMillis(ran) < config.timeoutMs) continue
      expired.set(tool.id, tool.name)
    }
  }
  return expired
}

const scan = Effect.fn("SessionWatchdog.scan")(function* (input: {
  readonly config: Config
  readonly execution: SessionExecution.Interface
  readonly store: SessionStore.Interface
}) {
  const { config, execution, store } = input
  const startedAt = Date.now()
  const active = yield* execution.active
  let stuck = 0
  let interrupted = 0
  yield* Effect.forEach(
    active,
    (sessionID) =>
      Effect.gen(function* () {
        const messages = yield* store.context(sessionID).pipe(
          // A decode failure on one session must never abort the sweep.
          Effect.catchCause((cause) =>
            Effect.logError("watchdog context read failed", { sessionID, cause: String(cause) }).pipe(
              Effect.as([] as ReadonlyArray<SessionMessage.Info>),
            ),
          ),
        )
        const expired = expiredTools(messages, config, startedAt)
        if (expired.size === 0) return
        stuck += expired.size
        yield* Effect.logWarning("watchdog stuck tools detected", {
          sessionID,
          tools: [...expired.values()],
          timeoutMs: config.timeoutMs,
        })
        // Interrupting the execution settles every unsettled tool through the
        // runner's cleanup; projection is idempotent for already-settled parts.
        const accepted = yield* execution
          .interrupt(sessionID, { reason: "watchdog" })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logError("watchdog interrupt failed", { sessionID, cause: String(cause) }).pipe(Effect.as(false)),
            ),
          )
        if (accepted) interrupted++
      }).pipe(
        Effect.catchCause((cause) => Effect.logError("watchdog candidate failed", { sessionID, cause: String(cause) })),
      ),
    { concurrency: 4, discard: true },
  )
  const durationMs = Date.now() - startedAt
  if (stuck > 0)
    yield* Effect.logWarning("watchdog scan completed", {
      sessions: active.size,
      stuck,
      interrupted,
      durationMs,
    })
  else
    yield* Effect.logDebug("watchdog scan completed", {
      sessions: active.size,
      stuck,
      interrupted,
      durationMs,
    })
})

export const layerWithConfig = (config: Config) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      if (config.timeoutMs <= 0) return Service.of({ enabled: false, scanOnce: Effect.void })
      const execution = yield* SessionExecution.Service
      const store = yield* SessionStore.Service
      const scanOnce = scan({ config, execution, store })
      yield* scanOnce.pipe(
        Effect.delay(config.initialDelay),
        Effect.repeat(Schedule.spaced(config.scanInterval)),
        Effect.forkScoped,
      )
      return Service.of({ enabled: true, scanOnce })
    }),
  )

export const layer = layerWithConfig(loadConfig())

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionExecution.node, SessionStore.node],
})
