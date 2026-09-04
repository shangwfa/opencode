import { createHash } from "node:crypto"
import { estimateTokens, type CcrConfig } from "./config"
import { extractQueryTerms, scoreText } from "./relevance"
import {
  CCR_MARKER_PATTERNS,
  compressOutput,
  type CompressionPreview,
  type CompressionStrategy,
} from "./compressors"

export interface CcrEntry {
  hash: string
  sessionID: string
  messageID: string
  tool: string
  strategy: CompressionStrategy
  original: string
  originalTokens: number
  compressedTokens: number
  /** Item counts for JSON-array compressions (Headroom parity). */
  originalItems?: number
  compressedItems?: number
  retrievalCount: number
  createdAt: string
  /** Absence means the entry lives until its session is deleted. */
  expiresAt?: string
}

export interface CcrStorageBackend {
  read(key: string[]): Promise<CcrEntry | null>
  write(key: string[], content: CcrEntry): Promise<void>
  /** List all entries for a session (proactive expansion scans these). */
  list?(prefix: string[]): Promise<CcrEntry[]>
}

export type CcrRetrieveResult =
  | { status: "available"; content: string; strategy: CompressionStrategy; originalTokens: number }
  | { status: "expired"; ttlSeconds: number }
  | { status: "not_found" }

export function ccrKey(sessionID: string, hash: string): string[] {
  return ["plugin", "ccr", sessionID, hash]
}

// 24 hex chars = 96 bits (Headroom parity: 50% collision bound at ~2^48 entries).
export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24)
}

const MAX_CACHE_ENTRIES = 1000

function isExpired(entry: CcrEntry, now: number): boolean {
  if (!entry.expiresAt) return false
  const expires = Date.parse(entry.expiresAt)
  return Number.isFinite(expires) && expires <= now
}

function renderMarker(
  hash: string,
  preview: CompressionPreview,
  originalTokens: number,
  ttlSeconds: number,
): string {
  const compressedTokens = estimateTokens(preview.preview)
  const items =
    preview.itemCount !== undefined
      ? `${preview.itemCount.original} items compressed to ${preview.itemCount.compressed}. `
      : ""
  const expiry = ttlSeconds > 0 ? ` Expires in ${Math.round(ttlSeconds / 60)}m.` : ""
  return [
    `${CCR_MARKER_PATTERNS[0]}${hash}] (${preview.strategy}) ${preview.preview}`,
    "",
    `[${items}~${originalTokens} tokens compressed to ~${compressedTokens}. Retrieve original: hash=${hash}.${expiry} Call the ccr_retrieve tool with this hash if you need the full content.]`,
  ].join("\n")
}

export class CcrStore {
  private replacements = new Map<string, string>()

  constructor(
    private backend: CcrStorageBackend | undefined,
    private config: CcrConfig,
  ) {}

  /** Returns the replacement text for a tool output, or undefined when the
   *  output is not worth compressing. Results are content-addressed: the same
   *  bytes always produce the same marker, keeping the request prefix stable.
   *  `query` influences item selection only on first compression (cache miss);
   *  the chosen preview is then fixed by the content hash. */
  async replace(input: {
    sessionID: string
    messageID: string
    tool: string
    output: string
    query?: string
  }): Promise<string | undefined> {
    if (CCR_MARKER_PATTERNS.some((pattern) => input.output.includes(pattern))) return undefined

    const hash = contentHash(input.output)
    const cached = this.replacements.get(hash)
    if (cached) return cached

    const compressed = compressOutput(input.output, this.config, input.query)
    if (!compressed) return undefined

    const originalTokens = estimateTokens(input.output)
    const replacement = renderMarker(hash, compressed, originalTokens, this.config.ttlSeconds)
    this.replacements.set(hash, replacement)
    if (this.replacements.size > MAX_CACHE_ENTRIES) {
      const oldest = this.replacements.keys().next().value
      if (oldest !== undefined) this.replacements.delete(oldest)
    }

    if (this.backend) {
      await this.backend
        .write(ccrKey(input.sessionID, hash), {
          hash,
          sessionID: input.sessionID,
          messageID: input.messageID,
          tool: input.tool,
          strategy: compressed.strategy,
          original: input.output,
          originalTokens,
          compressedTokens: estimateTokens(compressed.preview),
          originalItems: compressed.itemCount?.original,
          compressedItems: compressed.itemCount?.compressed,
          retrievalCount: 0,
          createdAt: new Date().toISOString(),
          ...(this.config.ttlSeconds > 0
            ? { expiresAt: new Date(Date.now() + this.config.ttlSeconds * 1000).toISOString() }
            : {}),
        })
        .catch(() => {})
    }
    return replacement
  }

  async retrieve(sessionID: string, hash: string): Promise<CcrRetrieveResult> {
    let entry: CcrEntry | null | undefined
    try {
      entry = await this.backend?.read(ccrKey(sessionID, hash))
    } catch {
      entry = null
    }
    if (!entry) return { status: "not_found" }

    if (isExpired(entry, Date.now())) {
      return { status: "expired", ttlSeconds: this.config.ttlSeconds }
    }

    if (this.backend) {
      await this.backend
        .write(ccrKey(sessionID, hash), { ...entry, retrievalCount: entry.retrievalCount + 1 })
        .catch(() => {})
    }
    return {
      status: "available",
      content: entry.original,
      strategy: entry.strategy,
      originalTokens: entry.originalTokens,
    }
  }

  /** Retrieve with ancestor fallback for subagents: a task-subagent session
   *  inherits the parent's compressed markers in its prompt, so a hash can
   *  legitimately point at an entry stored under the parent session. Walks
   *  up the parent chain (bounded) and counts the hit against whichever
   *  ancestor actually holds the entry. */
  async retrieveAlongAncestry(
    sessionID: string,
    hash: string,
    resolveParent: (sessionID: string) => Promise<string | undefined>,
    maxDepth = 3,
  ): Promise<CcrRetrieveResult> {
    let current: string | undefined = sessionID
    for (let depth = 0; current !== undefined && depth <= maxDepth; depth++) {
      const result = await this.retrieve(current, hash)
      if (result.status !== "not_found") return result
      current = await resolveParent(current).catch(() => undefined)
    }
    return { status: "not_found" }
  }

  /** Headroom context_tracker parity (lightweight): return the hashes of
   *  stored entries whose original content matches the current query, so the
   *  transform can keep those outputs uncompressed this turn (proactive
   *  expansion) instead of hiding them behind a marker. */
  async expandableHashes(sessionID: string, query: string | undefined): Promise<Set<string>> {
    const out = new Set<string>()
    if (!query || !this.backend?.list) return out
    const terms = extractQueryTerms(query)
    if (!terms) return out
    try {
      const entries = await this.backend.list(["plugin", "ccr", sessionID])
      for (const entry of entries) {
        if (isExpired(entry, Date.now())) continue
        if (scoreText(entry.original.slice(0, 4000), terms) >= 2) out.add(entry.hash)
      }
    } catch {
      // Proactive expansion is best-effort; never fail the transform.
    }
    return out
  }
}
