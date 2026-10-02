import { expect } from "bun:test"
import { Effect, Exit } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionResourceOwner } from "@opencode/core/session/resource-owner"
import { it } from "../lib/effect"

const root = Session.ID.create()
const child = Session.ID.create()
const nested = Session.ID.create()
const fork = Session.ID.create()
const relation = (
  id: Session.ID,
  input: Partial<Omit<SessionResourceOwner.Relation, "id">> = {},
): SessionResourceOwner.Relation => ({ id, projectID: "project", directory: "/workspace", ...input })

const resolve = (id: Session.ID, rows: SessionResourceOwner.Relation[]) =>
  SessionResourceOwner.resolve(id, (key) => Effect.succeed(rows.find((row) => row.id === key)))

it.effect("root, internal child and nested child share a resource owner", () =>
  Effect.gen(function* () {
    const rows = [relation(root), relation(child, { parentID: root }), relation(nested, { parentID: child })]
    for (const id of [root, child, nested]) expect(yield* resolve(id, rows)).toBe(root)
  }),
)

it.effect("a history fork is its own domain and its internal child shares the fork", () =>
  Effect.gen(function* () {
    const rows = [
      relation(root),
      relation(fork, { parentID: root, forkSessionID: root }),
      relation(child, { parentID: fork }),
    ]
    expect(yield* resolve(fork, rows)).toBe(fork)
    expect(yield* resolve(child, rows)).toBe(fork)
  }),
)

it.effect("owner traversal fails for a missing parent instead of using child-private definitions", () =>
  resolve(child, [relation(child, { parentID: root })]).pipe(
    Effect.exit,
    Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
  ),
)

it.effect("owner traversal rejects cycles", () =>
  resolve(child, [relation(child, { parentID: root }), relation(root, { parentID: child })]).pipe(
    Effect.exit,
    Effect.map((exit) => expect(Exit.isFailure(exit)).toBe(true)),
  ),
)

it.effect("a deleted root keeps the empty-read CRUD identity", () =>
  resolve(root, []).pipe(Effect.map((owner) => expect(owner).toBe(root))),
)

it.effect("owner traversal bounds unexpectedly deep relations", () =>
  Effect.gen(function* () {
    const ids = Array.from({ length: 65 }, () => Session.ID.create())
    const first = ids[0]
    if (!first) return yield* Effect.die(new Error("Missing test root"))
    const rows = ids.map((id, index) => relation(id, { parentID: ids[index + 1] }))
    const result = yield* resolve(first, rows).pipe(Effect.exit)
    expect(Exit.isFailure(result)).toBe(true)
  }),
)

it.effect("owner traversal rejects project, application, directory and workspace crossings", () =>
  Effect.gen(function* () {
    for (const mismatch of [
      { projectID: "other-project" },
      { appId: "other-app" },
      { directory: "/other-workspace" },
      { workspaceID: "other-workspace" },
    ]) {
      const exit = yield* resolve(child, [relation(child, { parentID: root }), relation(root, mismatch)]).pipe(
        Effect.exit,
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }
  }),
)
