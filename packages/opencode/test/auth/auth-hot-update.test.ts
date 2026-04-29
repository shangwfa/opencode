import { afterAll, beforeAll, afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Auth } from "../../src/auth"
import { Database } from "../../src/storage/db"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"
import postgres from "postgres"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

Log.init({ print: false })

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

const it = testEffect(
  Layer.mergeAll(
    Auth.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

describe.skipIf(!enabled)("Auth hot update (PG)", () => {
  beforeAll(async () => {
    await reset()
    await Database.close().catch(() => undefined)
    await Database.initialize()
  })

  afterEach(async () => {
    await Instance.disposeAll().catch(() => undefined)
  })

  afterAll(async () => {
    await Database.close().catch(() => undefined)
  })

  it.live("PUT /auth adds provider to config/providers without restart", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const app = Server.Default().app

        const before = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        const beforeIds = before.providers.map((p: any) => p.id)
        expect(beforeIds).not.toContain("deepseek")

        yield* auth.set("deepseek", { type: "api", key: "sk-test-hot" })

        yield* Effect.tryPromise({
          try: () => Instance.disposeAll(),
          catch: () => undefined,
        })

        const after = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        const afterIds = after.providers.map((p: any) => p.id)
        expect(afterIds).toContain("deepseek")
      }),
    ),
  )

  it.live("DELETE /auth removes provider from config/providers without restart", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const app = Server.Default().app

        yield* auth.set("openai", { type: "api", key: "sk-test" })
        yield* Effect.tryPromise({ try: () => Instance.disposeAll(), catch: () => undefined })

        const withProvider = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        expect(withProvider.providers.map((p: any) => p.id)).toContain("openai")

        yield* auth.remove("openai")
        yield* Effect.tryPromise({ try: () => Instance.disposeAll(), catch: () => undefined })

        const after = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        expect(after.providers.map((p: any) => p.id)).not.toContain("openai")
      }),
    ),
  )

  it.live("PUT /auth via HTTP route triggers hot update", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const app = Server.Default().app

        const before = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        expect(before.providers.map((p: any) => p.id)).not.toContain("anthropic")

        const res = yield* Effect.tryPromise({
          try: () =>
            app.request("/auth/anthropic", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ type: "api", key: "sk-ant-test" }),
            }),
          catch: (e) => new Error(String(e)),
        })
        expect(res.status).toBe(200)

        const after = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        expect(after.providers.map((p: any) => p.id)).toContain("anthropic")
      }),
    ),
  )

  it.live("DELETE /auth via HTTP route triggers hot update", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const app = Server.Default().app

        yield* auth.set("google", { type: "api", key: "test-key" })
        yield* Effect.tryPromise({ try: () => Instance.disposeAll(), catch: () => undefined })

        const withProvider = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        expect(withProvider.providers.map((p: any) => p.id)).toContain("google")

        const res = yield* Effect.tryPromise({
          try: () =>
            app.request("/auth/google", {
              method: "DELETE",
            }),
          catch: (e) => new Error(String(e)),
        })
        expect(res.status).toBe(200)

        const after = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        expect(after.providers.map((p: any) => p.id)).not.toContain("google")
      }),
    ),
  )

  it.live("auth data persists across disposeAll", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service

        yield* auth.set("deepseek", { type: "api", key: "sk-persist-test" })
        yield* Effect.tryPromise({ try: () => Instance.disposeAll(), catch: () => undefined })

        const entry = yield* auth.get("deepseek")
        expect(entry).toBeDefined()
        expect(entry!.type).toBe("api")
        if (entry!.type === "api") expect(entry!.key).toBe("sk-persist-test")
      }),
    ),
  )

  it.live("multiple providers can be added and removed independently", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const auth = yield* Auth.Service
        const app = Server.Default().app

        yield* auth.set("deepseek", { type: "api", key: "sk-d1" })
        yield* auth.set("openai", { type: "api", key: "sk-o1" })
        yield* Effect.tryPromise({ try: () => Instance.disposeAll(), catch: () => undefined })

        const afterAdd = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        const ids = afterAdd.providers.map((p: any) => p.id)
        expect(ids).toContain("deepseek")
        expect(ids).toContain("openai")

        yield* auth.remove("deepseek")
        yield* Effect.tryPromise({ try: () => Instance.disposeAll(), catch: () => undefined })

        const afterRemove = yield* Effect.tryPromise({
          try: () => app.request("/config/providers").then((r) => r.json()) as Promise<any>,
          catch: (e) => new Error(String(e)),
        })
        const ids2 = afterRemove.providers.map((p: any) => p.id)
        expect(ids2).not.toContain("deepseek")
        expect(ids2).toContain("openai")

        yield* auth.remove("openai")
      }),
    ),
  )
})
