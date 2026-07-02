import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Record, Result, Schema, Context } from "effect"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Database } from "../storage/db"

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
  readonly get: (providerID: string) => Effect.Effect<Info | undefined, AuthError>
  readonly all: () => Effect.Effect<Record<string, Info>, AuthError>
  readonly set: (key: string, info: Info) => Effect.Effect<void, AuthError>
  readonly remove: (key: string) => Effect.Effect<void, AuthError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Auth") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fsys = yield* FSUtil.Service
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      if (process.env.OPENCODE_AUTH_CONTENT) {
        try {
          return JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
        } catch (err) {}
      }

      const data = (yield* fsys.readJson(file).pipe(Effect.orElseSucceed(() => ({})))) as Record<string, unknown>
      return Record.filterMap(data, (value) => Result.fromOption(decode(value), () => undefined))
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      if (norm !== key) delete data[key]
      delete data[norm + "/"]
      yield* fsys
        .writeJson(file, { ...data, [norm]: info }, 0o600)
        .pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      const data = yield* all()
      delete data[key]
      delete data[norm]
      yield* fsys.writeJson(file, data, 0o600).pipe(Effect.mapError(fail("Failed to write auth data")))
    })

    return Service.of({ get, all, set, remove })
  }),
)

export const pgLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pgClient = (Database.Client() as any).$client
    const decode = Schema.decodeUnknownOption(Info)

    const all = Effect.fn("Auth.all")(function* () {
      const rows: any[] = yield* Effect.tryPromise({
        try: () => pgClient`SELECT * FROM auth` as Promise<any[]>,
        catch: (e) => new AuthError({ message: "Failed to read auth from pg", cause: e }),
      }).pipe(Effect.orDie)
      const result: Record<string, any> = {}
      for (const row of rows) {
        const data = typeof row.data === "string" ? JSON.parse(row.data) : row.data
        const decoded = decode(data)
        if (decoded._tag === "Some") result[row.provider_id] = decoded.value
      }
      return result as Record<string, Info>
    })

    const get = Effect.fn("Auth.get")(function* (providerID: string) {
      return (yield* all())[providerID]
    })

    const set = Effect.fn("Auth.set")(function* (key: string, info: Info) {
      const norm = key.replace(/\/+$/, "")
      const now = Math.floor(Date.now() / 1000)
      yield* Effect.tryPromise({
        try: async () => {
          await pgClient`INSERT INTO auth (provider_id, type, data, time_created, time_updated)
            VALUES (${norm}, ${(info as any).type}, ${JSON.stringify(info)}, ${now}, ${now})
            ON CONFLICT (provider_id) DO UPDATE SET type = ${(info as any).type}, data = ${JSON.stringify(info)}, time_updated = ${now}`
        },
        catch: (e) => new AuthError({ message: "Failed to write auth to pg", cause: e }),
      }).pipe(Effect.orDie)
    })

    const remove = Effect.fn("Auth.remove")(function* (key: string) {
      const norm = key.replace(/\/+$/, "")
      yield* Effect.tryPromise({
        try: () => pgClient`DELETE FROM auth WHERE provider_id = ${norm}`,
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
