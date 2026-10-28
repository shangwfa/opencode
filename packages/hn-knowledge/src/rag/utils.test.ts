import { describe, expect, it } from 'bun:test'
import {
  getBaseKnowledgeIndexName,
  hashDocumentContent,
  serializeContent,
  toVectorLiteral
} from './utils.js'

describe('base knowledge utils', () => {
  it('uses collision-resistant table names instead of normalized external IDs', () => {
    const left = getBaseKnowledgeIndexName('a-b')
    const right = getBaseKnowledgeIndexName('a_b')
    expect(left).not.toBe(right)
    expect(left).toMatch(/^bk_[a-f0-9]{32}$/)
  })

  it('serializes TipTap JSON deterministically for idempotent content hashes', () => {
    const left = serializeContent({ type: 'doc', attrs: { b: 2, a: 1 } })
    const right = serializeContent({ attrs: { a: 1, b: 2 }, type: 'doc' })
    expect(left).toBe(right)
    expect(hashDocumentContent(left, 'tiptap')).toBe(hashDocumentContent(right, 'tiptap'))
  })

  it('formats vectors for pgvector parameters', () => {
    expect(toVectorLiteral([0.1, -0.2, 3])).toBe('[0.1,-0.2,3]')
  })
})

