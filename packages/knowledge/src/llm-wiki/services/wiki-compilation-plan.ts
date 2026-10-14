import { createHash } from 'crypto'
import { conceptToSlug, type ExtractedConcept } from './wiki-prompts.js'

export interface CompilationDocument {
  id: string
  content: string
  type?: string
  knowledgeBaseId: string
  metadata?: unknown
}

export interface CompilationConcept {
  id: string
  conceptName: string
  slug: string
  content?: unknown
  updatedAt?: Date
  tags?: unknown
  revision?: number
  status?: string
}

export interface CompilationSource {
  conceptId: string
  documentId: string
  contentHash: string
}

export interface CompilationTarget {
  conceptName: string
  slug: string
  previous?: CompilationConcept
  sources: Array<{ document: CompilationDocument; contentHash: string }>
  relatedConcepts: Array<{ name: string; type: string }>
  aliasTags: string[]
}

/** 只规划来源差异；不执行模型调用，也不写数据库。 */
export function buildCompilationPlan(
  documents: CompilationDocument[],
  conceptsAll: CompilationConcept[],
  sources: CompilationSource[],
  extractions: Map<string, ExtractedConcept[]>,
  reconcileDeleted: boolean,
): CompilationTarget[] {
  const docsById = new Map(documents.map(doc => [doc.id, doc]))
  // 答案回写页（answer- 前缀）与人工归档页（archived）是用户治理层：不参与来源增删，重编不得撤销/复活。
  const concepts = conceptsAll.filter(concept => !concept.slug.startsWith('answer-') && concept.status !== 'archived')
  const conceptsById = new Map(concepts.map(concept => [concept.id, concept]))
  const targets = new Map<string, CompilationTarget>()
  const sourceMaps = new Map<string, Map<string, string>>()
  for (const concept of concepts) {
    targets.set(concept.slug, { conceptName: concept.conceptName, slug: concept.slug,
      previous: concept, sources: [], relatedConcepts: [],
      aliasTags: Array.isArray(concept.tags) ? concept.tags.filter((tag): tag is string => typeof tag === 'string' && tag.startsWith('alias:')) : [] })
    sourceMaps.set(concept.slug, new Map())
  }
  const affected = new Set<string>()
  for (const source of sources) {
    const concept = conceptsById.get(source.conceptId)
    if (!concept) continue
    const deleted = reconcileDeleted && !docsById.has(source.documentId)
    if (extractions.has(source.documentId) || deleted) affected.add(concept.slug)
    else sourceMaps.get(concept.slug)!.set(source.documentId, source.contentHash)
  }
  for (const [documentId, extracted] of extractions) {
    const doc = docsById.get(documentId)
    if (!doc) continue
    const hash = createHash('sha256').update(doc.content).digest('hex')
    for (const concept of extracted) {
      const slug = conceptToSlug(concept.concept)
      if (!targets.has(slug)) {
        targets.set(slug, { conceptName: concept.concept, slug, sources: [], relatedConcepts: [], aliasTags: [] })
        sourceMaps.set(slug, new Map())
      }
      affected.add(slug)
      sourceMaps.get(slug)!.set(documentId, hash)
      const target = targets.get(slug)!
      target.aliasTags = [...new Set([...target.aliasTags, ...(concept.aliases || []).map(alias => `alias:${alias}`)])]
      const relations = targets.get(slug)!.relatedConcepts
      for (const relation of concept.related_concepts || []) {
        const normalized = typeof relation === 'string'
          ? { name: relation, type: 'related' } : { name: relation.name, type: relation.type || 'related' }
        if (!relations.some(r => r.name === normalized.name && r.type === normalized.type)) relations.push(normalized)
      }
    }
  }
  return [...affected].map(slug => {
    const target = targets.get(slug)!
    target.sources = [...sourceMaps.get(slug)!].flatMap(([id, contentHash]) => {
      const document = docsById.get(id)
      return document ? [{ document, contentHash }] : []
    })
    return target
  })
}
