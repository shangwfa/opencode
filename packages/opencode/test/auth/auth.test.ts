import { afterEach, describe, expect } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Global } from "@opencode-ai/core/global"
import { Effect } from "effect"
import { Auth } from "../../src/auth"
import { testEffect } from "../lib/effect"

const it = testEffect(LayerNode.compile(Auth.node))

// The XDG data dir is shared across every test file in this process, so
// leftover rows (notably `https://…` wellknown entries) leak into other
// suites: provider init fetches `<url>/.well-known/opencode` and dies on 404.
// Wipe the auth store after each case to keep this file's writes contained.
afterEach(async () => {
  await fs.rm(path.join(Global.Path.data, "auth.json"), { force: true })
})

describe("Auth", () => {
  it.instance("set normalizes trailing slashes in keys", () =>
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
  )

  it.instance("set cleans up pre-existing trailing-slash entry", () =>
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
      const keys = Object.keys(data).filter((key) => key.includes("example.com"))
      expect(keys).toEqual(["https://example.com"])
      const entry = data["https://example.com"]!
      expect(entry.type).toBe("wellknown")
      if (entry.type === "wellknown") expect(entry.token).toBe("new")
    }),
  )

  it.instance("remove deletes both trailing-slash and normalized keys", () =>
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
      expect(data["https://example.com/"]).toBeUndefined()
    }),
  )

  it.instance("set and remove are no-ops on keys without trailing slashes", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("anthropic", {
        type: "api",
        key: "sk-test",
      })
      const data = yield* auth.all()
      expect(data["anthropic"]).toBeDefined()
      yield* auth.remove("anthropic")
      const after = yield* auth.all()
      expect(after["anthropic"]).toBeUndefined()
    }),
  )

  it.instance("prefers public credentials and falls back to personal credentials", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("priority-provider", { type: "api", key: "public-key" })
      yield* auth.set("priority-provider", { type: "api", key: "personal-key" }, "user-1")

      const preferred = yield* auth.get("priority-provider", "user-1")
      expect(preferred).toEqual({ type: "api", key: "public-key" })

      yield* auth.remove("priority-provider")
      const fallback = yield* auth.get("priority-provider", "user-1")
      expect(fallback).toEqual({ type: "api", key: "personal-key" })
    }),
  )

  it.instance("personal set does not overwrite the public row for the same provider", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("coexist-provider", { type: "api", key: "public-key" })
      yield* auth.set("coexist-provider", { type: "api", key: "personal-key" }, "user-1")

      expect(yield* auth.get("coexist-provider")).toEqual({ type: "api", key: "public-key" })
      expect(yield* auth.get("coexist-provider", "user-2")).toEqual({ type: "api", key: "public-key" })
      expect((yield* auth.all("user-1"))["coexist-provider"]).toEqual({ type: "api", key: "public-key" })
    }),
  )

  it.instance("personal remove does not delete the public row", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("remove-provider", { type: "api", key: "public-key" })
      yield* auth.set("remove-provider", { type: "api", key: "personal-key" }, "user-1")

      yield* auth.remove("remove-provider", "user-1")

      expect(yield* auth.get("remove-provider")).toEqual({ type: "api", key: "public-key" })
      expect(yield* auth.get("remove-provider", "user-1")).toEqual({ type: "api", key: "public-key" })
    }),
  )

  it.instance("anonymous reads never expose personal credentials", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("personal-only", { type: "api", key: "user-1-key" }, "user-1")
      yield* auth.set("public-row", { type: "api", key: "public-key" })
      yield* auth.set("public-row", { type: "api", key: "user-1-key" }, "user-1")

      const anonymous = yield* auth.all()
      expect(anonymous["personal-only"]).toBeUndefined()
      expect(anonymous["public-row"]).toEqual({ type: "api", key: "public-key" })
      expect(yield* auth.get("personal-only")).toBeUndefined()

      const userView = yield* auth.all("user-1")
      expect(userView["personal-only"]).toEqual({ type: "api", key: "user-1-key" })
      expect(userView["public-row"]).toEqual({ type: "api", key: "public-key" })
    }),
  )

  it.instance("users only see their own personal credentials", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("per-user-provider", { type: "api", key: "user-1-key" }, "user-1")
      yield* auth.set("per-user-provider", { type: "api", key: "user-2-key" }, "user-2")

      expect(yield* auth.get("per-user-provider", "user-1")).toEqual({ type: "api", key: "user-1-key" })
      expect(yield* auth.get("per-user-provider", "user-2")).toEqual({ type: "api", key: "user-2-key" })

      yield* auth.remove("per-user-provider", "user-1")
      expect(yield* auth.get("per-user-provider", "user-1")).toBeUndefined()
      expect(yield* auth.get("per-user-provider", "user-2")).toEqual({ type: "api", key: "user-2-key" })
    }),
  )

  it.instance("keeps url keys public across user views", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("https://example.com", { type: "wellknown", key: "TOKEN", token: "public" })
      yield* auth.set("openai", { type: "api", key: "user-1-key" }, "user-1")

      const anonymous = yield* auth.all()
      expect(anonymous["https://example.com"]).toEqual({ type: "wellknown", key: "TOKEN", token: "public" })
      expect(anonymous["openai"]).toBeUndefined()

      const userView = yield* auth.all("user-1")
      expect(userView["https://example.com"]).toEqual({ type: "wellknown", key: "TOKEN", token: "public" })
      expect(userView["openai"]).toEqual({ type: "api", key: "user-1-key" })
    }),
  )

  it.instance("treats blank user ids as the public identity", () =>
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      yield* auth.set("blank-user", { type: "api", key: "via-blank" }, "   ")
      yield* auth.set("blank-user", { type: "api", key: "personal" }, "user-1")

      expect(yield* auth.get("blank-user")).toEqual({ type: "api", key: "via-blank" })
      expect((yield* auth.all())["blank-user"]).toEqual({ type: "api", key: "via-blank" })
    }),
  )
})
