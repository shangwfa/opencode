import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SessionMcp } from "../../src/mcp/session-mcp"
import { testEffect } from "../lib/effect"

const memoryLayer = Layer.effect(
  SessionMcp.Service,
  Effect.gen(function* () {
    const store = new Map<string, SessionMcp.Row[]>()
    let nextId = 1

    return SessionMcp.Service.of({
      list: (sessionID) => Effect.succeed(store.get(sessionID) ?? []),

      get: (sessionID, name) =>
        Effect.succeed((store.get(sessionID) ?? []).find((r) => r.name === name)),

      upsert: (sessionID, input) =>
        Effect.sync(() => {
          const rows = [...(store.get(sessionID) ?? [])]
          const idx = rows.findIndex((r) => r.name === input.name)
          const row: SessionMcp.Row = {
            id: `mem-${nextId++}`,
            session_id: sessionID as string,
            name: input.name,
            type: input.type,
            command: input.command ?? null,
            url: input.url ?? null,
            environment: input.environment ?? {},
            headers: input.headers ?? {},
            enabled: input.enabled ?? true,
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
          const rows = (store.get(sessionID) ?? []).filter((r) => r.name !== name)
          store.set(sessionID, rows)
        }),

      removeAll: (sessionID) =>
        Effect.sync(() => {
          store.set(sessionID, [])
        }),
    })
  }),
)

const it = testEffect(memoryLayer)

const SESSION = "ses_mcp_crud_01"

describe("SessionMcp list", () => {
  it.effect("returns empty array for new session", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      const list = yield* mcp.list(SESSION)
      expect(list).toEqual([])
    }),
  )
})

describe("SessionMcp upsert", () => {
  it.effect("creates a local mcp", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      const row = yield* mcp.upsert(SESSION, {
        name: "sandbox-shadcn",
        type: "local",
        command: ["npx", "shadcn@latest", "mcp"],
      })
      expect(row.name).toBe("sandbox-shadcn")
      expect(row.type).toBe("local")
      expect(row.command).toEqual(["npx", "shadcn@latest", "mcp"])
      expect(row.enabled).toBe(true)
    }),
  )

  it.effect("creates a remote mcp", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      const row = yield* mcp.upsert(SESSION, {
        name: "search-api",
        type: "remote",
        url: "https://search.example.com/mcp",
        headers: { Authorization: "Bearer tok" },
      })
      expect(row.name).toBe("search-api")
      expect(row.type).toBe("remote")
      expect(row.url).toBe("https://search.example.com/mcp")
      expect(row.headers).toEqual({ Authorization: "Bearer tok" })
    }),
  )

  it.effect("appears in list after create", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert(SESSION, {
        name: "listed-mcp",
        type: "local",
        command: ["echo", "hi"],
      })
      const list = yield* mcp.list(SESSION)
      expect(list.map((r) => r.name)).toContain("listed-mcp")
    }),
  )

  it.effect("upserts existing mcp (same name updates)", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert(SESSION, {
        name: "upsert-me",
        type: "local",
        command: ["cmd", "v1"],
      })
      yield* mcp.upsert(SESSION, {
        name: "upsert-me",
        type: "remote",
        url: "https://v2.example.com/mcp",
      })
      const list = yield* mcp.list(SESSION)
      const found = list.find((r) => r.name === "upsert-me")
      expect(found).toBeDefined()
      expect(found!.type).toBe("remote")
      expect(found!.url).toBe("https://v2.example.com/mcp")
      expect(found!.command).toBeNull()
      expect(list.filter((r) => r.name === "upsert-me")).toHaveLength(1)
    }),
  )

  it.effect("disabled mcp stores enabled:false", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      const row = yield* mcp.upsert(SESSION, {
        name: "off-mcp",
        type: "local",
        command: ["silent"],
        enabled: false,
      })
      expect(row.enabled).toBe(false)
    }),
  )

  it.effect("full config persists all fields", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      const row = yield* mcp.upsert(SESSION, {
        name: "full-mcp",
        type: "remote",
        url: "https://full.example.com/mcp",
        command: ["unused"],
        environment: { KEY_A: "a", KEY_B: "b" },
        headers: { "x-t": "tok" },
        enabled: true,
      })
      expect(row.name).toBe("full-mcp")
      expect(row.type).toBe("remote")
      expect(row.url).toBe("https://full.example.com/mcp")
      expect(row.environment).toEqual({ KEY_A: "a", KEY_B: "b" })
      expect(row.headers).toEqual({ "x-t": "tok" })
      expect(row.enabled).toBe(true)
    }),
  )
})

