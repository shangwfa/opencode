import { afterEach, expect } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { Question } from "../../src/question"
import { disposeAllInstances, provideInstance, testInstanceStoreLayer, tmpdirScoped } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import { QuestionID } from "../../src/question/schema"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { EventV2Bridge } from "../../src/event-v2-bridge"

const questionLayer = LayerNode.compile(LayerNode.group([Question.node, EventV2Bridge.node, CrossSpawnSpawner.node]))
const lifecycle = testEffect(Layer.mergeAll(questionLayer, testInstanceStoreLayer))

const question = (text: string) => ({
  question: text,
  header: text.slice(0, 20),
  options: [{ label: "yes", description: "" }],
})

const askFork = (sessionID: SessionID, text: string) =>
  Effect.gen(function* () {
    const svc = yield* Question.Service
    return yield* svc.ask({ sessionID, questions: [question(text)] }).pipe(Effect.exit, Effect.forkScoped)
  })

const listPending = Effect.gen(function* () {
  return yield* Question.Service.use((svc) => svc.list())
})

afterEach(async () => {
  await disposeAllInstances()
})

/** 钉住 docs/hitl-persistence-design.md §4.8：单 session 挂起上限（SQLite 内存路径；PG 路径在 advisory lock 事务内原子计数+插入，见 HitlStore.insertPendingLimited）。 */
lifecycle.live("question ask enforces per-session pending limit and recovers after reply", () =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git: true })
    const sessionID = SessionID.make("ses_limit_test")
    const limit = 10

    for (let i = 0; i < limit; i++) {
      yield* askFork(sessionID, `q${i}`).pipe(provideInstance(dir))
    }
    yield* Effect.sleep("50 millis").pipe(provideInstance(dir))
    expect((yield* listPending.pipe(provideInstance(dir))).length).toBe(limit)

    // 超限的第 11 次 ask 立即失败（不产生新 pending）
    const over = yield* Question.Service.use((svc) => svc.ask({ sessionID, questions: [question("over")] })).pipe(
      provideInstance(dir),
      Effect.exit,
    )
    expect(Exit.isFailure(over)).toBe(true)
    const defect = Exit.isFailure(over) ? Cause.squash(over.cause) : undefined
    expect(String(defect)).toContain("Too many pending questions")
    expect((yield* listPending.pipe(provideInstance(dir))).length).toBe(limit)

    // 其他 session 不受影响
    yield* askFork(SessionID.make("ses_other"), "other").pipe(provideInstance(dir))
    yield* Effect.sleep("50 millis").pipe(provideInstance(dir))
    expect((yield* listPending.pipe(provideInstance(dir))).length).toBe(limit + 1)

    // 回复一个后恢复配额
    const first = (yield* listPending.pipe(provideInstance(dir))).find((req) => req.sessionID === sessionID)
    expect(first).toBeDefined()
    yield* Question.Service.use((svc) =>
      svc.reply({ requestID: (first as { id: QuestionID }).id, answers: [["yes"]] }),
    ).pipe(provideInstance(dir))
    yield* askFork(sessionID, "again").pipe(provideInstance(dir))
    yield* Effect.sleep("50 millis").pipe(provideInstance(dir))
    expect((yield* listPending.pipe(provideInstance(dir))).length).toBe(limit + 1)

    // 清场：终结全部挂起，让所有 fork 的 ask fiber 收敛
    for (const req of yield* listPending.pipe(provideInstance(dir))) {
      yield* Question.Service.use((svc) => svc.reject(req.id)).pipe(
        provideInstance(dir),
        Effect.catch(() => Effect.void),
      )
    }
  }),
)
