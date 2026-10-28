import { describe, expect, it } from 'bun:test'
import {
  CreateBaseKnowledgeDocumentSchema,
  SearchBaseKnowledgeSchema,
  UpdateBaseKnowledgeDocumentSchema
} from './types.js'

describe('base knowledge request schemas', () => {
  it('accepts TipTap JSON for type=tiptap', () => {
    const result = CreateBaseKnowledgeDocumentSchema.parse({
      documentId: 'doc-1',
      type: 'tiptap',
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }]
      }
    })

    expect(result.type).toBe('tiptap')
    expect(result.content).toMatchObject({ type: 'doc' })
  })

  it('requires string content for markdown', () => {
    expect(() =>
      CreateBaseKnowledgeDocumentSchema.parse({
        documentId: 'doc-1',
        type: 'markdown',
        content: { type: 'doc' }
      })
    ).toThrow()
  })

  it('applies safe search defaults', () => {
    const result = SearchBaseKnowledgeSchema.parse({ query: 'test' })
    expect(result).toMatchObject({
      mode: 'hybrid',
      topK: 10,
      timeoutMs: 5000,
      failOnPartialTimeout: false,
      excludeDocumentIds: []
    })
  })

  it('allows update type to be omitted so the stored type can be retained', () => {
    const result = UpdateBaseKnowledgeDocumentSchema.parse({
      content: { type: 'doc', content: [] }
    })
    expect(result.type).toBeUndefined()
  })
})

