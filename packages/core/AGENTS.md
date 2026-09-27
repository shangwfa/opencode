# Core Package Guide

`@opencode/core` owns the runtime services behind the HTTP API: sessions, the durable event bus, instructions, tools, database access. Keep contracts in `@opencode/schema`, wire shapes in `@opencode/protocol`, and host wiring in `@opencode/server`.

## Session Event Bus

- Durable events are serialized per aggregate by a process-local `KeyedMutex` (`durableLocks` in `src/bus.ts`); projectors run inside that lock's transaction. `session.deleted` and `session.inbox.enqueued` share the `sessionID` aggregate, so a delete cannot interleave with prompt admission **in one process**. This does not hold across server instances sharing one PostgreSQL (no advisory lock) — do not "fix" a cross-instance race by relying on this lock.
- `src/instance.ts` is the Location-scoped service graph; add `makeLocationNode` services there. Global (process-wide) nodes belong to the server's `applicationServiceNodes`.

## Instruction Sources

- `InstructionEntry` is the canonical neighbor for a session-local instruction overlay: wire contract in `@opencode/schema/<domain>`, service in `src/session/<domain>.ts`, a `makeLocationNode` entry in `src/instance.ts`, a 256 KiB UTF-8 cap returning a `Schema.TaggedError` with `httpApiStatus: 413`, and non-inheritance expressed as a `fork(values)` filter rather than copying the row.
- `SessionContext.select` composes sources with `Instructions.combine`; `src/session/context.ts` currently lists the session AGENTS.md source first, ahead of builtins and discovery. Insert new sources there deliberately.
