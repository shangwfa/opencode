import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "../storage/db"
import { PUBLIC_USER_ID, normalizeUserId } from "./request-user"

function userKey(userId: string, providerID: string) {
  return `${userId}/${providerID}`
}

export const OAUTH_DUMMY_KEY = "opencode-oauth-dummy-key"

const file = path.join(Global.Path.data, "auth.json")

const fail = (message: string) => (cause: unknown) => new AuthError({ message, cause })

export class Oauth extends Schema.Class<Oauth>("OAuth")({
  type: Schema.Literal("oauth"),
  refresh: Schema.String,
  access: Schema.String,
  expires: NonNegativeInt,
  accountId: Schema.optional(Schema.String),
  enterpriseUrl: Schema.optional(Schema.String),
}) {}

export class Api extends Schema.Class<Api>("ApiAuth")({
  type: Schema.Literal("api"),
  key: Schema.String,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.String)),
}) {}

export class WellKnown extends Schema.Class<WellKnown>("WellKnownAuth")({
  type: Schema.Literal("wellknown"),
  key: Schema.String,
  token: Schema.String,
}) {}

export const Info = Schema.Union([Oauth, Api, WellKnown]).annotate({ discriminator: "type", identifier: "Auth" })
export type Info = Schema.Schema.Type<typeof Info>

export class AuthError extends Schema.TaggedErrorClass<AuthError>()("AuthError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Interface {
  readonly get: (providerID: string, userId?: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: (userId?: string) => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info, userId?: string) => Effect.Effect<void, AuthError>
  readonly remove: (key: string, userId?: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const readRaw = Effect.fn("Auth.readRaw")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      return (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
    })

    const all = Effect.fn("Auth.all")(function* (userId?: string) {
      const user = normalizeUserId(userId)
      const data = yield* readRaw()
      const decoded = Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
      if (!user) {
        const pub: Record<string, Info> = {}
        for (const [key, value] of Object.entries(decoded)) {
          if (!key.includes("/")) pub[key] = value
        }
        return pub
      }
      const prefix = `${user}/`
      const merged: Record<string, Info> = {}
      for (const [key, value] of Object.entries(decoded)) {
        if (key.startsWith(prefix)) merged[key.slice(prefix.length)] = value
        if (!key.includes("/")) merged[key] ??= value
      }
      return merged
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string, userId?: string) {
      const user = normalizeUserId(userId)
      if (!user) return (yield* all())[providerID]
      const data = yield* all(user)
      return data[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info, userId?: string) {
      const user = normalizeUserId(userId)
      const norm = key.replace(/\/+$/, "")
      const raw = yield* readRaw()
      if (!user) {
        if (norm !== key) delete raw[key]
        delete raw[norm + "/"]
        raw[norm] = info
      } else {
        const namespaced = userKey(user, norm)
        if (namespaced !== key) delete raw[key]
        raw[namespaced] = info
      }
      yield* fsys.writeJson(file, raw, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string, userId?: string) {
      const user = normalizeUserId(userId)
      const norm = key.replace(/\/+$/, "")
      const raw = yield* readRaw()
      if (!user) {
        delete raw[key]
        delete raw[norm]
      } else {
        delete raw[key]
        delete raw[userKey(user, norm)]
      }
      yield* fsys.writeJson(file, raw, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const pgLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pgClient = (Database.Client() as any).$client
    const decode = Schema.decodeUnknownOption(Info)

    const readRows = Effect.fn("Auth.readRows")(function* (userId?: string) {
      const user = normalizeUserId(userId)
      const rows: any[] = yield* Effect.tryPromise({
        try: () =>
          (user
            ? pgClient`SELECT * FROM auth WHERE user_id IN (${PUBLIC_USER_ID}, ${user})`
            : pgClient`SELECT * FROM auth WHERE user_id = ${PUBLIC_USER_ID}`) as Promise<any[]>,
        catch: (e) => new AuthError({ message: "Failed to read auth from pg", cause: e }),
      }).pipe(Effect.orDie)
      return rows
    })

    const stripPrefix = (user: string, providerID: string) =>
      providerID.startsWith(`${user}/`) ? providerID.slice(user.length + 1) : undefined

    const toRecord = (rows: any[], user: string) => {
      const pub: Record<string, any> = {}
      const personal: Record<string, any> = {}
      for (const row of rows) {
        const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data
        const decoded = decode(data)
        if (decoded._tag !== "Some") continue
        if (user && row.user_id === user) {
          const id = stripPrefix(user, row.provider_id)
          if (id) personal[id] = decoded.value
        } else if (!row.user_id || row.user_id === PUBLIC_USER_ID) {
          pub[row.provider_id] = decoded.value
        }
      }
      return { ...pub, ...personal } as Record<string, Info>
    }

    const all = Effect.fn("Auth.all")(function* (userId?: string) {
      const user = normalizeUserId(userId)
      return toRecord(yield* readRows(user), user)
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string, userId?: string) {
      return (yield* all(userId))[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info, userId?: string) {
      const user = normalizeUserId(userId)
      const norm = key.replace(/\/+$/, "")
      const stored = user ? userKey(user, norm) : norm
      const now = Math.floor(Date.now() / 1000)
      yield* Effect.tryPromise({
        try: async () => {
          await pgClient`INSERT INTO auth (user_id, provider_id, type, data, time_created, time_updated)
            VALUES (${user}, ${stored}, ${(info as any).type}, ${JSON.stringify(info)}, ${now}, ${now})
            ON CONFLICT (provider_id) DO UPDATE SET user_id = ${user}, type = ${(info as any).type}, data = ${JSON.stringify(info)}, time_updated = ${now}`
        },
        catch: (e) => new AuthError({ message: "Failed to write auth to pg", cause: e }),
      }).pipe(Effect.orDie)
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string, userId?: string) {
      const user = normalizeUserId(userId)
      const norm = key.replace(/\/+$/, "")
      const stored = user ? userKey(user, norm) : norm
      yield* Effect.tryPromise({
        try: () => pgClient`DELETE FROM auth WHERE provider_id = ${stored}`,
        catch: (e) => new AuthError({ message: "Failed to delete auth from pg", cause: e }),
      }).pipe(Effect.orDie)
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const defaultLayer = process.env["OPENCODE_DATABASE_URL"]
  ? pgLayer
  : layer.pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

export const node = LayerNode.make({ service: Service, layer: defaultLayer, deps: [FSUtil.node] })

export * as Auth from "."
