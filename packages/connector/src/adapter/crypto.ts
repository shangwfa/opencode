export * as ConnectorCrypto from "./crypto.js"

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto"

/**
 * SaaS-side at-rest encryption for engine runtime token secrets, aligned with the upstream
 * AesGcmSecretCodec wire format (`enc:v1:<iv>.<tag>.<ciphertext>`, base64url, AES-256-GCM,
 * scrypt-derived key) so the same OPENCODE_CONNECTOR_ENCRYPTION_KEY governs both sides.
 * Fail-closed: unknown prefixes and failed authentication throw; plaintext is never passed through.
 */
const encryptedPrefix = "enc:v1:"
const keySalt = "oomol-connect-local-secret-store-v1"

/** Derives the 32-byte AES key; an empty passphrase is refused so encryption can never silently turn off. */
export const deriveKey = (passphrase: string | undefined) => {
  if (!passphrase?.trim()) throw new Error("OPENCODE_CONNECTOR_ENCRYPTION_KEY is required to store connector secrets.")
  return scryptSync(passphrase, keySalt, 32)
}

export const encryptSecret = (plaintext: string, key: Buffer): string => {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    encryptedPrefix,
    iv.toString("base64url"),
    ".",
    tag.toString("base64url"),
    ".",
    encrypted.toString("base64url"),
  ].join("")
}

export const decryptSecret = (value: string, key: Buffer): string => {
  if (!value.startsWith(encryptedPrefix)) throw new Error("Connector secret is not in the encrypted format.")
  const [ivText, tagText, encryptedText, ...rest] = value.slice(encryptedPrefix.length).split(".")
  if (!ivText || !tagText || !encryptedText || rest.length > 0) throw new Error("Encrypted connector secret payload is malformed.")
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "base64url"))
  decipher.setAuthTag(Buffer.from(tagText, "base64url"))
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8")
}

export interface Codec {
  readonly encrypt: (plaintext: string) => string
  readonly decrypt: (stored: string) => string
}

export const codec = (passphrase: string | undefined): Codec => {
  const key = deriveKey(passphrase)
  return { encrypt: (plaintext) => encryptSecret(plaintext, key), decrypt: (stored) => decryptSecret(stored, key) }
}

export const isEncrypted = (value: string) => value.startsWith(encryptedPrefix)

/**
 * Lazy plaintext migration resolver: prefers the encrypted column, falls back to the legacy
 * plaintext column, and reports whether the plaintext value should be rewritten as ciphertext.
 */
export const resolveToken = (input: {
  readonly encrypted: string | null
  readonly plaintext: string | null
  readonly codec: Codec
}): { readonly token: string | null; readonly writeBack: string | null } => {
  if (input.encrypted !== null) return { token: input.codec.decrypt(input.encrypted), writeBack: null }
  if (input.plaintext === null) return { token: null, writeBack: null }
  return { token: input.plaintext, writeBack: input.codec.encrypt(input.plaintext) }
}

/** Exponential backoff with jitter for transient poll/receipt failures; capped at 15 minutes. */
export const BACKOFF_CAP_MS = 15 * 60_000
export const backoffDelayMs = (attempts: number, random: () => number = Math.random) => {
  const base = Math.min(BACKOFF_CAP_MS, 1_000 * 2 ** Math.max(0, attempts - 1))
  return Math.floor(base * (0.5 + random() / 2))
}