describe("SessionMcp get", () => {
  it.effect("returns undefined for non-existent", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      const row = yield* mcp.get(SESSION, "nope")
      expect(row).toBeUndefined()
    }),
  )

  it.effect("returns existing mcp by name", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert(SESSION, {
        name: "get-me",
        type: "local",
        command: ["echo"],
      })
      const row = yield* mcp.get(SESSION, "get-me")
      expect(row).toBeDefined()
      expect(row!.name).toBe("get-me")
    }),
  )
})

describe("SessionMcp remove", () => {
  it.effect("removes an existing mcp", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert(SESSION, {
        name: "to-remove",
        type: "local",
        command: ["rm"],
      })
      yield* mcp.remove(SESSION, "to-remove")
      const list = yield* mcp.list(SESSION)
      expect(list.find((r) => r.name === "to-remove")).toBeUndefined()
    }),
  )

  it.effect("removing non-existent mcp does nothing", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.remove(SESSION, "ghost")
      const list = yield* mcp.list(SESSION)
      expect(list).toEqual([])
    }),
  )
})

describe("SessionMcp removeAll", () => {
  it.effect("clears all mcps for a session", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert(SESSION, {
        name: "mcp-a",
        type: "local",
        command: ["a"],
      })
      yield* mcp.upsert(SESSION, {
        name: "mcp-b",
        type: "remote",
        url: "https://b.example.com/mcp",
      })
      yield* mcp.removeAll(SESSION)
      const list = yield* mcp.list(SESSION)
      expect(list).toEqual([])
    }),
  )
})

describe("SessionMcp session isolation", () => {
  it.effect("different sessions have independent mcps", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert("sess-a", {
        name: "only-a",
        type: "local",
        command: ["cmd-a"],
      })
      yield* mcp.upsert("sess-b", {
        name: "only-b",
        type: "remote",
        url: "https://b.example.com/mcp",
      })

      const listA = yield* mcp.list("sess-a")
      const listB = yield* mcp.list("sess-b")

      expect(listA.map((r) => r.name)).toContain("only-a")
      expect(listA.map((r) => r.name)).not.toContain("only-b")
      expect(listB.map((r) => r.name)).toContain("only-b")
      expect(listB.map((r) => r.name)).not.toContain("only-a")
    }),
  )

  it.effect("same name in different sessions is independent", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert("sess-x", {
        name: "shared",
        type: "local",
        command: ["x"],
      })
      yield* mcp.upsert("sess-y", {
        name: "shared",
        type: "remote",
        url: "https://y.example.com/mcp",
      })

      const findX = yield* mcp.get("sess-x", "shared")
      const findY = yield* mcp.get("sess-y", "shared")

      expect(findX!.type).toBe("local")
      expect(findX!.command).toEqual(["x"])
      expect(findY!.type).toBe("remote")
      expect(findY!.url).toBe("https://y.example.com/mcp")
    }),
  )

  it.effect("removing from one session does not affect another", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert("sess-1", {
        name: "cross-mcp",
        type: "local",
        command: ["cross"],
      })
      yield* mcp.upsert("sess-2", {
        name: "cross-mcp",
        type: "local",
        command: ["cross"],
      })

      yield* mcp.remove("sess-1", "cross-mcp")

      expect(yield* mcp.get("sess-1", "cross-mcp")).toBeUndefined()
      expect(yield* mcp.get("sess-2", "cross-mcp")).toBeDefined()
    }),
  )

  it.effect("clearing one session does not affect another", () =>
    Effect.gen(function* () {
      const mcp = yield* SessionMcp.Service
      yield* mcp.upsert("sess-a", {
        name: "mcp-1",
        type: "local",
        command: ["1"],
      })
      yield* mcp.upsert("sess-b", {
        name: "mcp-2",
        type: "remote",
        url: "https://2.example.com",
      })

      yield* mcp.removeAll("sess-a")

      expect(yield* mcp.list("sess-a")).toEqual([])
      const listB = yield* mcp.list("sess-b")
      expect(listB.map((r) => r.name)).toContain("mcp-2")
    }),
  )
})
