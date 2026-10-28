import { describe, expect, it } from 'bun:test'
import { tagConflictingEdges } from './temporal-conflict-resolver.js'
import type { GraphEdge } from '../types.js'

function edge(relationName: string, weight: number): GraphEdge {
  const now = new Date()
  return {
    sourceId: 'product',
    targetId: 'macos',
    relationshipName: relationName,
    properties: {},
    weight,
    knowledgeBaseId: 'kb',
    createdAt: now,
    updatedAt: now,
  }
}

describe('conflicting relation resolution', () => {
  it('marks the lower-confidence assertion as superseded', () => {
    const result = tagConflictingEdges([
      edge('支持平台', 0.6),
      edge('不支持', 0.9),
    ], [['支持平台', '不支持']])

    expect(result).toHaveLength(1)
    expect(result[0].edge.relationshipName).toBe('支持平台')
    expect(result[0].edge.properties.superseded).toBe(true)
  })
})
