import { Schema } from "effect"
import { createHash } from "node:crypto"

export const protocolVersion = 1
export const port = 9912
export const prefix = "/internal/session-tools/v1/"
export const hash = (source: string) => createHash("sha256").update(source).digest("hex")
export const versionHash = (source: string) => hash(`session-tool:1:${source}`)

export const Manifest = Schema.Struct({
  versionHash: Schema.String,
  manifestHash: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Json,
  outputSchema: Schema.Json,
})
export type Manifest = typeof Manifest.Type

export interface Envelope {
  protocolVersion: number
  sandboxID: string
  hostEpoch: string
  ownerID: string
  ownerLeaseID: string
  logicalSessionID: string
  generation: number
  lifecycleEpoch: number
}

export class HostError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export const budgets = {
  discover: 10_000,
  execute: 60_000,
  grace: 2_000,
  owner: 15_000,
  workers: 16,
  active: 4,
  queue: 32,
  body: 1024 * 1024,
  manifest: 512 * 1024,
  result: 8 * 1024 * 1024,
  log: 1024 * 1024,
  idle: 30 * 60_000,
  cache: 5 * 60_000,
  tombstones: 100_000,
  cachedResults: 64 * 1024 * 1024,
} as const
