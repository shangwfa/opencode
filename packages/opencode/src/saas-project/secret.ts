export * as ProjectSecret from "./secret"

import { createCipheriv, createDecipheriv, randomBytes } from "crypto"
import { Context, Effect, Layer, Schema } from "effect"

export const Envelope = Schema.Struct({
  algorithm: Schema.Literal("aes-256-gcm"),
  keyID: Schema.String,
  nonce: Schema.String,
  ciphertext: Schema.String,
  tag: Schema.String,
})
export type Envelope = typeof Envelope.Type

export class SecretError extends Schema.TaggedErrorClass<SecretError>()("ProjectSecret.Error", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly encrypt: (value: Schema.Json, aad: string) => Effect.Effect<Envelope, SecretError>
  readonly decrypt: (envelope: Envelope, aad: string) => Effect.Effect<Schema.Json, SecretError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SaasProjectSecret") {}

export function make(keyID: string, key: Uint8Array) {
  return Effect.gen(function* () {
    if (key.length !== 32) return yield* new SecretError({ message: "OPENCODE_SECRET_KEY must decode to 32 bytes" })
    const secret = Buffer.from(key)

    const encrypt = Effect.fn("ProjectSecret.encrypt")(function* (value: Schema.Json, aad: string) {
      return yield* Effect.try({
        try: () => {
          const nonce = randomBytes(12)
          const cipher = createCipheriv("aes-256-gcm", secret, nonce)
          cipher.setAAD(Buffer.from(aad))
          const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()])
          return Envelope.make({
            algorithm: "aes-256-gcm",
            keyID,
            nonce: nonce.toString("base64url"),
            ciphertext: ciphertext.toString("base64url"),
            tag: cipher.getAuthTag().toString("base64url"),
          })
        },
        catch: () => new SecretError({ message: "Failed to encrypt secret" }),
      })
    })

    const decrypt = Effect.fn("ProjectSecret.decrypt")(function* (envelope: Envelope, aad: string) {
      if (envelope.keyID !== keyID) return yield* new SecretError({ message: "Secret key is unavailable" })
      return yield* Effect.try({
        try: () => {
          const decipher = createDecipheriv("aes-256-gcm", secret, Buffer.from(envelope.nonce, "base64url"))
          decipher.setAAD(Buffer.from(aad))
          decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"))
          return JSON.parse(
            Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString(
              "utf8",
            ),
          ) as Schema.Json
        },
        catch: () => new SecretError({ message: "Failed to decrypt secret" }),
      })
    })

    return Service.of({ encrypt, decrypt })
  })
}

export function layer(keyID: string, key: Uint8Array) {
  return Layer.effect(Service, make(keyID, key))
}

const configured = Effect.fn("ProjectSecret.configured")(function* () {
  const keyID = process.env.OPENCODE_SECRET_KEY_ID
  const encoded = process.env.OPENCODE_SECRET_KEY
  if (!keyID || !encoded) {
    return yield* new SecretError({
      message: "OPENCODE_SECRET_KEY_ID and OPENCODE_SECRET_KEY are required",
    })
  }
  return yield* make(keyID, Buffer.from(encoded, "base64"))
})

export const live = Layer.succeed(
  Service,
  Service.of({
    encrypt: (value, aad) => configured().pipe(Effect.flatMap((service) => service.encrypt(value, aad))),
    decrypt: (envelope, aad) => configured().pipe(Effect.flatMap((service) => service.decrypt(envelope, aad))),
  }),
)
