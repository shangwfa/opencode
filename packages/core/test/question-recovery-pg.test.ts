// 专用 opencode-v2-test 上的 question 恢复 barrier 回归：
// 进程死亡后遗留 running question tool part + durable pending form：
//  1) 恢复方阻塞等待原 form（不重复提问、不失败收敛）；
//  2) 另一 pod 回复后，恢复方记录 Tool.Success（含答案内容）并从 pending 列表收敛；
//  3) 用户取消 → Tool.Failed(aborted)；
//  4) 无 ledger 关联的 running question 仍按失败收敛（SQLite 行为不变）。
import { describe, expect, test } from "bun:test"
import { Context, DateTime, Effect, Exit, Fiber, Layer, Scope, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Bus } from "@opencode/core/bus"
import { Agent } from "@opencode/core/agent"
import { Form } from "@opencode/core/form"
import { Permission } from "@opencode/core/permission"
import { PermissionSaved } from "@opencode/core/permission/saved"
import { SessionPermissionApproval } from "@opencode/core/permission/session-approval"
import { SessionAgents } from "@opencode/core/session/agents"
import { QuestionRecovery } from "@opencode/core/session/runner/question-recovery"
import { SessionMessage } from "@opencode/schema/session-message"
import { Session } from "@opencode/schema/session"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable, SessionMessageTable } from "@opencode/core/session/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Location } from "@opencode/core/location"
import { location } from "./fixture/location"

const url = process.env.OPENCODE_DATABASE_URL
const describePg = url ? describe : describe.skip

const guard = () => {
  if (!url || !new URL(url).pathname.endsWith("/opencode-v2-test")) {
    throw new Error("question 恢复测试必须使用专用 opencode-v2-test 数据库")
  }
}

const nodes = () =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionProjector.node,
      SessionStore.node,
      Form.node,
      Agent.node,
      PermissionSaved.node,
      SessionPermissionApproval.node,
      SessionAgents.node,
      Permission.node,
    ]),
    [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
    ],
  )

interface Pod {
  readonly database: Database.Service["Service"]
  readonly bus: Bus.Service["Service"]
  readonly store: SessionStore.Service["Service"]
  readonly forms: Form.Interface
  readonly permissions: Permission.Interface
  readonly agents: Agent.Interface
}

const buildPod = (scope: Scope.Closeable) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.fresh(nodes()))
    return {
      database: Context.get(context, Database.Service),
      bus: Context.get(context, Bus.Service),
      store: Context.get(context, SessionStore.Service),
      forms: Context.get(context, Form.Service),
      permissions: Context.get(context, Permission.Service),
      agents: Context.get(context, Agent.Service),
    } satisfies Pod
  })

/** Empty agent rules make every request ask, and authorize recovery's question assert. */
const allowAsk = (pod: Pod) =>
  pod.agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = []
    }),
  )

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
        agent: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

const removeSession = (pod: Pod, sessionID: Session.ID) =>
  Effect.gen(function* () {
    yield* pod.bus.remove(sessionID).pipe(Effect.orDie)
    yield* pod.database.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
  })

/** 插入一条带 running question tool part 的 assistant 消息，模拟进程死亡现场。 */
const seedRunningQuestion = (
  pod: Pod,
  sessionID: Session.ID,
  messageID: SessionMessage.ID,
  toolID: string,
  questions: ReadonlyArray<{
    question: string
    header: string
    options: ReadonlyArray<{ label: string; description: string }>
  }>,
) => {
  const created = DateTime.makeUnsafe(new Date().getTime())
  const { id, type, ...data } = Schema.encodeSync(SessionMessage.Assistant)(
    SessionMessage.Assistant.make({
      id: messageID,
      type: "assistant",
      agent: Agent.ID.make("test"),
      model: { id: Model.ID.make("test-model"), providerID: Provider.ID.make("test-provider") },
      time: { created },
      content: [
        {
          type: "tool",
          id: toolID,
          name: "question",
          executed: false,
          state: { status: "running", input: { questions }, metadata: {} },
          time: { created, ran: created },
        },
      ],
    }),
  )
  void id
  return pod.database.db
    .insert(SessionMessageTable)
    .values({
      id: messageID,
      session_id: sessionID,
      seq: 1,
      type,
      time_created: DateTime.toEpochMillis(created),
      data,
    } as typeof SessionMessageTable.$inferInsert)
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
}

