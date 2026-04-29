import { afterAll, beforeAll, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Database } from "../../src/storage/db"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import postgres from "postgres"

const url = process.env["OPENCODE_DATABASE_URL"]
const enabled = !!url && Database.dialect === "pg"

async function reset() {
  const client = postgres(url!)
  try {
    await client.unsafe(`
      DO $$ DECLARE
        r RECORD;
      BEGIN
        FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public') LOOP
          EXECUTE 'DROP TABLE IF EXISTS ' || quote_ident(r.tablename) || ' CASCADE';
        END LOOP;
      END $$;
    `)
  } finally {
    await client.end()
  }
}

const node = CrossSpawnSpawner.defaultLayer

const it = testEffect(Layer.mergeAll(Auth.pgLayer, node))

describe.skipIf(!enabled)("Auth PG layer", () => {
  beforeAll(async () => {
    await reset()
    await Database.close().catch(() => undefined)
    await Database.initialize()
  })

  afterAll(async () => {
    await Database.close().catch(() => undefined)
  })

  it.live("set and get api key", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("deepseek", { type: "api", key: "sk-test-123" })
        const entry = yield* auth.get("deepseek")
        expect(entry).toBeDefined()
        expect(entry!.type).toBe("api")
        if (entry!.type === "api") expect(entry!.key).toBe("sk-test-123")
      }),
    ),
  )

  it.live("set normalizes trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeDefined()
        expect(data["https://example.com/"]).toBeUndefined()
      }),
    ),
  )

  it.live("set overwrites existing entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("anthropic", { type: "api", key: "old-key" })
        yield* auth.set("anthropic", { type: "api", key: "new-key" })
        const entry = yield* auth.get("anthropic")
        expect(entry).toBeDefined()
        if (entry!.type === "api") expect(entry!.key).toBe("new-key")
      }),
    ),
  )

  it.live("remove deletes entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("openai", { type: "api", key: "sk-test" })
        yield* auth.remove("openai")
        const entry = yield* auth.get("openai")
        expect(entry).toBeUndefined()
      }),
    ),
  )

  it.live("remove normalizes trailing slashes", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "abc",
        })
        yield* auth.remove("https://example.com/")
        const data = yield* auth.all()
        expect(data["https://example.com"]).toBeUndefined()
      }),
    ),
  )

  it.live("all returns all entries", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("provider-a", { type: "api", key: "key-a" })
        yield* auth.set("provider-b", { type: "api", key: "key-b" })
        const data = yield* auth.all()
        expect(Object.keys(data).length).toBeGreaterThanOrEqual(2)
        expect(data["provider-a"]).toBeDefined()
        expect(data["provider-b"]).toBeDefined()
      }),
    ),
  )

  it.live("get returns undefined for missing provider", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const entry = yield* auth.get("nonexistent")
        expect(entry).toBeUndefined()
      }),
    ),
  )

  it.live("stores oauth entry", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("github", {
          type: "oauth",
          refresh: "refresh-token",
          access: "access-token",
          expires: Date.now() + 3600000,
        })
        const entry = yield* auth.get("github")
        expect(entry).toBeDefined()
        expect(entry!.type).toBe("oauth")
        if (entry!.type === "oauth") {
          expect(entry!.refresh).toBe("refresh-token")
          expect(entry!.access).toBe("access-token")
        }
      }),
    ),
  )

  it.live("cleans up trailing-slash variant on set", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        yield* auth.set("https://example.com/", {
          type: "wellknown",
          key: "TOKEN",
          token: "old",
        })
        yield* auth.set("https://example.com", {
          type: "wellknown",
          key: "TOKEN",
          token: "new",
        })
        const data = yield* auth.all()
        const keys = Object.keys(data).filter((k) => k.includes("example.com"))
        expect(keys).toEqual(["https://example.com"])
        const entry = data["https://example.com"]!
        if (entry.type === "wellknown") expect(entry.token).toBe("new")
      }),
    ),
  )
})
