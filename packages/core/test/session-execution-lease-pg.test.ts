// 专用 opencode-v2-test 上的执行租约/fencing 回归：
//  1) 租约模块语义：互斥、过期接管、epoch 单调、fenced renew/release、held 快照。
//  2) 执行层集成：双独立 Database/Bus「pod」下，无租约不得 drain、失租后不得发布终态。
import { describe, expect, test } from "bun:test"
import { Cause, Context, Deferred, Effect, Exit, Layer, LayerMap, Scope } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Instance } from "@opencode/core/instance/service"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import type { LocationServices } from "@opencode/core/location-services"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionErrors } from "@opencode/core/session/error"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionExecutionLease } from "@opencode/core/session/execution-lease"
import { SessionRunner } from "@opencode/core/session/runner/index"
import { SessionTable } from "@opencode/core/session/sql"
import { SessionStore } from "@opencode/core/session/store"
import { Job } from "@opencode/core/job"
import { KV } from "@opencode/core/kv"

const url = process.env.OPENCODE_DATABASE_URL
const describePg = url ? describe : describe.skip

const guard = () => {
  if (!url || !new URL(url).pathname.endsWith("/opencode-v2-test")) {
    throw new Error("执行租约测试必须使用专用 opencode-v2-test 数据库")
  }
}

const podNodes = () =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node, SessionStore.node, Job.node, KV.node]))

interface Pod {
  readonly database: Database.Service["Service"]
  readonly bus: Bus.Service["Service"]
  readonly store: SessionStore.Service["Service"]
  readonly jobs: Job.Interface
  readonly kv: KV.Interface
}

const buildPod = (scope: Scope.Closeable) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.fresh(podNodes()))
    return {
      database: Context.get(context, Database.Service),
      bus: Context.get(context, Bus.Service),
      store: Context.get(context, SessionStore.Service),
      jobs: Context.get(context, Job.Service),
      kv: Context.get(context, KV.Service),
    } satisfies Pod
  })

const seed = (pod: Pod, sessionID: Session.ID) =>
  Effect.gen(function* () {
    yield* pod.database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* pod.database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: sessionID,
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const removeSession = (pod: Pod, sessionID: Session.ID) =>
  pod.database.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)

const claimed = (pod: Pod, sessionID: Session.ID) =>
  pod.database.db
    .select({ claimed: SessionTable.time_suspended })
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(Effect.map((row) => row?.claimed !== null && row?.claimed !== undefined))

describePg("SessionExecutionLease 模块语义", () => {
  test("互斥、续租、过期接管与 fenced 释放", async () => {
    guard()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
          const pod = yield* buildPod(scope)
          expect(pod.database.dialect).toBe("postgres")
          const a = SessionExecutionLease.make(pod.database.db, "owner-a", { ttlMs: 250 })
          const b = SessionExecutionLease.make(pod.database.db, "owner-b", { ttlMs: 5_000 })
          const sessionID = Session.ID.create()
          yield* seed(pod, sessionID)
          yield* Effect.addFinalizer(() => removeSession(pod, sessionID))

          const first = yield* a.acquire(sessionID)
          expect(first).toEqual({ ownerID: "owner-a", epoch: 1 })
          const busy = yield* b.acquire(sessionID).pipe(Effect.flip)
          expect(busy._tag).toBe("SessionExecutionLease.BusyError")
          expect(busy.ownerID).toBe("owner-a")
          expect(yield* a.held()).toEqual([sessionID])
          yield* a.renew(sessionID, first)

          // 过期后另一 owner 接管：epoch 递增，旧 owner 的续租/释放被拒绝。
          yield* Effect.sleep(300)
          const takeover = yield* b.acquire(sessionID)
          expect(takeover.epoch).toBe(2)
          const lost = yield* a.renew(sessionID, first).pipe(Effect.flip)
          expect(lost._tag).toBe("SessionExecutionLease.LostError")
          const fenced = yield* a.releaseFenced(sessionID, first).pipe(Effect.flip)
          expect(fenced._tag).toBe("SessionExecutionLease.LostError")

          // 释放后重新获取从新 epoch 序列开始，held 快照收敛。
          yield* b.releaseFenced(sessionID, takeover)
          const reacquired = yield* b.acquire(sessionID)
          expect(reacquired.epoch).toBe(1)
          expect(yield* a.held()).toEqual([sessionID])
          yield* b.releaseFenced(sessionID, reacquired)
          expect(yield* a.held()).toEqual([])
        }),
      ),
    )
  }, 30_000)
})