const waitFor = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, label: string, timeoutMs = 5_000) =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    let last: A | undefined
    while (Date.now() < deadline) {
      last = yield* effect
      if (predicate(last)) return last
      yield* Effect.sleep(50)
    }
    return yield* Effect.die(new Error(`waitFor timeout: ${label}`))
  })

describePg("QuestionRecovery 恢复 barrier", () => {
  test("等待原 form；另一 pod 回复后记录 Tool.Success 并收敛", async () => {
    guard()
    process.env["OPENCODE_HITL_POLL_MS"] = "50"
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            const a = yield* buildPod(scope)
            const b = yield* buildPod(scope)
            const sessionID = Session.ID.create()
            yield* seed(a, sessionID)
            yield* Effect.addFinalizer(() => removeSession(a, sessionID))

            const toolID = "tool_question_dead"
            const questions = [
              {
                question: "Which language?",
                header: "Language",
                options: [
                  { label: "Rust", description: "Rust" },
                  { label: "Go", description: "Go" },
                ],
              },
            ]
            yield* a.forms.create({
              sessionID,
              title: "Questions",
              metadata: { kind: "question", tool: { messageID: "msg_dead", id: toolID } },
              fields: [
                {
                  key: "q0",
                  type: "string",
                  title: "Language",
                  options: [
                    { value: "Rust", label: "Rust" },
                    { value: "Go", label: "Go" },
                  ],
                  custom: true,
                },
              ],
            })

            const messageID = SessionMessage.ID.make("msg_dead")
            yield* seedRunningQuestion(a, sessionID, messageID, toolID, questions)

            // 恢复方阻塞等待：settle 不立即返回。
            const settling = yield* QuestionRecovery.settleTool(
              { bus: a.bus, forms: a.forms, permissions: a.permissions, database: a.database },
              sessionID,
              { assistantMessageID: messageID, id: toolID, name: "question", input: { questions }, executed: false },
            ).pipe(Effect.forkIn(scope))
            // B pod 回复原 form（id 与 ledger 行一致）。
            const pendingOnB = yield* b.forms.list({ sessionID })
            expect(pendingOnB.map((item) => item.id)).toHaveLength(1)
            yield* b.forms.reply({ id: pendingOnB[0]!.id, answer: { q0: "Rust" } })

            expect(yield* Fiber.join(settling)).toBe(true)
            const messages = yield* a.store.context(sessionID)
            const assistant = messages.find((message) => message.id === messageID)
            expect(assistant?.type).toBe("assistant")
            if (assistant?.type !== "assistant") return
            const part = assistant.content.find((item) => item.type === "tool")
            expect(part?.type).toBe("tool")
            if (part?.type !== "tool") return
            expect(part.state.status).toBe("completed")
            if (part.state.status !== "completed") return
            expect(part.state.content[0]).toMatchObject({ type: "text" })
            expect(JSON.stringify(part.state.content)).toContain("Rust")
          }),
        ),
      )
    } finally {
      delete process.env["OPENCODE_HITL_POLL_MS"]
    }
  }, 30_000)

  test("用户取消 → Tool.Failed(aborted)；无关联 form 的 running question 不被恢复", async () => {
    guard()
    process.env["OPENCODE_HITL_POLL_MS"] = "50"
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            const a = yield* buildPod(scope)
            const b = yield* buildPod(scope)
            const sessionID = Session.ID.create()
            yield* seed(a, sessionID)
            yield* Effect.addFinalizer(() => removeSession(a, sessionID))

            const toolID = "tool_question_cancel"
            const questions = [
              { question: "Proceed?", header: "Confirm", options: [{ label: "Yes", description: "Yes" }] },
            ]
            yield* a.forms.create({
              sessionID,
              title: "Questions",
              metadata: { kind: "question", tool: { messageID: "msg_cancel", id: toolID } },
              fields: [
                {
                  key: "q0",
                  type: "string",
                  title: "Confirm",
                  options: [{ value: "Yes", label: "Yes" }],
                  custom: true,
                },
              ],
            })
            const messageID = SessionMessage.ID.make("msg_cancel")
            yield* seedRunningQuestion(a, sessionID, messageID, toolID, questions)

            const settling = yield* QuestionRecovery.settleTool(
              { bus: a.bus, forms: a.forms, permissions: a.permissions, database: a.database },
              sessionID,
              { assistantMessageID: messageID, id: toolID, name: "question", input: { questions }, executed: false },
            ).pipe(Effect.forkIn(scope))
            const pendingOnB = yield* b.forms.list({ sessionID })
            yield* b.forms.cancel(pendingOnB[0]!.id)
            expect(yield* Fiber.join(settling)).toBe(true)
            const messages = yield* a.store.context(sessionID)
            const assistant = messages.find((message) => message.id === messageID)
            if (assistant?.type !== "assistant") return yield* Effect.die("assistant missing")
            const part = assistant.content.find((item) => item.type === "tool")
            if (part?.type !== "tool") return yield* Effect.die("tool part missing")
            expect(part.state.status).toBe("error")
            if (part.state.status !== "error") return
            expect(part.state.error.type).toBe("aborted")

            // 无 ledger 关联：返回 false，由既有失败收敛处理。
            const unrelated = yield* QuestionRecovery.settleTool(
              { bus: a.bus, forms: a.forms, permissions: a.permissions, database: a.database },
              sessionID,
              {
                assistantMessageID: messageID,
                id: "tool_orphan",
                name: "question",
                input: { questions },
                executed: false,
              },
            )
            expect(unrelated).toBe(false)
            // Code Mode execute：无持久化检查点，无 HITL 关联同样不恢复，
            // 按失败收敛（设计文档第8节的显式首期边界）。
            const codemode = yield* QuestionRecovery.settleTool(
              { bus: a.bus, forms: a.forms, permissions: a.permissions, database: a.database },
              sessionID,
              {
                assistantMessageID: messageID,
                id: "tool_execute_orphan",
                name: "execute",
                input: { code: "await tools.read('/x')" },
                executed: false,
              },
            )
            expect(codemode).toBe(false)
          }),
        ),
      )
    } finally {
      delete process.env["OPENCODE_HITL_POLL_MS"]
    }
  }, 30_000)

  test("Permission 恢复：批准不重放原操作，拒绝收敛为 permission.rejected", async () => {
    guard()
    process.env["OPENCODE_HITL_POLL_MS"] = "50"
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const scope = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void))
            const a = yield* buildPod(scope)
            const b = yield* buildPod(scope)
            yield* allowAsk(a)
            yield* allowAsk(b)
            const approvedSession = Session.ID.create()
            const rejectedSession = Session.ID.create()
            yield* seed(a, approvedSession)
            yield* seed(a, rejectedSession)
            yield* Effect.addFinalizer(() => removeSession(a, approvedSession))
            yield* Effect.addFinalizer(() => removeSession(a, rejectedSession))

            // 挂起的 shell 审批：模拟进程死亡现场。
            const approvedTool = "tool_shell_approved"
            const approvedFiber = yield* a.permissions
              .assert({
                id: Permission.ID.create(),
                sessionID: approvedSession,
                action: "bash",
                resources: ["pwd"],
                source: { type: "tool", messageID: "msg_approved", id: approvedTool },
              })
              .pipe(Effect.exit)
              .pipe(Effect.forkIn(scope))
            const approvedPending = yield* waitFor(
              b.permissions.forSession(approvedSession),
              (requests) => requests.length === 1,
              "B sees approved pending",
            )
            const approvedMessage = SessionMessage.ID.make("msg_approved")
            yield* seedRunningQuestion(a, approvedSession, approvedMessage, approvedTool, [
              { question: "unused", header: "unused", options: [{ label: "x", description: "x" }] },
            ])

            const approvedSettling = yield* QuestionRecovery.settleTool(
              { bus: a.bus, forms: a.forms, permissions: a.permissions, database: a.database },
              approvedSession,
              {
                assistantMessageID: approvedMessage,
                id: approvedTool,
                name: "bash",
                input: { command: "pwd" },
                executed: false,
              },
            ).pipe(Effect.forkIn(scope))
            yield* b.permissions.reply({ requestID: approvedPending[0]!.id, reply: "once" })
            const approvedExit = yield* Fiber.join(approvedFiber)
            expect(Exit.isSuccess(approvedExit)).toBe(true)
            expect(yield* Fiber.join(approvedSettling)).toBe(true)
            const approvedMessages = yield* a.store.context(approvedSession)
            const approvedPart = approvedMessages
              .find(
                (message): message is SessionMessage.Assistant =>
                  message.id === approvedMessage && message.type === "assistant",
              )
              ?.content.find((item) => item.type === "tool")
            if (approvedPart?.type !== "tool") return yield* Effect.die("approved part missing")
            expect(approvedPart.state.status).toBe("error")
            if (approvedPart.state.status !== "error") return
            expect(approvedPart.state.error.type).toBe("aborted")
            expect(approvedPart.state.error.message).toContain("not executed")

            // 拒绝路径：收敛为 permission.rejected。
            const rejectedTool = "tool_shell_rejected"
            yield* a.permissions
              .assert({
                id: Permission.ID.create(),
                sessionID: rejectedSession,
                action: "bash",
                resources: ["pwd"],
                source: { type: "tool", messageID: "msg_rejected", id: rejectedTool },
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            const rejectedPending = yield* waitFor(
              b.permissions.forSession(rejectedSession),
              (requests) => requests.length === 1,
              "B sees rejected pending",
            )
            const rejectedMessage = SessionMessage.ID.make("msg_rejected")
            yield* seedRunningQuestion(a, rejectedSession, rejectedMessage, rejectedTool, [
              { question: "unused", header: "unused", options: [{ label: "x", description: "x" }] },
            ])
            const rejectedSettling = yield* QuestionRecovery.settleTool(
              { bus: a.bus, forms: a.forms, permissions: a.permissions, database: a.database },
              rejectedSession,
              {
                assistantMessageID: rejectedMessage,
                id: rejectedTool,
                name: "bash",
                input: { command: "pwd" },
                executed: false,
              },
            ).pipe(Effect.forkIn(scope))
            yield* b.permissions.reply({ requestID: rejectedPending[0]!.id, reply: "reject", message: "not allowed" })
            expect(yield* Fiber.join(rejectedSettling)).toBe(true)
            const rejectedMessages = yield* a.store.context(rejectedSession)
            const rejectedPart = rejectedMessages
              .find(
                (message): message is SessionMessage.Assistant =>
                  message.id === rejectedMessage && message.type === "assistant",
              )
              ?.content.find((item) => item.type === "tool")
            if (rejectedPart?.type !== "tool") return yield* Effect.die("rejected part missing")
            expect(rejectedPart.state.status).toBe("error")
            if (rejectedPart.state.status !== "error") return
            expect(rejectedPart.state.error.type).toBe("permission.rejected")
            expect(rejectedPart.state.error.message).toContain("not allowed")
          }),
        ),
      )
    } finally {
      delete process.env["OPENCODE_HITL_POLL_MS"]
    }
  }, 30_000)
})
