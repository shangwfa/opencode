import { describe, expect, test, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionCommand } from "../../src/command/session-command"
import { SessionID } from "../../src/session/schema"

const SESSION = SessionID.make("ses_test_cmd_001")
const SESSION_OTHER = SessionID.make("ses_test_cmd_002")

const store = new Map<string, SessionCommand.Row[]>()
let nextId = 1

const memoryLayer = Layer.effect(
  SessionCommand.Service,
  Effect.gen(function* () {
    return SessionCommand.Service.of({
      list: (sessionID) => Effect.succeed(store.get(sessionID) ?? []),
      get: (sessionID, name) =>
        Effect.succeed((store.get(sessionID) ?? []).find((r) => r.name === name)),
      upsert: (sessionID, input) =>
        Effect.sync(() => {
          const rows = [...(store.get(sessionID) ?? [])]
          const idx = rows.findIndex((r) => r.name === input.name)
          const row: SessionCommand.Row = {
            id: `mem-${nextId++}`,
            session_id: sessionID as string,
            name: input.name,
            description: input.description ?? null,
            template: input.template,
            agent: input.agent ?? null,
            model: input.model ?? null,
            subtask: input.subtask ?? null,
            hints: [...(input.hints ?? [])],
            time_created: Date.now(),
            time_updated: Date.now(),
          }
          if (idx >= 0) rows[idx] = row
          else rows.push(row)
          store.set(sessionID, rows)
          return row
        }),
      remove: (sessionID, name) =>
        Effect.sync(() => {
          store.set(
            sessionID,
            (store.get(sessionID) ?? []).filter((r) => r.name !== name),
          )
        }),
      removeAll: (sessionID) =>
        Effect.sync(() => {
          store.set(sessionID, [])
        }),
    })
  }),
)

beforeEach(() => {
  store.clear()
  nextId = 1
})

function run<A>(effect: Effect.Effect<A, any, SessionCommand.Service>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(memoryLayer)))
}

const SAMPLE_TEMPLATE = `Run the full test suite with coverage report.

Focus on the failing tests: $ARGUMENTS`

describe("SessionCommand noopLayer", () => {
  test("list returns empty array", async () => {
    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION)
      }).pipe(Effect.provide(SessionCommand.noopLayer)),
    )
    expect(list).toEqual([])
  })

  test("get returns undefined", async () => {
    const result = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.get(SESSION, "anything")
      }).pipe(Effect.provide(SessionCommand.noopLayer)),
    )
    expect(result).toBeUndefined()
  })

  test("upsert returns constructed row without persisting", async () => {
    const row = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.upsert(SESSION, {
          name: "noop-command",
          description: "Test",
          template: SAMPLE_TEMPLATE,
        })
      }).pipe(Effect.provide(SessionCommand.noopLayer)),
    )
    expect(row.name).toBe("noop-command")
    expect(row.description).toBe("Test")
    expect(row.template).toBe(SAMPLE_TEMPLATE)
    expect(row.id).toMatch(/^scmd_/)

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION)
      }).pipe(Effect.provide(SessionCommand.noopLayer)),
    )
    expect(list).toEqual([])
  })

  test("remove and removeAll do not throw", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        yield* s.remove(SESSION, "anything")
        yield* s.removeAll(SESSION)
      }).pipe(Effect.provide(SessionCommand.noopLayer)),
    )
  })
})

describe("SessionCommand memoryLayer CRUD", () => {
  test("upsert and list", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        yield* s.upsert(SESSION, {
          name: "test",
          description: "Run tests",
          template: SAMPLE_TEMPLATE,
          agent: "build",
        })
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION)
      }),
    )
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("test")
    expect(list[0].description).toBe("Run tests")
    expect(list[0].agent).toBe("build")
  })

  test("upsert same name updates existing", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        yield* s.upsert(SESSION, { name: "upsert-test", description: "v1", template: "// v1" })
        yield* s.upsert(SESSION, { name: "upsert-test", description: "v2", template: "// v2" })
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION)
      }),
    )
    const found = list.find((r) => r.name === "upsert-test")
    expect(found).toBeDefined()
    expect(found!.description).toBe("v2")
    expect(found!.template).toBe("// v2")
    expect(list.filter((r) => r.name === "upsert-test")).toHaveLength(1)
  })

  test("get by name", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        yield* s.upsert(SESSION, { name: "findable", template: "Find me $1" })
      }),
    )

    const row = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.get(SESSION, "findable")
      }),
    )
    expect(row).toBeDefined()
    expect(row!.name).toBe("findable")

    const missing = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.get(SESSION, "nonexistent")
      }),
    )
    expect(missing).toBeUndefined()
  })

  test("remove by name", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        yield* s.upsert(SESSION, { name: "to-remove", template: "// remove" })
        yield* s.upsert(SESSION, { name: "keep", template: "// keep" })
        yield* s.remove(SESSION, "to-remove")
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION)
      }),
    )
    expect(list.find((r) => r.name === "to-remove")).toBeUndefined()
    expect(list.find((r) => r.name === "keep")).toBeDefined()
  })

  test("removeAll clears all", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        yield* s.upsert(SESSION, { name: "a", template: "// a" })
        yield* s.upsert(SESSION, { name: "b", template: "// b" })
        yield* s.removeAll(SESSION)
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION)
      }),
    )
    expect(list).toEqual([])
  })

  test("commands are isolated between sessions", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        yield* s.upsert(SESSION, { name: "only-a", template: "// a" })
        yield* s.upsert(SESSION_OTHER, { name: "only-b", template: "// b" })
      }),
    )

    const listA = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION)
      }),
    )
    const listB = await run(
      Effect.gen(function* () {
        const s = yield* SessionCommand.Service
        return yield* s.list(SESSION_OTHER)
      }),
    )
    expect(listA.map((r) => r.name)).toContain("only-a")
    expect(listA.map((r) => r.name)).not.toContain("only-b")
    expect(listB.map((r) => r.name)).toContain("only-b")
    expect(listB.map((r) => r.name)).not.toContain("only-a")
  })
})

describe("SessionCommand.Row schema", () => {
  test("Row.parse validates a well-formed row", () => {
    const row = SessionCommand.Row.parse({
      id: "scmd_abc",
      session_id: "ses_123",
      name: "test-command",
      description: "A test command",
      template: "Run tests for $ARGUMENTS",
      agent: "build",
      model: null,
      subtask: true,
      hints: ["$ARGUMENTS"],
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    expect(row.id).toBe("scmd_abc")
    expect(row.name).toBe("test-command")
    expect(row.hints).toEqual(["$ARGUMENTS"])
  })

  test("Row.parse rejects missing required fields", () => {
    expect(() => SessionCommand.Row.parse({ id: "x" })).toThrow()
  })
})
