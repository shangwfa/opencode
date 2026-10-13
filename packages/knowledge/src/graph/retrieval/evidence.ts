import { createHash } from 'node:crypto'

export type EvidenceSource = 'document' | 'graph' | 'database'

export interface RetrievalEvidence {
  evidenceId: string
  sourceType: EvidenceSource
  content: string
  contentHash: string
  documentId?: string
  documentVersion?: string
  chunkId?: string
  chunkIndex?: number
  locator?: { page?: number; start?: number; end?: number }
  retrieval: { rank: number; score: number; method: string }
}

export interface AnswerClaim {
  claimId: string
  text: string
  evidenceIds: string[]
  referencedEvidenceIds: string[]
  support: 'direct' | 'unsupported' | 'invalid_reference'
}

export interface EvidenceCoverage {
  totalClaims: number
  supportedClaims: number
  unsupportedClaims: number
  invalidReferenceClaims: number
  evidenceCoverage: number
  citationPrecision: number
}

export function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function parseAnswerClaims(answer: string, evidenceIds: Set<string>): AnswerClaim[] {
  return answer.split(/\n+/).map((line) => line.trim()).filter(Boolean).map((text, index) => {
    const refs = [...text.matchAll(/\[([a-zA-Z0-9:_-]+)\]/g)].map((match) => match[1]).filter(Boolean)
    const valid = refs.filter((id) => evidenceIds.has(id))
    return {
      claimId: `claim_${index + 1}`,
      text,
      evidenceIds: valid,
      referencedEvidenceIds: refs,
      support: refs.length > 0 && valid.length === refs.length ? 'direct' : refs.length > 0 ? 'invalid_reference' : 'unsupported',
    }
  })
}

export function calculateEvidenceCoverage(claims: AnswerClaim[]): EvidenceCoverage {
  const totalClaims = claims.length
  const supportedClaims = claims.filter((claim) => claim.support === 'direct').length
  const invalidReferenceClaims = claims.filter((claim) => claim.support === 'invalid_reference').length
  const cited = claims.reduce((count, claim) => count + claim.referencedEvidenceIds.length, 0)
  const valid = claims.reduce((count, claim) => count + claim.evidenceIds.length, 0)
  return {
    totalClaims,
    supportedClaims,
    unsupportedClaims: totalClaims - supportedClaims - invalidReferenceClaims,
    invalidReferenceClaims,
    evidenceCoverage: totalClaims ? supportedClaims / totalClaims : 0,
    citationPrecision: cited ? valid / cited : 0,
  }
}
