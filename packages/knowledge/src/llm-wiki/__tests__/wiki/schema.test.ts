import { describe, it, expect } from 'bun:test'
import { getTableName } from 'drizzle-orm'
import {
  wikiCollections,
  wikiConcepts,
  wikiConceptSources,
  wikiRelationships,
  wikiCompileTasks,
} from '../../db/schema.js'

describe('Wiki Schema', () => {
  it('应该导出所有 5 张 Wiki 表', () => {
    expect(wikiCollections).toBeDefined()
    expect(wikiConcepts).toBeDefined()
    expect(wikiConceptSources).toBeDefined()
    expect(wikiRelationships).toBeDefined()
    expect(wikiCompileTasks).toBeDefined()
  })

  it('wiki_collections 表应该被正确定义', () => {
    expect(wikiCollections).toBeDefined()
    expect(getTableName(wikiCollections)).toBe('wiki_collections')
  })

  it('wiki_concepts 表应该被正确定义', () => {
    expect(getTableName(wikiConcepts)).toBe('wiki_concepts')
  })

  it('wiki_concept_sources 表应该被正确定义', () => {
    expect(getTableName(wikiConceptSources)).toBe('wiki_concept_sources')
  })

  it('wiki_relationships 表应该被正确定义', () => {
    expect(getTableName(wikiRelationships)).toBe('wiki_relationships')
  })

  it('wiki_compile_tasks 表应该被正确定义', () => {
    expect(getTableName(wikiCompileTasks)).toBe('wiki_compile_tasks')
  })
})
