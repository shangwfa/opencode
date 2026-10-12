import { describe, expect, it } from "bun:test"
import { ConnectorCrypto } from "@opencode/connector/adapter/crypto"

const key = ConnectorCrypto.deriveKey("unit-test-encryption-key")
const otherKey = ConnectorCrypto.deriveKey("another-encryption-key")

describe("connector secret encryption", () => {
  it("round-trips a token through the enc:v1 format", () => {
    const sealed = ConnectorCrypto.encryptSecret("oct_secret_123", key)
    expect(sealed.startsWith("enc:v1:")).toBe(true)
    expect(sealed).not.toContain("oct_secret_123")
    expect(ConnectorCrypto.decryptSecret(sealed, key)).toBe("oct_secret_123")
  })

  it("uses a fresh iv per encryption", () => {
    expect(ConnectorCrypto.encryptSecret("same", key)).not.toBe(ConnectorCrypto.encryptSecret("same", key))
  })

  it("fails when the ciphertext is tampered with", () => {
    const sealed = ConnectorCrypto.encryptSecret("oct_secret_123", key)
    const [prefixAndIv, tag, cipher] = sealed.split(".")
    const flipped = cipher!.startsWith("A") ? `B${cipher!.slice(1)}` : `A${cipher!.slice(1)}`
    expect(() => ConnectorCrypto.decryptSecret([prefixAndIv, tag, flipped].join("."), key)).toThrow()
  })

  it("fails when the auth tag is tampered with", () => {
    const sealed = ConnectorCrypto.encryptSecret("oct_secret_123", key)
    const [prefixAndIv, tag, cipher] = sealed.split(".")
    const flipped = tag!.startsWith("A") ? `B${tag!.slice(1)}` : `A${tag!.slice(1)}`
    expect(() => ConnectorCrypto.decryptSecret([prefixAndIv, flipped, cipher].join("."), key)).toThrow()
  })

  it("fails with a wrong key", () => {
    const sealed = ConnectorCrypto.encryptSecret("oct_secret_123", key)
    expect(() => ConnectorCrypto.decryptSecret(sealed, otherKey)).toThrow()
  })

  it("never passes plaintext through: unknown prefixes throw", () => {
    expect(() => ConnectorCrypto.decryptSecret("oct_secret_123", key)).toThrow()
    expect(() => ConnectorCrypto.decryptSecret("enc:v2:aa.bb.cc", key)).toThrow()
  })

  it("rejects malformed payloads", () => {
    expect(() => ConnectorCrypto.decryptSecret("enc:v1:onlyone", key)).toThrow()
    expect(() => ConnectorCrypto.decryptSecret("enc:v1:a.b.c.d", key)).toThrow()
  })

  it("refuses to derive a key from an empty passphrase", () => {
    expect(() => ConnectorCrypto.deriveKey(undefined)).toThrow()
    expect(() => ConnectorCrypto.deriveKey("   ")).toThrow()
    expect(() => ConnectorCrypto.codec("")).toThrow()
  })

  it("codec encrypts and decrypts with the derived key", () => {
    const codec = ConnectorCrypto.codec("unit-test-encryption-key")
    expect(codec.decrypt(codec.encrypt("tok"))).toBe("tok")
  })
})

describe("connector token lazy migration", () => {
  const codec = ConnectorCrypto.codec("unit-test-encryption-key")

  it("prefers the encrypted column and does not write back", () => {
    const encrypted = codec.encrypt("tok_new")
    const resolved = ConnectorCrypto.resolveToken({ encrypted, plaintext: "tok_old", codec })
    expect(resolved).toEqual({ token: "tok_new", writeBack: null })
  })

  it("reads a legacy plaintext-only row and returns a ciphertext to write back", () => {
    const resolved = ConnectorCrypto.resolveToken({ encrypted: null, plaintext: "tok_legacy", codec })
    expect(resolved.token).toBe("tok_legacy")
    expect(resolved.writeBack).not.toBeNull()
    expect(resolved.writeBack!.startsWith("enc:v1:")).toBe(true)
    expect(codec.decrypt(resolved.writeBack!)).toBe("tok_legacy")
  })

  it("returns nothing for rows without any token", () => {
    expect(ConnectorCrypto.resolveToken({ encrypted: null, plaintext: null, codec })).toEqual({ token: null, writeBack: null })
  })
})
