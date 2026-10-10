// 专用 opencode-v2-test 上的 HITL ledger 回归：
//  1) Form：A 创建 pending 持久化；B list/state 可见并可回复；A 的等待者被轮询唤醒；
//     重复回复冲突；重启（重建服务图）后 pending 恢复仍可回复；global 表单不写 ledger。
//  2) Permission：A assert 挂起；B 回复 once；A 等待者唤醒；A 关闭后 durable pending
//     保留，B 恢复并拒绝。
import { describe, expect, test } from "bun:test"
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect"
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
import { HitlRequestTable } from "@opencode/core/hitl/sql"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Session } from "@opencode/core/session"
import { SessionAgents } from "@opencode/core/session/agents"
import { SessionStore } from "@opencode/core/session/store"
import { SessionTable } from "@opencode/core/session/sql"
import { Location } from "@opencode/core/location"
import { location } from "./fixture/location"

const url = process.env.OPENCODE_DATABASE_URL
const describePg = url ? describe : describe.skip

const guard = () => {
  if (!url || !new URL(url).pathname.endsWith("/opencode-v2-test")) {
    throw new Error("HITL ledger 测试必须使用专用 opencode-v2-test 数据库")
  }
}

const hitlNodes = () =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      Bus.node,
      SessionStore.node,
      PermissionSaved.node,
      SessionPermissionApproval.node,
      Agent.node,
      SessionAgents.node,
      Form.node,
      Permission.node,
    ]),
    [
      Location.node.replace(
        Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make("/project") }))),
      ),
    ],
  )

interface Hitl {
  readonly database: Database.Service["Service"]
  readonly forms: Form.Interface
  readonly permissions: Permission.Interface
  readonly agents: Agent.Interface
}

const buildHitl = (scope: Scope.Closeable) =>
  Effect.gen(function* () {
    const context = yield* Layer.build(Layer.fresh(hitlNodes()))
    return {
      database: Context.get(context, Database.Service),
      forms: Context.get(context, Form.Service),
      permissions: Context.get(context, Permission.Service),
      agents: Context.get(context, Agent.Service),
    } satisfies Hitl
  })

const seed = (hitl: Hitl, sessionID: Session.ID) =>
  Effect.gen(function* () {
    yield* hitl.database.db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    yield* hitl.database.db
      .insert(SessionTable)
      .values({
        id: sessionID,
        project_id: Project.ID.global,
        slug: sessionID,
        directory: "/project",
        title: sessionID,
        version: "test",
        agent: "test",
        permission: [],
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  })

/** Without configured rules the default agent denies everything; empty rules make every request ask. */
const allowAsk = (hitl: Hitl) =>
  hitl.agents.transform((editor) =>
    editor.update(Agent.ID.make("test"), (agent) => {
      agent.permissions = []
    }),
  )

const removeSession = (hitl: Hitl, sessionID: Session.ID) =>
  hitl.database.db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)

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

const ledgerRow = (hitl: Hitl, id: string) =>
  hitl.database.db.select().from(HitlRequestTable).where(eq(HitlRequestTable.id, id)).get().pipe(Effect.orDie)

describePg("HITL ledger: Form", () => {
  test("A 挂起，B 可见并回复，A 轮询唤醒；重复回复冲突", async () => {
    guard()
    process.env["OPENCODE_HITL_POLL_MS"] = "50"
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const outer = yield* Scope.make()
            yield* Effect.addFinalizer(() => Scope.close(outer, Exit.void))
            const a = yield* buildHitl(outer)
            const b = yield* buildHitl(outer)
            const sessionID = Session.ID.create()
            yield* seed(a, sessionID)
            yield* Effect.addFinalizer(() => removeSession(a, sessionID))

            const fiber = yield* a.forms
              .ask({
                sessionID,
                title: "Pick one",
                fields: [
                  {
                    key: "choice",
                    type: "string",
                    required: true,
                    options: [
                      { value: "a", label: "A" },
                      { value: "b", label: "B" },
                    ],
                  },
                ],
              })
              .pipe(Effect.forkIn(outer))
            const pendingOnB = yield* waitFor(
              b.forms.list({ sessionID }),
              (forms) => forms.length === 1,
              "B sees pending form",
            )
            const formID = pendingOnB[0]!.id
            expect(yield* b.forms.state(formID)).toEqual({ status: "pending" })
            const row = yield* ledgerRow(b, formID)
            expect(row?.decision).toBe("pending")

            yield* b.forms.reply({ id: formID, answer: { choice: "a" } })
            const outcome = yield* Fiber.join(fiber)
            expect(outcome).toEqual({ status: "answered", answer: { choice: "a" } })

            const settled = yield* a.forms.reply({ id: formID, answer: { choice: "b" } }).pipe(Effect.flip)
            expect(settled._tag).toBe("Form.AlreadySettledError")
            const remoteSettled = yield* b.forms.reply({ id: formID, answer: { choice: "b" } }).pipe(Effect.flip)
            expect(remoteSettled._tag).toBe("Form.AlreadySettledError")
            expect(yield* b.forms.state(formID)).toEqual({ status: "answered", answer: { choice: "a" } })
            expect(yield* b.forms.list({ sessionID })).toEqual([])
          }),
        ),
      )
    } finally {
      delete process.env["OPENCODE_HITL_POLL_MS"]
    }
  }, 30_000)

  test("重启（重建服务图）后 pending 恢复并仍可回复", async () => {
    guard()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const probe = yield* buildHitl(yield* Scope.make())
          const sessionID = Session.ID.create()
          yield* seed(probe, sessionID)
          yield* Effect.addFinalizer(() => removeSession(probe, sessionID))

          const first = yield* Scope.make()
          const a = yield* buildHitl(first)
          const form = yield* a.forms.create({
            sessionID,
            title: "Restart",
            fields: [{ key: "note", type: "string", required: true }],
          })
          yield* Scope.close(first, Exit.void)
          const row = yield* ledgerRow(probe, form.id)
          expect(row?.decision).toBe("pending")

          const second = yield* Scope.make()
          const b = yield* buildHitl(second)
          const restored = yield* b.forms.list({ sessionID })
          expect(restored.map((item) => item.id)).toEqual([form.id])
          yield* b.forms.reply({ id: form.id, answer: { note: "after restart" } })
          expect(yield* b.forms.state(form.id)).toEqual({ status: "answered", answer: { note: "after restart" } })
          yield* Scope.close(second, Exit.void)
        }),
      ),
    )
  }, 30_000)

  test("global MCP 表单不写 ledger", async () => {
    guard()
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const scope = yield* Scope.make()
          const a = yield* buildHitl(scope)
          const form = yield* a.forms.create({
            sessionID: "global",
            title: "MCP input",
            fields: [{ key: "name", type: "string", required: true }],
          })
          const row = yield* ledgerRow(a, form.id)
          expect(row).toBeUndefined()
          yield* Scope.close(scope, Exit.void)
        }),
      ),
    )
  }, 30_000)
})