describePg("SessionExecution 双 pod 租约集成", () => {
  test("无租约不得执行；失租后不发布终态；接管者独占终态", async () => {
    guard()
    const previousTtl = process.env["OPENCODE_EXECUTION_LEASE_TTL_MS"]
    const previousRenew = process.env["OPENCODE_EXECUTION_LEASE_RENEW_MS"]
    process.env["OPENCODE_EXECUTION_LEASE_TTL_MS"] = "600"
    // A 的续租周期长于 TTL：模拟 owner 存活但在观测窗口内失去租约（被接管）。
    process.env["OPENCODE_EXECUTION_LEASE_RENEW_MS"] = "2000"
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            const podA = yield* buildPod(scope)
            const podB = yield* buildPod(scope)
            const sessionID = Session.ID.create()
            yield* seed(podA, sessionID)
            yield* Effect.addFinalizer(() => removeSession(podA, sessionID))

            const events: Array<{ pod: string; type: string }> = []
            for (const [pod, bus] of [
              ["A", podA.bus],
              ["B", podB.bus],
            ] as const) {
              const unsubscribe = yield* bus.listen((event) =>
                Effect.sync(() => {
                  const data = event.data as Record<string, unknown>
                  if (data["sessionID"] === sessionID) events.push({ pod, type: event.type })
                }),
              )
              yield* Effect.addFinalizer(() => unsubscribe)
            }

            const executionStack = (
              pod: Pod,
              running: Deferred.Deferred<void>,
              release: Deferred.Deferred<void>,
              stackScope: Scope.Closeable,
            ) =>
              Effect.gen(function* () {
                const jobs = yield* Job.make.pipe(Scope.provide(stackScope), Effect.provideService(KV.Service, pod.kv))
                const runner = Layer.succeed(
                  SessionRunner.Service,
                  SessionRunner.Service.of({
                    drain: () =>
                      Deferred.succeed(running, undefined)
                        .pipe(Effect.andThen(Deferred.await(release)))
                        .pipe(Effect.as(SessionRunner.DrainResult.Complete())),
                  }),
                )
                const locations = Layer.effect(
                  LocationServiceMap.Service,
                  LayerMap.make(() => runner as unknown as Layer.Layer<LocationServices>),
                )
                return yield* Layer.buildWithScope(
                  SessionExecution.layer().pipe(
                    Layer.provide(Layer.succeed(SessionStore.Service, pod.store)),
                    Layer.provide(
                      AppNodeBuilder.build(Instance.node, [LocationServiceMap.node.replace(locations)]).pipe(
                        Layer.fresh,
                      ),
                    ),
                    Layer.provide(Layer.succeed(Bus.Service, pod.bus)),
                    Layer.provide(Layer.succeed(Database.Service, pod.database)),
                    Layer.provide(Layer.succeed(Job.Service, jobs)),
                    Layer.provide(Layer.succeed(KV.Service, pod.kv)),
                  ),
                  stackScope,
                )
              })

            const aRunning = yield* Deferred.make<void>()
            const aRelease = yield* Deferred.make<void>()
            const bRunning = yield* Deferred.make<void>()
            const bRelease = yield* Deferred.make<void>()
            const executionA = Context.get(
              yield* executionStack(podA, aRunning, aRelease, scope),
              SessionExecution.Service,
            )
            const executionB = Context.get(
              yield* executionStack(podB, bRunning, bRelease, scope),
              SessionExecution.Service,
            )

            // A 取得租约并开始执行；claim 与租约同时存在。
            yield* executionA.resume(sessionID).pipe(Effect.forkIn(scope))
            yield* Deferred.await(aRunning)
            expect(yield* executionA.isActive(sessionID)).toBe(true)
            expect(yield* claimed(podA, sessionID)).toBe(true)
            expect(yield* SessionExecutionLease.holds(podB.database.db)).toContain(sessionID)

            // B 在租约有效期内不得执行同一 Session。
            const denied = yield* executionB.resume(sessionID).pipe(Effect.exit)
            expect(Exit.isFailure(denied)).toBe(true)
            if (Exit.isFailure(denied)) {
              expect(Cause.squash(denied.cause)).toBeInstanceOf(SessionErrors.ExecutionLeaseUnavailableError)
            }
            expect(yield* executionB.isActive(sessionID)).toBe(false)

            // 租约过期后 B 接管；A 的续租失败并停止本地执行。
            yield* Effect.sleep(700)
            yield* executionB.resume(sessionID).pipe(Effect.forkIn(scope))
            yield* Deferred.await(bRunning)
            yield* executionA.awaitIdle(sessionID)
            expect(yield* executionA.isActive(sessionID)).toBe(false)

            // B 完成后独占终态：A 未发布任何 execution 终态事件，claim 被释放。
            yield* Deferred.succeed(bRelease, undefined)
            yield* executionB.awaitIdle(sessionID)
            const terminals = events.filter(
              (event) =>
                event.type === "session.execution.succeeded" ||
                event.type === "session.execution.failed" ||
                event.type === "session.execution.interrupted",
            )
            if (terminals[0]?.type === "session.execution.failed")
              console.log("TERMINAL_ERROR", JSON.stringify(terminals[0]))
            expect(terminals).toEqual([{ pod: "B", type: "session.execution.succeeded" }])
            expect(
              events
                .filter((event) => event.type === "session.execution.started")
                .map((event) => event.pod)
                .sort(),
            ).toEqual(["A", "B"])
            expect(yield* claimed(podA, sessionID)).toBe(false)
            expect(yield* SessionExecutionLease.holds(podB.database.db)).toEqual([])
          }),
        ),
      )
    } finally {
      if (previousTtl === undefined) delete process.env["OPENCODE_EXECUTION_LEASE_TTL_MS"]
      else process.env["OPENCODE_EXECUTION_LEASE_TTL_MS"] = previousTtl
      if (previousRenew === undefined) delete process.env["OPENCODE_EXECUTION_LEASE_RENEW_MS"]
      else process.env["OPENCODE_EXECUTION_LEASE_RENEW_MS"] = previousRenew
    }
  }, 60_000)
})
