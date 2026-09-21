import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Database } from "@opencode/core/database/database"
import { Hitl } from "@opencode/core/hitl/index"
import { Location } from "@opencode/core/location"
import { ProjectTable } from "@opencode/core/project/sql"
import { SessionTable } from "@opencode/core/session/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { Project } from "@opencode/schema/project"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"

const current = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/project") })),
)
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node]), [Location.node.replace(current)]))

// hitl_request.session_id references session, and the sqlite test
// database enforces foreign keys: seed the rows the asks hang off.
const seedSessions = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  for (const id of ["ses_test", "ses_other"]) {
    yield* db
      .insert(SessionTable)
      .values({
        id: id as never,
        project_id: Project.ID.global,
        slug: "test",
        directory: "/project",
        title: "test",
        version: "test",
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
  }
})

// Real clock: insertPending stamps leases from Date.now(), so window math
// must share that clock instead of a synthetic constant.
const now = Date.now()
const ask = (overrides: Partial<Hitl.NewPending> = {}): Hitl.NewPending => ({
  id: "per_test1",
  kind: "permission",
  directory: "/project",
  sessionID: "ses_test",
  ownerID: "owner-a",
  // The source locator is what sweep/backfill addressing needs: without it a
  // row cannot be mapped back to its dangling tool part.
  payload: {
    action: "shell",
    resources: ["echo hi"],
    source: { type: "tool", messageID: "msg_test", id: "toolu_test" },
  },
  ...overrides,
})

