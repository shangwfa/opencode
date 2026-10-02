import { eq } from "drizzle-orm"
import { DateTime, Effect } from "effect"
import { Database } from "@opencode/core/database/database"
import { Project } from "@opencode/core/project"
import { ProjectTable } from "@opencode/core/project/sql"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { Location } from "@opencode/schema/location"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"

type Db = Database.Interface["db"]
type SessionRow = typeof SessionTable.$inferSelect

/** The in-memory shape services such as `SessionAgents.select` take, built from a stored row. */
export const sessionInfo = (row: SessionRow): Session.Info =>
  Session.Info.make({
    id: Session.ID.make(row.id),
    projectID: Project.ID.global,
    cost: Money.USD.zero,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
    location: Location.Ref.make({ directory: AbsolutePath.make(row.directory) }),
  })

/**
 * Many Session-scoped PostgreSQL suites only need *a* Session to hang rows off. Reuse whatever the
 * database already has (so a shared dev database keeps working), and provision — then remove — our
 * own Session when the database is empty, so the same suite also runs against a clean test database.
 *
 * Rows such as `session_agents` cascade from their owning Session, so a placeholder that is never
 * persisted would fail the insert instead of exercising the code under test.
 */
export const ensureSession = (
  db: Db,
): Effect.Effect<{ readonly session: SessionRow; readonly created: boolean }> =>
  Effect.gen(function* () {
    const [existing] = yield* db.select().from(SessionTable).limit(1).all().pipe(Effect.orDie)
    if (existing) return { session: existing, created: false }
    yield* db
      .insert(ProjectTable)
      .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const now = Date.now()
    const id = Session.ID.make(`ses_pg_fixture_${crypto.randomUUID().replaceAll("-", "")}`)
    yield* db
      .insert(SessionTable)
      .values({
        id,
        project_id: Project.ID.global,
        slug: id,
        directory: "/project",
        title: id,
        version: "test",
        time_created: now,
        time_updated: now,
      })
      .run()
      .pipe(Effect.orDie)
    const [session] = yield* db.select().from(SessionTable).where(eq(SessionTable.id, id)).all().pipe(Effect.orDie)
    return { session: session!, created: true }
  })

/** Removes the placeholder only when `ensureSession` had to create it. */
export const removeIfCreated = (db: Db, session: SessionRow, created: boolean): Effect.Effect<void> =>
  created ? db.delete(SessionTable).where(eq(SessionTable.id, session.id)).run().pipe(Effect.orDie) : Effect.void
