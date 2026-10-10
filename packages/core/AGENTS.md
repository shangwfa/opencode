# Core Package Guide

`@opencode/core` owns the runtime services behind the HTTP API: sessions, the durable event bus, instructions, tools, database access. Keep contracts in `@opencode/schema`, wire shapes in `@opencode/protocol`, and host wiring in `@opencode/server`.

## Session Event Bus

- Durable events use a process-local `KeyedMutex` (`durableLocks` in `src/bus.ts`) and, on PostgreSQL, a transaction-scoped aggregate advisory lock via `Database.lockAggregate`. Single/batch publication, replay, removal and log-owner changes share that PG lock. Projectors run in the transaction after locking, including when the aggregate sequence row does not yet exist. This serializes cooperating Bus writers across instances; it is not Session execution ownership/fencing and does not protect direct writes that bypass the Bus.
- Session execution ownership on PostgreSQL is the `session_execution_lease` table (`src/session/execution-lease.ts`): admission acquires before the first drain, a renewal fiber extends it, and terminal settlement releases it inside the event commit so a stale owner's terminal rolls back. SQLite runs without leases and keeps the process-local semantics; tests override TTL/renewal via `OPENCODE_EXECUTION_LEASE_TTL_MS` / `OPENCODE_EXECUTION_LEASE_RENEW_MS`.
- `src/instance.ts` is the Location-scoped service graph; add `makeLocationNode` services there. Global (process-wide) nodes belong to the server's `applicationServiceNodes`.

## Instruction Sources

- `InstructionEntry` is the canonical neighbor for a session-local instruction overlay: wire contract in `@opencode/schema/<domain>`, service in `src/session/<domain>.ts`, a `makeLocationNode` entry in `src/instance.ts`, a 256 KiB UTF-8 cap returning a `Schema.TaggedError` with `httpApiStatus: 413`, and non-inheritance expressed as a `fork(values)` filter rather than copying the row.
- `SessionContext.select` composes sources with `Instructions.combine`; `src/session/context.ts` currently lists the session AGENTS.md source first, ahead of builtins and discovery. Insert new sources there deliberately.
