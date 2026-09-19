// Relevance scoring ported from Headroom's SmartCrusher/search scoring:
// word-overlap plus CJK bigram overlap against the current user query.
// Applied only on first compression of a given output — the chosen preview
// is content-addressed thereafter, keeping request-view bytes stable.

const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/

function isCjk(c: string): boolean {
  return CJK_RE.test(c)
}

export function cjkBigrams(text: string): Set<string> {
  const out = new Set<string>()
  let run: string[] = []
  for (const c of text.toLowerCase()) {
    if (isCjk(c)) {
      run.push(c)
    } else {
      for (let i = 0; i < run.length - 1; i++) out.add(run[i] + run[i + 1])
      run = []
    }
  }
  for (let i = 0; i < run.length - 1; i++) out.add(run[i] + run[i + 1])
  return out
}

export interface QueryTerms {
  words: Set<string>
  bigrams: Set<string>
}

export function extractQueryTerms(query: string | undefined): QueryTerms | undefined {
  if (!query || !query.trim()) return undefined
  const words = new Set(query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? [])
  const bigrams = cjkBigrams(query)
  if (words.size === 0 && bigrams.size === 0) return undefined
  return { words, bigrams }
}

export function scoreText(text: string, terms: QueryTerms | undefined): number {
  if (!terms) return 0
  const lower = text.toLowerCase()
  let score = 0
  for (const w of terms.words) {
    if (lower.includes(w)) score++
  }
  for (const b of terms.bigrams) {
    if (lower.includes(b)) score += 0.5
  }
  return score
}
