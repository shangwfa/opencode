import { describe, expect, test, beforeEach } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionTool } from "../../src/tool/session-tool"
import { SessionID } from "../../src/session/schema"

const SESSION = SessionID.make("ses_test_tool_001")
const SESSION_OTHER = SessionID.make("ses_test_tool_002")

const store = new Map<string, SessionTool.Row[]>()
let nextId = 1

const memoryLayer = Layer.effect(
  SessionTool.Service,
  Effect.gen(function* () {
    return SessionTool.Service.of({
      list: (sessionID) => Effect.succeed(store.get(sessionID) ?? []),
      get: (sessionID, name) =>
        Effect.succeed((store.get(sessionID) ?? []).find((r) => r.name === name)),
      upsert: (sessionID, input) =>
        Effect.sync(() => {
          const rows = [...(store.get(sessionID) ?? [])]
          const idx = rows.findIndex((r) => r.name === input.name)
          const row: SessionTool.Row = {
            id: `mem-${nextId++}`,
            session_id: sessionID as string,
            name: input.name,
            description: input.description,
            code: input.code,
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

function run<A>(effect: Effect.Effect<A, any, SessionTool.Service>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(memoryLayer)))
}

function svc(): Effect.Effect<SessionTool.Interface, never, SessionTool.Service> {
  return Effect.gen(function* () {
    return yield* SessionTool.Service
  })
}

const SAMPLE_CODE = `import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Echo input",
  args: { message: tool.schema.string().describe("Message to echo") },
  async execute(args) {
    return { title: "Echo", output: args.message }
  },
})`

describe("SessionTool noopLayer", () => {
  test("list returns empty array", async () => {
    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION)
      }).pipe(Effect.provide(SessionTool.noopLayer)),
    )
    expect(list).toEqual([])
  })

  test("get returns undefined", async () => {
    const result = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.get(SESSION, "anything")
      }).pipe(Effect.provide(SessionTool.noopLayer)),
    )
    expect(result).toBeUndefined()
  })

  test("upsert returns constructed row without persisting", async () => {
    const row = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.upsert(SESSION, {
          name: "noop-tool",
          description: "Test",
          code: SAMPLE_CODE,
        })
      }).pipe(Effect.provide(SessionTool.noopLayer)),
    )
    expect(row.name).toBe("noop-tool")
    expect(row.description).toBe("Test")
    expect(row.code).toBe(SAMPLE_CODE)
    expect(row.id).toMatch(/^stl_/)

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION)
      }).pipe(Effect.provide(SessionTool.noopLayer)),
    )
    expect(list).toEqual([])
  })

  test("remove and removeAll do not throw", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        yield* s.remove(SESSION, "anything")
        yield* s.removeAll(SESSION)
      }).pipe(Effect.provide(SessionTool.noopLayer)),
    )
  })
})

describe("SessionTool memoryLayer CRUD", () => {
  test("upsert and list", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        yield* s.upsert(SESSION, {
          name: "db-query",
          description: "Query database",
          code: SAMPLE_CODE,
        })
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION)
      }),
    )
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe("db-query")
    expect(list[0].description).toBe("Query database")
  })

  test("upsert same name updates existing", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        yield* s.upsert(SESSION, { name: "upsert-test", description: "v1", code: "// v1" })
        yield* s.upsert(SESSION, { name: "upsert-test", description: "v2", code: "// v2" })
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION)
      }),
    )
    const found = list.find((r) => r.name === "upsert-test")
    expect(found).toBeDefined()
    expect(found!.description).toBe("v2")
    expect(found!.code).toBe("// v2")
    expect(list.filter((r) => r.name === "upsert-test")).toHaveLength(1)
  })

  test("get by name", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        yield* s.upsert(SESSION, { name: "findable", description: "Find me", code: "// code" })
      }),
    )

    const row = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.get(SESSION, "findable")
      }),
    )
    expect(row).toBeDefined()
    expect(row!.name).toBe("findable")

    const missing = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.get(SESSION, "nonexistent")
      }),
    )
    expect(missing).toBeUndefined()
  })

  test("remove by name", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        yield* s.upsert(SESSION, { name: "to-remove", description: "Remove", code: "// code" })
        yield* s.upsert(SESSION, { name: "keep", description: "Keep", code: "// code" })
        yield* s.remove(SESSION, "to-remove")
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION)
      }),
    )
    expect(list.find((r) => r.name === "to-remove")).toBeUndefined()
    expect(list.find((r) => r.name === "keep")).toBeDefined()
  })

  test("removeAll clears all", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        yield* s.upsert(SESSION, { name: "a", description: "A", code: "// a" })
        yield* s.upsert(SESSION, { name: "b", description: "B", code: "// b" })
        yield* s.removeAll(SESSION)
      }),
    )

    const list = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION)
      }),
    )
    expect(list).toEqual([])
  })

  test("tools are isolated between sessions", async () => {
    await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        yield* s.upsert(SESSION, { name: "only-a", description: "A", code: "// a" })
        yield* s.upsert(SESSION_OTHER, { name: "only-b", description: "B", code: "// b" })
      }),
    )

    const listA = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION)
      }),
    )
    const listB = await run(
      Effect.gen(function* () {
        const s = yield* SessionTool.Service
        return yield* s.list(SESSION_OTHER)
      }),
    )
    expect(listA.map((r) => r.name)).toContain("only-a")
    expect(listA.map((r) => r.name)).not.toContain("only-b")
    expect(listB.map((r) => r.name)).toContain("only-b")
    expect(listB.map((r) => r.name)).not.toContain("only-a")
  })
})

describe("SessionTool.Row schema", () => {
  test("Row.parse validates a well-formed row", () => {
    const row = SessionTool.Row.parse({
      id: "stl_abc",
      session_id: "ses_123",
      name: "test-tool",
      description: "A test tool",
      code: "export default {}",
      time_created: Date.now(),
      time_updated: Date.now(),
    })
    expect(row.id).toBe("stl_abc")
    expect(row.name).toBe("test-tool")
  })

  test("Row.parse rejects missing required fields", () => {
    expect(() => SessionTool.Row.parse({ id: "x" })).toThrow()
  })
})
