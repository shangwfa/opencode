function numberEnv(key: string, allowZero = false): number | undefined {
  const raw = process.env[key]
  if (!raw) return undefined
  const parsed = Number(raw)
  return Number.isFinite(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : undefined
}

function boolEnv(key: string): boolean | undefined {
  const raw = process.env[key]
  if (raw === undefined || raw === "") return undefined
  return raw !== "0" && raw.toLowerCase() !== "false"
}

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/

export interface CcrConfig {
  /** Tool outputs below this estimated token count are never compressed.
   *  Headroom parity: min_tokens_to_compress = 250. Compressions that
   *  wouldn't be a real win pass through untouched (0.7 ratio gate). */
  minTokens: number
  /** The most recent N messages keep full-fidelity tool outputs
   *  (Headroom parity: protect_recent = 4 — also keeps freshly retrieved
   *  content visible so the retrieve→re-compress loop cannot hide it). */
  protectRecent: number
  /** Approximate token budget of the compressed preview for large outputs.
   *  Mid-size outputs get a proportional budget (≈1/3 of their own size),
   *  so the default can stay low without eating into the savings. */
  previewTokens: number
  /** Entry TTL in seconds (Headroom parity: DEFAULT_CCR_TTL_SECONDS = 1800).
   *  0 means entries live until their session is deleted. */
  ttlSeconds: number
  /** Resize history images past the protection window to fit 512x512
   *  (Anthropic bills by pixels; -75% per history screenshot).
   *  Optional: undefined/false disables the pass. */
  imageResize?: boolean
}

export function loadCcrConfig(): CcrConfig {
  return {
    minTokens: numberEnv("OPENCODE_CCR_MIN_TOKENS") ?? 250,
    protectRecent: numberEnv("OPENCODE_CCR_PROTECT_RECENT") ?? 4,
    previewTokens: numberEnv("OPENCODE_CCR_PREVIEW_TOKENS") ?? 300,
    ttlSeconds: numberEnv("OPENCODE_CCR_TTL_SEC", true) ?? 1800,
    imageResize: boolEnv("OPENCODE_CCR_IMAGE_ENABLED") ?? true,
  }
}

export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (const char of text) {
    if (CJK_RE.test(char)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}
