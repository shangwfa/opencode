export * as SessionExecution from "./execution.js"

import { Cause, Context, Effect, Exit, Fiber, Layer } from "effect"
import { Bus } from "../bus.js"
import { Database } from "../database/database.js"
import { Job } from "../job.js"
import { Instance } from "../instance/service.js"
import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { SessionExecutionLease } from "./execution-lease.js"
import { SessionEvent } from "./event.js"
import { SessionRunCoordinator } from "./run-coordinator.js"
import { SessionRunner } from "./runner/index.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"
import { toSessionError } from "./to-session-error.js"
import { ExecutionLeaseUnavailableError, UserInterruptedError } from "./error.js"
import { SessionInbox } from "./inbox.js"
import { SandboxProvider } from "../sandbox/provider.js"

export interface Options {
  /** PostgreSQL lease timings; defaults come from env or the documented starting points. */
  readonly lease?: SessionExecutionLease.Options
}

export interface Interface {
  /** Snapshots active execution owned by this process. */
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  /** Checks process-local ownership, including interruption cleanup and terminal settlement. */
  readonly isActive: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
  /** Starts execution while idle or joins the active execution. */
  readonly resume: (sessionID: SessionSchema.ID) => Effect.Effect<void, SessionRunner.RunError>
  /** Registers newly recorded work. Repeated wakeups may coalesce. */
  readonly wake: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /**
   * Interrupt active work owned by this process. Idle interruption is a no-op. Resolves once
   * the interruption is accepted; cleanup settles asynchronously in the execution fiber.
   * Returns whether an active execution was interrupted. Compose with `awaitIdle` when
   * settlement matters. `awaitSettlement` waits only for the interrupted execution,
   * rather than fresh work admitted during its cleanup.
   */
  readonly interrupt: (
    sessionID: SessionSchema.ID,
    options?: {
      readonly resume?: boolean
      readonly reason?: "user" | "inactivity" | "watchdog"
      readonly awaitSettlement?: boolean
    },
  ) => Effect.Effect<boolean>
  /** Resolves once this process owns no active execution for the Session. Returns immediately when idle and never starts work. */
  readonly awaitIdle: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

/** Routes execution from a Session ID to its selected instance's runner. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionExecution") {}

type InterruptReason = "user" | "shutdown" | "inactivity" | "watchdog"

export function terminal(exit: Exit.Exit<void, SessionRunner.RunError>, reason?: InterruptReason) {
  if (Exit.isSuccess(exit)) return { type: "succeeded" as const }
  if (Cause.hasInterrupts(exit.cause)) return { type: "interrupted" as const, reason: reason ?? "shutdown" }
  const failure = Cause.squash(exit.cause)
  if (failure instanceof UserInterruptedError) return { type: "interrupted" as const, reason: "user" as const }
  return { type: "failed" as const, error: toSessionError(failure) }
}

/** Process-local execution: drains run in this process using the selected instance. */
export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const store = yield* SessionStore.Service
      const instances = yield* Instance.Service
      const bus = yield* Bus.Service
      const jobs = yield* Job.Service
      const database = yield* Database.Service
      const db = database.db
      const leaseOptions = { ...SessionExecutionLease.makeOptions(), ...options?.lease }
      // PG SaaS is multi-pod: the durable lease decides which process may run a
      // turn. SQLite stays process-local and skips all lease machinery.
      const lease =
        database.dialect === "postgres" ? SessionExecutionLease.make(db, crypto.randomUUID(), leaseOptions) : undefined
      const held = new Map<SessionSchema.ID, SessionExecutionLease.Lease>()
      const renewals = new Map<SessionSchema.ID, Fiber.Fiber<void>>()
      const scope = yield* Effect.scope
      const reportLifecycle = <A>(sessionID: SessionSchema.ID, effect: Effect.Effect<A>) =>
        effect.pipe(
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to publish Session execution lifecycle", cause).pipe(
                  Effect.annotateLogs({ sessionID }),
                ),
          ),
          Effect.asVoid,
        )
      // Write-ahead claim: starting records the durable intent that a turn is in flight, in the same
      // transaction as the started event. Terminals release it — except shutdown interruption, which
      // preserves the claim so the next server start resumes the turn. A claim that survives with no
      // terminal is the signature of a process that died without teardown (crash, SIGKILL, eviction);
      // recovery is a property of the database, never of a shutdown hook that may not run.
      const claimOnCommit = (sessionID: SessionSchema.ID) => ({
        commit: () => store.claim(sessionID),
      })
      const releaseOnCommit = (sessionID: SessionSchema.ID) => ({
        commit: () => store.release(sessionID),
      })
      // Terminal settlement runs the fenced lease release inside the event's
      // commit: a lost lease dies inside the transaction, rolling the terminal
      // event back, so a takeover mid-drain cannot be overwritten by the
      // previous owner's result.
      const withLeaseRelease = (
        base: { readonly commit: () => Effect.Effect<void> } | undefined,
        leaseHeld: SessionExecutionLease.Lease | undefined,
        sessionID: SessionSchema.ID,
      ) =>
        lease && leaseHeld
          ? {
              commit: () =>
                Effect.gen(function* () {
                  if (base) yield* base.commit()
                  yield* lease.releaseFenced(sessionID, leaseHeld).pipe(Effect.orDie)
                }),
            }
          : base
      const destroyUnkeptSandbox = (sessionID: SessionSchema.ID) =>
        Effect.gen(function* () {
          const session = yield* store.get(sessionID)
          // Child completion owns only its logical execution. The shared physical
          // Sandbox lifecycle is managed by the root, regardless of keepAlive.
          if (!session || session.parentID) return
          // Snapshot persistence owns idle recycling, not a root turn's terminal.
          if (session.sandbox?.persistMode === "snapshot") return
          yield* instances.provide(session)(
            Effect.gen(function* () {
              const sandbox = yield* SandboxProvider.Service
              if ((yield* sandbox.lifecycle(sessionID)).persistMode === "snapshot") return
              if (sandbox.enabled && !(yield* sandbox.isKeepAlive(sessionID))) yield* sandbox.destroy(sessionID)
            }),
          )
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Failed to destroy idle sandbox", { sessionID, cause })))
      const drain = Effect.fnUntraced(function* (
        sessionID: SessionSchema.ID,
        force: boolean,
        continuation?: SessionRunner.Continuation,
        promotable: SessionInbox.Promotable = "input",
      ): Effect.fn.Return<void, SessionRunner.RunError> {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
        const result = yield* SessionRunner.Service.use((runner) =>
          runner.drain({ sessionID, force, continuation, promotable }),
        ).pipe(
          instances.provide(session),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
        return yield* SessionRunner.DrainResult.$match(result, {
          Complete: () => Effect.void,
          Moved: (result) => drain(sessionID, false, result.continuation, promotable),
          Reloaded: (result) => drain(sessionID, result.force, result.continuation, promotable),
        })
      })
      // Keeps the durable lease warm while the execution runs. On loss the local
      // execution is stopped and marked foreign: its terminal settlement must not
      // publish events, cancel jobs, or destroy sandboxes for another owner's turn.
      const renewalLoop = (sessionID: SessionSchema.ID, acquired: SessionExecutionLease.Lease): Effect.Effect<void> =>
        Effect.gen(function* () {
          while (lease) {
            yield* Effect.sleep(leaseOptions.renewMs)
            if (held.get(sessionID) !== acquired) return
            yield* lease.renew(sessionID, acquired).pipe(
              Effect.catchTag("SessionExecutionLease.LostError", (error) =>
                Effect.gen(function* () {
                  held.delete(sessionID)
                  yield* Effect.logWarning("Session execution lease lost; stopping local execution", {
                    sessionID,
                    ownerID: error.ownerID,
                    epoch: error.epoch,
                  })
                  yield* coordinator.interrupt(sessionID, "watchdog")
                }),
              ),
            )
          }
        })

      const coordinator: SessionRunCoordinator.Coordinator<SessionSchema.ID, SessionRunner.RunError, InterruptReason> =
        yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError, InterruptReason>({
          started: (sessionID) =>
            Effect.gen(function* () {
              if (!lease) {
                yield* reportLifecycle(
                  sessionID,
                  bus.publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID)),
                )
                return
              }
              // Admission gates the drain: without the lease this process must not
              // run tools or model requests for the Session at all.
              const acquired = yield* lease.acquire(sessionID).pipe(
                Effect.catchTag(
                  "SessionExecutionLease.BusyError",
                  (busy) => new ExecutionLeaseUnavailableError({ sessionID, ownerID: busy.ownerID }),
                ),
                Effect.orDie,
              )
              held.set(sessionID, acquired)
              const published = yield* bus
                .publish(SessionEvent.Execution.Started, { sessionID }, claimOnCommit(sessionID))
                .pipe(Effect.exit)
              if (Exit.isFailure(published)) {
                held.delete(sessionID)
                yield* lease.releaseFenced(sessionID, acquired).pipe(Effect.ignore)
                yield* Effect.logError("Failed to publish Session execution lifecycle", published.cause).pipe(
                  Effect.annotateLogs({ sessionID }),
                )
                return yield* Effect.die(new Error(`Failed to record execution start: ${sessionID}`))
              }
              renewals.set(sessionID, yield* renewalLoop(sessionID, acquired).pipe(Effect.forkIn(scope)))
            }),
          drain: (sessionID, force, promotable) => drain(sessionID, force, undefined, promotable),
          // One terminal observation per busy period, covering every coalesced drain.
          settled: (sessionID, exit, reason) =>
            Effect.gen(function* () {
              const renewal = renewals.get(sessionID)
              if (renewal) {
                renewals.delete(sessionID)
                yield* Fiber.interrupt(renewal)
              }
              const leaseHeld = held.get(sessionID)
              held.delete(sessionID)
              // A started hook that never acquired (busy lease) fails the execution
              // before any local work; a lost lease already handed the turn over.
              // Either way this process must not settle another owner's turn.
              const owned = !lease || leaseHeld !== undefined
              if (!owned) {
                yield* Effect.logWarning("Skipping terminal settlement for an execution owned elsewhere", { sessionID })
                return
              }
              yield* reportLifecycle(
                sessionID,
                Effect.gen(function* () {
                  const outcome = terminal(exit, reason)
                  if (outcome.type === "succeeded") {
                    yield* bus.publish(
                      SessionEvent.Execution.Succeeded,
                      { sessionID },
                      withLeaseRelease(releaseOnCommit(sessionID), leaseHeld, sessionID),
                    )
                    return
                  }
                  if (outcome.type === "interrupted") {
                    // Deliberate stops release the claim; shutdown keeps it for restart continuity.
                    if (outcome.reason !== "shutdown") yield* jobs.cancel(sessionID)
                    yield* bus.publish(
                      SessionEvent.Execution.Interrupted,
                      { sessionID, reason: outcome.reason },
                      // Shutdown keeps the claim but always drops this process's lease:
                      // graceful restart must not wait out the TTL for takeover.
                      withLeaseRelease(
                        outcome.reason === "shutdown" ? undefined : releaseOnCommit(sessionID),
                        leaseHeld,
                        sessionID,
                      ),
                    )
                    return
                  }
                  yield* bus.publish(
                    SessionEvent.Execution.Failed,
                    {
                      sessionID,
                      error: outcome.error,
                    },
                    withLeaseRelease(releaseOnCommit(sessionID), leaseHeld, sessionID),
                  )
                }),
              ).pipe(Effect.ensuring(destroyUnkeptSandbox(sessionID)))
            }),
        })

      return Service.of({
        active: coordinator.active,
        isActive: coordinator.isActive,
        interrupt: (sessionID, options) =>
          Effect.gen(function* () {
            const interrupted = yield* coordinator.interrupt(sessionID, options?.reason ?? "user", options)
            if (!options?.resume) return interrupted
            // Resume steering input and between-turn control work from the interrupted
            // intent. Queued next-turn prompts stay parked: a steer-scoped drain never
            // promotes them, and a control item behind a queued prompt waits its turn.
            // Interruption acknowledges before cleanup settles, so this wake usually lands
            // on the stopping execution's doorbell and starts the successor at settle.
            // Reading the inbox concurrently with the dying drain is safe: delivery consumes
            // rows inside uninterruptible publications, so a steer row is either still
            // promotable here or was fully delivered and needs no resumption.
            const next = yield* SessionInbox.nextPromotable(db, sessionID, "input")
            if (next === undefined) return interrupted
            if (next.delivery === "steer" || next.type === "compaction" || next.type === "move")
              yield* coordinator.wake(sessionID, "steer")
            return interrupted
          }),
        resume: coordinator.run,
        wake: coordinator.wake,
        awaitIdle: coordinator.awaitIdle,
      })
    }),
  )

export const node = makeGlobalNode({
  service: Service,
  layer: layer(),
  deps: [SessionStore.node, Instance.node, Bus.node, Database.node, Job.node],
})

/** Low-level compatibility layer for callers that only need durable Session recording. */
export const noopLayer = Layer.succeed(
  Service,
  Service.of({
    active: Effect.succeed(new Set()),
    isActive: () => Effect.succeed(false),
    resume: () => Effect.void,
    wake: () => Effect.void,
    interrupt: () => Effect.succeed(false),
    awaitIdle: () => Effect.void,
  }),
)
