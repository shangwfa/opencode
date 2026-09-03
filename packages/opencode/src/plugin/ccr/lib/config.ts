function numberEnv(key: string): number | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export interface CcrConfig {
  /** Tool outputs below this estimated token count are never compressed. */
  minTokens: number
  /** The most recent N messages keep full-fidelity tool outputs
   *  (Headroom parity: protect_recent=4 — also keeps freshly retrieved
   *  content visible so the retrieve→re-compress loop cannot hide it). */
  protectRecent: number
  /** Approximate token budget of the compressed preview. */
  previewTokens: number
  /** Entry TTL in seconds (Headroom parity, session-scale default 1800).
   *  0 means entries live until their session is deleted (SaaS default). */
  ttlSeconds: number
}

export function loadCcrConfig(): CcrConfig {
  return {
    minTokens: numberEnv("OPENCODE_CCR_MIN_TOKENS") ?? 1000,
    protectRecent: numberEnv("OPENCODE_CCR_PROTECT_RECENT") ?? 4,
    previewTokens: numberEnv("OPENCODE_CCR_PREVIEW_TOKENS") ?? 300,
    ttlSeconds: numberEnv("OPENCODE_CCR_TTL_SEC") ?? 0,
  }
}

export const estimateTokens = (text: string): number => Math.ceil(text.length / 4)
