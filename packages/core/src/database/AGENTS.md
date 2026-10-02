# Core Database

SQLite is the default schema authoring path; PostgreSQL is served by translating the SQLite DDL/SQL in `pg.ts`.

- A schema change must update, together: `sql.ts`, a migration under `migration/`, `migration.gen.ts`, `schema.gen.ts`, and the `schema.json` snapshot. Verify from `packages/core` with `bun run migration -- --check` ("No schema changes, nothing to migrate" means aligned).
- To revise an already-generated but uncommitted migration, hand-edit the migration, `schema.gen.ts`, and `schema.json` together. Re-running `bun run migration` produces a *new* migration instead of amending the existing one.
- `pg-schema.sql` is dumped from the SQLite migration chain with `bun dump-pg-schema.ts` (from `packages/core`, writes `src/database/pg-schema.sql`; no `OPENCODE_DATABASE_URL` needed). Keep it consistent when hand-editing an uncommitted migration.
- Drizzle `sql\`max(a, b)\`` is rewritten to PostgreSQL `GREATEST` by `pg.ts` and is valid SQLite scalar `max(a, b)`. Use it for strictly-increasing stamps so same-millisecond writes still advance (see `bus.ts` seq and `session/projector.ts` `time_idle`).
- PostgreSQL-backed tests skip silently unless `OPENCODE_DATABASE_URL` is set: `OPENCODE_DATABASE_URL=postgresql://local@127.0.0.1:5432/opencode-v2-test bun test --timeout 60000 <file>`.
- Point `OPENCODE_DATABASE_URL` at a **dedicated** test database (`opencode-v2-test`), never the shared dev database (`opencode-v2-up`). Recovery/claim suites drive the **global** restart sweep (`SessionStore.listSuspended`, `SessionRestart.resumeSuspendedSessions`) over the whole database, so a shared database makes them read real suspended Sessions and assert against them. Provision it with `docs/test-cases/provision-pg-test-db.sh`; migrations run automatically when the layer builds, so no manual schema import is needed.