describePg("HITL ledger: Permission", () => {
  test("A assert 挂起，B 回复 once 唤醒 A；A 关闭后 durable pending 由 B 恢复并拒绝", async () => {
    guard()
    process.env["OPENCODE_HITL_POLL_MS"] = "50"
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const probe = yield* buildHitl(yield* Scope.make())
            const sessionID = Session.ID.create()
            yield* seed(probe, sessionID)
            yield* Effect.addFinalizer(() => removeSession(probe, sessionID))

            const outer = yield* Scope.make()
            const a = yield* buildHitl(outer)
            const b = yield* buildHitl(outer)
            yield* allowAsk(a)
            yield* allowAsk(b)

            const first = Permission.ID.create()
            const fiber = yield* a.permissions
              .assert({ id: first, sessionID, action: "shell", resources: ["pwd"] })
              .pipe(Effect.exit)
              .pipe(Effect.forkIn(outer))
            const pending = yield* waitFor(
              b.permissions.forSession(sessionID),
              (requests) => requests.length === 1,
              "B sees pending permission",
            )
            expect(pending[0]!.id).toBe(first)
            yield* b.permissions.reply({ requestID: first, reply: "once" })
            const outcome = yield* Fiber.join(fiber)
            expect(Exit.isSuccess(outcome)).toBe(true)
            expect((yield* ledgerRow(probe, first))?.decision).toBe("approved")

            // 第二个请求：A 挂起后整体关闭（模拟进程死亡，close 保留 durable pending）。
            const secondScope = yield* Scope.make()
            const a2 = yield* buildHitl(secondScope)
            yield* allowAsk(a2)
            const second = Permission.ID.create()
            yield* a2.permissions
              .assert({ id: second, sessionID, action: "shell", resources: ["ls"] })
              .pipe(Effect.ignore, Effect.forkIn(secondScope))
            yield* waitFor(ledgerRow(probe, second), (row) => row?.decision === "pending", "A2 pending registered")
            yield* Scope.close(secondScope, Exit.interrupt(undefined))
            expect((yield* ledgerRow(probe, second))?.decision).toBe("pending")

            const restored = yield* b.permissions.forSession(sessionID)
            expect(restored.map((request) => request.id)).toEqual([second])
            yield* b.permissions.reply({ requestID: second, reply: "reject", message: "not needed" })
            expect((yield* ledgerRow(probe, second))?.decision).toBe("rejected")
            yield* Scope.close(outer, Exit.void)
          }),
        ),
      )
    } finally {
      delete process.env["OPENCODE_HITL_POLL_MS"]
    }
  }, 30_000)
})
