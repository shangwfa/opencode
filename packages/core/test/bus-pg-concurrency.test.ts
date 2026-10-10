import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { eq } from "drizzle-orm"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { EventSequenceTable, EventTable } from "@opencode/core/event/sql"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Session } from "@opencode/schema/session"
import { Event } from "@opencode/schema/event"
import { SessionEvent } from "@opencode/schema/session-event"

const url = process.env.OPENCODE_DATABASE_URL
const describePg = url ? describe : describe.skip
const nodes = () =>
  AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]), [
    Bus.node.replace(Bus.configured({ persist: true })),
  ])

const instances = Effect.gen(function* () {
  if (!url || !new URL(url).pathname.endsWith("/opencode-v2-test")) {
    throw new Error("跨实例测试必须使用专用 opencode-v2-test 数据库")
  }
  const a = yield* Layer.build(Layer.fresh(nodes()))
  const b = yield* Layer.build(Layer.fresh(nodes()))
  return { busA: Context.get(a, Bus.Service), busB: Context.get(b, Bus.Service), db: Context.get(a, Database.Service).db }
})

describePg("Bus PostgreSQL 跨实例事务", () => {
  test("独立 Bus 并发 publish/publishAll 保持聚合序号唯一连续", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // 两个独立数据库连接和 Bus；不共享进程内聚合锁。
          const { busA, busB, db } = yield* instances
          const sessionID = Session.ID.create()
          yield* Effect.addFinalizer(() => busA.remove(sessionID))
          const payload = (title: string) => ({ sessionID, title })
          yield* Effect.all(
            Array.from({ length: 20 }, (_, index) => {
              const bus = index % 2 ? busA : busB
              return index % 3
                ? bus.publish(SessionEvent.Renamed, payload(`single-${index}`))
                : bus.publishAll([
                    [SessionEvent.Renamed, payload(`batch-${index}-a`)],
                    [SessionEvent.Renamed, payload(`batch-${index}-b`)],
                  ])
            }),
            { concurrency: "unbounded", discard: true },
          )
          const rows = yield* db
            .select({ seq: EventTable.seq })
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, sessionID))
            .orderBy(EventTable.seq)
            .all()
          expect(rows.map((row) => row.seq)).toEqual(Array.from({ length: 27 }, (_, index) => index))
          const sequence = yield* db
            .select({ seq: EventSequenceTable.seq })
            .from(EventSequenceTable)
            .where(eq(EventSequenceTable.aggregate_id, sessionID))
            .get()
          expect(sequence?.seq).toBe(26)
        }),
      ),
    )
  }, 60_000)

  test("事务回滚不留事件或序号，另一实例仍可提交", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { busA, busB, db } = yield* instances
          const sessionID = Session.ID.create()
          yield* Effect.addFinalizer(() => busA.remove(sessionID))
          const exit = yield* busA
            .publish(SessionEvent.Renamed, { sessionID, title: "rollback" }, { commit: () => Effect.die("rollback") })
            .pipe(Effect.exit)
          expect(Exit.isFailure(exit)).toBe(true)
          const event = yield* busB.publish(SessionEvent.Renamed, { sessionID, title: "committed" })
          expect(event.durable?.seq).toBe(Event.Seq.make(0))
          const rows = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all()
          expect(rows.length).toBe(1)
          expect(rows[0]?.id).toBe(event.id)
        }),
      ),
    )
  }, 60_000)

  test("一个聚合未提交不会阻塞另一实例的其他聚合", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { busA, busB } = yield* instances
          const first = Session.ID.create()
          const second = Session.ID.create()
          yield* Effect.addFinalizer(() => busA.remove(first))
          yield* Effect.addFinalizer(() => busB.remove(second))
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          // 发生测试失败时也释放A，避免uninterruptible事务收尾挂住。
          yield* Effect.addFinalizer(() => Deferred.succeed(release, undefined))
          const writer = yield* busA
            .publish(SessionEvent.Renamed, { sessionID: first, title: "held" }, {
              commit: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            })
            .pipe(Effect.forkScoped)
          yield* Deferred.await(entered)
          const event = yield* busB
            .publish(SessionEvent.Renamed, { sessionID: second, title: "independent" })
            .pipe(Effect.timeout("5 seconds"), Effect.ensuring(Deferred.succeed(release, undefined)))
          expect(event.durable?.seq).toBe(Event.Seq.make(0))
          expect((yield* Fiber.join(writer)).durable?.seq).toBe(Event.Seq.make(0))
        }),
      ),
    )
  }, 60_000)
})
