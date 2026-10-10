// 专用 opencode-v2-test 上的跨实例事件扇出回归：
// B 发布的 ephemeral/durable 事件经 PG LISTEN/NOTIFY 出现在 A 的订阅流上；
// 本进程发布的事件不会被自己的 NOTIFY 回声重复投递。
import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer, Schema, Stream } from "effect"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Session } from "@opencode/schema/session"
import { SessionEvent } from "@opencode/schema/session-event"

const url = process.env.OPENCODE_DATABASE_URL
const describePg = url ? describe : describe.skip

const guard = () => {
  if (!url || !new URL(url).pathname.endsWith("/opencode-v2-test")) {
    throw new Error("跨实例扇出测试必须使用专用 opencode-v2-test 数据库")
  }
}

const nodes = () => AppNodeBuilder.build(LayerNode.group([Database.node, Bus.node]))
const buildPod = () =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.fresh(nodes()))
    return Context.get(context, Bus.Service)
  })

const Fanout = Bus.ephemeral({
  type: "test.fanout",
  schema: { text: Schema.String },
})

describePg("Bus 跨实例事件扇出", () => {
  test("B 发布的事件出现在 A 的 live 订阅上；本进程不重复收自己的回声", async () => {
    guard()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const a = yield* buildPod()
          const b = yield* buildPod()

          const receivedOnA: string[] = []
          const receivedOnB: string[] = []
          yield* a.subscribe(Fanout).pipe(
            Stream.tap((event) => Effect.sync(() => receivedOnA.push(event.data.text))),
            Stream.runDrain,
            Effect.forkScoped,
          )
          yield* b.subscribe(Fanout).pipe(
            Stream.tap((event) => Effect.sync(() => receivedOnB.push(event.data.text))),
            Stream.runDrain,
            Effect.forkScoped,
          )
          yield* Effect.sleep(200)

          // B 发布：A 经 NOTIFY 收到；B 本地恰好一次（回声去重）。
          yield* b.publish(Fanout, { text: "from-b" })
          yield* Effect.sleep(500)
          expect(receivedOnA).toEqual(["from-b"])
          expect(receivedOnB).toEqual(["from-b"])

          // A 发布：B 收到；A 本地恰好一次。
          yield* a.publish(Fanout, { text: "from-a" })
          yield* Effect.sleep(500)
          expect(receivedOnA).toEqual(["from-b", "from-a"])
          expect(receivedOnB).toEqual(["from-b", "from-a"])

          // durable 事件同样跨实例扇出。
          const durableReceived: string[] = []
          yield* a.subscribe(SessionEvent.Renamed).pipe(
            Stream.tap((event) => Effect.sync(() => durableReceived.push(event.data.title))),
            Stream.runDrain,
            Effect.forkScoped,
          )
          yield* Effect.sleep(200)
          const sessionID = Session.ID.create()
          yield* b.publish(SessionEvent.Renamed, { sessionID, title: "renamed-by-b" })
          yield* Effect.sleep(500)
          expect(durableReceived).toEqual(["renamed-by-b"])
          yield* a.remove(sessionID).pipe(Effect.orDie)
        }),
      ),
    )
  }, 30_000)
})
