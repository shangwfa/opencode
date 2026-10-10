import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { SessionPermissionApproval } from "@opencode/core/permission/session-approval"
import { Project } from "@opencode/schema/project"
import { Session } from "@opencode/schema/session"
import { AbsolutePath } from "@opencode/schema/schema"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionTable } from "@opencode/core/session/sql"

const url = process.env.OPENCODE_DATABASE_URL
const describePg = url ? describe : describe.skip
const nodes = () => AppNodeBuilder.build(LayerNode.group([Database.node, SessionPermissionApproval.node]))

describePg("Session approvals PostgreSQL 持久化", () => {
  test("新实例可读取，跨连接添加幂等，撤销/Session删除在所有实例可见", async () => {
    if (!url || !new URL(url).pathname.endsWith("/opencode-v2-test")) {
      throw new Error("必须使用专用 opencode-v2-test 数据库")
    }
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const first = yield* Layer.build(Layer.fresh(nodes()))
          const { db, dialect } = Context.get(first, Database.Service)
          expect(dialect).toBe("postgres")
          const a = Context.get(first, SessionPermissionApproval.Service)
          const projectID = Project.ID.make(`hitl-approval-${crypto.randomUUID()}`)
          const sessionID = Session.ID.create()
          const otherID = Session.ID.create()
          yield* db
            .insert(ProjectTable)
            .values({ id: projectID, worktree: AbsolutePath.make("/workspace"), sandboxes: [] })
            .run()
          yield* Effect.addFinalizer(() =>
            db.delete(ProjectTable).where(eq(ProjectTable.id, projectID)).run().pipe(Effect.orDie),
          )
          yield* db
            .insert(SessionTable)
            .values(
              [sessionID, otherID].map((id) => ({
                id,
                project_id: projectID,
                slug: id,
                directory: "/workspace",
                title: "hitl-approval-pg",
                version: "test",
              })),
            )
            .run()
          yield* a.add({ sessionID, action: "shell", resources: ["pwd"] })
          // 构建新实例前已经完成写入，不借助共享内存传递审批。
          const second = yield* Layer.build(Layer.fresh(nodes()))
          const b = Context.get(second, SessionPermissionApproval.Service)
          const initial = yield* b.list(sessionID)
          expect(initial).toHaveLength(1)
          expect(yield* b.list(otherID)).toEqual([])
          yield* Effect.all(
            Array.from({ length: 12 }, (_, index) =>
              (index % 2 ? a : b).add({ sessionID, action: "shell", resources: ["pwd", "ls"] }),
            ),
            { concurrency: "unbounded", discard: true },
          )
          expect(yield* b.list(sessionID)).toHaveLength(2)
          const saved = initial[0]
          if (!saved) return yield* Effect.die("approval missing")
          yield* b.remove(otherID, saved.id)
          expect(yield* a.list(sessionID)).toHaveLength(2)
          yield* b.remove(sessionID, saved.id)
          expect((yield* a.list(sessionID)).map((row) => row.resource)).toEqual(["ls"])
          yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
          expect(yield* b.list(sessionID)).toEqual([])
        }),
      ),
    )
  }, 60_000)
})