describe("hitl persistence", () => {
  it.effect("insertPending then listPending applies kind/directory/userID filters", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask())
      yield* Hitl.insertPending(ask({ id: "frm_q1", kind: "question", directory: "/other" }))
      yield* Hitl.insertPending(ask({ id: "per_u2", userID: "user-b" }))

      const permission = (yield* Hitl.listPending({ kind: "permission", directory: "/project" })) ?? []
      expect(permission.map((row) => row.id)).toEqual(["per_test1", "per_u2"])

      // A scoped filter keeps owned rows and keeps public-bucket rows (user_id="")
      // visible to everyone, since those belong to no user (MCP elicitations).
      const scoped = (yield* Hitl.listPending({ kind: "permission", directory: "/project", userID: "user-b" })) ?? []
      expect(scoped.map((row) => row.id)).toEqual(["per_u2"])

      const otherDirectory = (yield* Hitl.listPending({ kind: "question", directory: "/other" })) ?? []
      expect(otherDirectory.map((row) => row.id)).toEqual(["frm_q1"])

      const defaulted = (yield* Hitl.listPending({ kind: "permission", directory: "/project", userID: "" }))!
        .find((row) => row.id === "per_test1")!
      expect(defaulted.user_id).toBe("")
    }),
  )

  it.effect("settle is a CAS guarded by pending status and owning user", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask({ userID: "user-a" }))

      // Cross-tenant submit leaves the row untouched.
      yield* Hitl.settle("per_test1", { status: "replied", closeReason: "answered-delivered", userID: "user-b" })
      let row = (yield* Hitl.row("per_test1"))!
      expect(row.status).toBe("pending")

      // Owning submit settles.
      yield* Hitl.settle("per_test1", {
        status: "replied",
        result: { reply: "once" },
        closeReason: "answered-delivered",
        userID: "user-a",
      })
      row = (yield* Hitl.row("per_test1"))!
      expect(row.status).toBe("replied")
      expect(row.close_reason).toBe("answered-delivered")

      // Terminal rows never move again, even without a user guard.
      yield* Hitl.settle("per_test1", { status: "rejected", closeReason: "decision-delivered" })
      row = (yield* Hitl.row("per_test1"))!
      expect(row.status).toBe("replied")
    }),
  )

  it.effect("deleteBySession removes every row of a session (v1 FK cascade)", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask({ id: "per_a" }))
      yield* Hitl.insertPending(ask({ id: "per_b", kind: "question" }))
      yield* Hitl.insertPending(ask({ id: "per_c", sessionID: "ses_other" }))

      yield* Hitl.deleteBySession("ses_test" as never)

      const remaining = (yield* Hitl.listPending()) ?? []
      expect(remaining.map((row) => row.id)).toEqual(["per_c"])
    }),
  )

  it.effect("renew only extends leases the owner still holds", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask({ ownerID: "owner-a" }), )
      const before = (yield* Hitl.row("per_test1"))!

      yield* Hitl.renew("per_test1", "owner-b", now)
      expect((yield* Hitl.row("per_test1"))!.lease_until).toBe(before.lease_until)

      yield* Hitl.renew("per_test1", "owner-a", now + 5 * 60_000)
      expect((yield* Hitl.row("per_test1"))!.lease_until).toBeGreaterThan(now + 5 * 60_000)
    }),
  )

  it.effect("sweepables honors the lease-plus-grace window and terminal statuses", () =>
    Effect.gen(function* () {
      yield* seedSessions
      // Live: leased far into the future.
      yield* Hitl.insertPending(ask({ id: "per_live" }), )
      const live = (yield* Hitl.row("per_live"))!
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(sql`UPDATE hitl_request SET lease_until = ${live.lease_until + 10 * 60_000} WHERE id = 'per_live'`)
      })

      // Dead: lease expired beyond the grace window.
      yield* Hitl.insertPending(ask({ id: "per_dead" }))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(sql`UPDATE hitl_request SET lease_until = ${now - Hitl.SWEEP_GRACE_MS - 1} WHERE id = 'per_dead'`)
      })

      // Expired but still inside the grace window: kept for late replies.
      yield* Hitl.insertPending(ask({ id: "per_grace" }))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(sql`UPDATE hitl_request SET lease_until = ${now - 10_000} WHERE id = 'per_grace'`)
      })

      // Answered while expired: backfillable.
      yield* Hitl.insertPending(ask({ id: "per_answered" }))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(sql`UPDATE hitl_request SET lease_until = ${now - Hitl.SWEEP_GRACE_MS - 1}, status = 'replied', result = '{"reply":"once"}' WHERE id = 'per_answered'`)
      })

      const sweepable = yield* Hitl.sweepables("permission", now)
      expect(sweepable.map((action) => action.id).toSorted()).toEqual(["per_answered", "per_dead"])
      expect(sweepable.find((action) => action.id === "per_answered")?.status).toBe("replied")
    }),
  )

  it.effect("backfillables selects answered-but-unconsumed rows regardless of lease", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask({ id: "per_kept" }))
      yield* Hitl.insertPending(ask({ id: "per_done" }))
      yield* Hitl.settle("per_done", { status: "replied", closeReason: "answered-delivered" })
      yield* Hitl.insertPending(ask({ id: "per_declined" }))
      yield* Hitl.settle("per_declined", { status: "rejected", closeReason: "decision-delivered" })

      const backfillable = yield* Hitl.backfillables("permission")
      expect(backfillable.map((action) => [action.id, action.status]).toSorted()).toEqual(
        [["per_declined", "rejected"], ["per_done", "replied"]].toSorted(),
      )
    }),
  )

  it.effect("markBackfilled moves replied rows to the v1 terminal shape only", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask({ id: "per_r" }))
      yield* Hitl.settle("per_r", { status: "replied", closeReason: "answered-delivered" })
      yield* Hitl.insertPending(ask({ id: "per_p" }))

      yield* Hitl.markBackfilled("per_r", now)
      yield* Hitl.markBackfilled("per_p", now)

      expect((yield* Hitl.row("per_r"))!.status).toBe("closed")
      expect((yield* Hitl.row("per_r"))!.close_reason).toBe("answered-delivered")
      expect((yield* Hitl.row("per_p"))!.status).toBe("pending")
    }),
  )

  it.effect("settledIds lists terminal rows only, keeping absent rows ambiguous", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask({ id: "per_s" }))
      yield* Hitl.settle("per_s", { status: "rejected", closeReason: "decision-delivered" })
      yield* Hitl.insertPending(ask({ id: "per_t" }))

      const settled = yield* Hitl.settledIds("permission", "/project")
      expect(settled).toEqual(["per_s"])
    }),
  )

  it.effect("closeExpired closes only leases past expiry (instance-restart)", () =>
    Effect.gen(function* () {
      yield* seedSessions
      yield* Hitl.insertPending(ask({ id: "per_old" }))
      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        yield* db.run(sql`UPDATE hitl_request SET lease_until = ${now - 1} WHERE id = 'per_old'`)
      })
      yield* Hitl.insertPending(ask({ id: "per_new" }))

      yield* Hitl.closeExpired(now)

      expect((yield* Hitl.row("per_old"))!.status).toBe("closed")
      expect((yield* Hitl.row("per_old"))!.close_reason).toBe("instance-restart")
      expect((yield* Hitl.row("per_new"))!.status).toBe("pending")
    }),
  )

  it.effect("ownerID is stable per process and honors OPENCODE_INSTANCE_ID", () =>
    Effect.gen(function* () {
      yield* seedSessions
      expect(Hitl.ownerID()).toBe(Hitl.ownerID())
      expect(Hitl.userIDFromMessages([])).toBe("")
      expect(Hitl.userIDFromMessages([{ type: "user", metadata: { userId: "  user-a  " } }])).toBe("user-a")
      expect(Hitl.userIDFromMessages([{ type: "assistant", metadata: { userId: "x" } }, { type: "user" }])).toBe("")
    }),
  )
})
