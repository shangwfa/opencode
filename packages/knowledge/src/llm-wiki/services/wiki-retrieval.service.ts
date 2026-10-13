import { WikiSearchService } from './wiki-search.service.js'
import { WikiCollectionService } from './wiki-collection.service.js'
import { WikiNavigateService } from './wiki-navigate.service.js'
import { db, wikiConcepts, documents } from '../db/index.js'
import { and, eq, inArray } from 'drizzle-orm'
import type { WikiRetrievalContext, WikiCitedPage, WikiBudgetAllocation } from '../types/wiki.types.js'

export class WikiRetrievalService {
  constructor(
    private wikiSearchService: WikiSearchService,
    private wikiCollectionService: WikiCollectionService,
    private wikiNavigateService: WikiNavigateService,
  ) {}

  async retrieve(
    knowledgeBaseId: string,
    query: string,
    options?: { budgetTokens?: number; topK?: number },
  ): Promise<WikiRetrievalContext> {
    const budgetTokens = options?.budgetTokens ?? 4000
    const topK = options?.topK ?? 10

    const collection = await this.wikiCollectionService.getCollectionByKnowledgeBaseId(knowledgeBaseId)
    if (!collection) {
      return this.emptyContext(budgetTokens)
    }

    const scoredResults = await this.wikiSearchService.searchConceptsScored(
      knowledgeBaseId,
      query,
      { topK },
    )

    const seedIds = new Set(scoredResults.map(r => r.concept.id))
    const expandedConcepts = await this.expandGraph(seedIds, scoredResults)

    const allCandidates = this.mergeResults(scoredResults, expandedConcepts)

    const pagesBudget = Math.floor(budgetTokens * 0.80)
    const indexBudget = Math.floor(budgetTokens * 0.15)
    const systemBudget = Math.floor(budgetTokens * 0.05)

    const citedPages = await this.selectWithinBudget(allCandidates, pagesBudget)

    let indexOverview = ''
    try {
      indexOverview = await this.getIndexOverview(collection.id, indexBudget)
    } catch {
      indexOverview = `Wiki: ${collection.id} (${collection.conceptCount ?? 0} concepts)`
    }

    const totalEstimatedTokens =
      citedPages.reduce((sum, p) => sum + this.estimatePageTokens(p), 0) +
      this.estimateTokens(indexOverview) +
      systemBudget

    const context = this.formatContext(citedPages)

    return {
      context,
      citedPages,
      indexOverview,
      totalEstimatedTokens,
      budgetAllocation: {
        totalBudget: budgetTokens,
        pagesBudget,
        indexBudget,
        systemBudget,
      },
    }
  }

  private async expandGraph(
    seedIds: Set<string>,
    scoredResults: Array<{ concept: { id: string }; score: number }>,
  ): Promise<Array<{ conceptId: string; conceptName: string; depth: number; relevanceScore: number }>> {
    const expanded: Array<{ conceptId: string; conceptName: string; depth: number; relevanceScore: number }> = []
    const seen = new Set(seedIds)

    for (const seed of scoredResults.slice(0, 5)) {
      try {
        const related = await this.wikiSearchService.getRelatedConcepts(seed.concept.id, 2)
        for (const concept of related) {
          if (seen.has(concept.id)) continue
          seen.add(concept.id)
          expanded.push({
            conceptId: concept.id,
            conceptName: concept.conceptName,
            depth: 1,
            relevanceScore: seed.score * 0.5,
          })
        }
      } catch {}
    }

    return expanded
  }

  private mergeResults(
    scoredResults: Array<{ concept: any; score: number; titleMatch: boolean; phraseMatch: boolean }>,
    expanded: Array<{ conceptId: string; conceptName: string; depth: number; relevanceScore: number }>,
  ): Array<{
    conceptId: string
    conceptName: string
    concept: any
    relevanceScore: number
    sourceDocumentIds: string[]
  }> {
    const merged = new Map<string, {
      conceptId: string
      conceptName: string
      concept: any
      relevanceScore: number
      sourceDocumentIds: string[]
    }>()

    for (const r of scoredResults) {
      merged.set(r.concept.id, {
        conceptId: r.concept.id,
        conceptName: r.concept.conceptName,
        concept: r.concept,
        relevanceScore: r.score,
        sourceDocumentIds: [],
      })
    }

    for (const e of expanded) {
      if (!merged.has(e.conceptId)) {
        merged.set(e.conceptId, {
          conceptId: e.conceptId,
          conceptName: e.conceptName,
          concept: null,
          relevanceScore: e.relevanceScore,
          sourceDocumentIds: [],
        })
      }
    }

    return Array.from(merged.values()).sort((a, b) => b.relevanceScore - a.relevanceScore)
  }

  private async selectWithinBudget(
    candidates: Array<{
      conceptId: string
      conceptName: string
      concept: any
      relevanceScore: number
      sourceDocumentIds: string[]
    }>,
    pagesBudget: number,
  ): Promise<WikiCitedPage[]> {
    const selected: WikiCitedPage[] = []
    let usedTokens = 0

    for (let i = 0; i < candidates.length; i++) {
      const candidate = candidates[i]

      let content: any = candidate.concept?.content ?? null
      let summary: string | undefined = candidate.concept?.summary

      if (!content && !summary) {
        try {
          const concept = await this.wikiSearchService.getConceptBySlug(
            candidate.concept?.collectionId ?? '',
            candidate.concept?.slug ?? '',
          )
          if (concept) {
            content = concept.content
            summary = concept.summary
          }
        } catch {}
      }

      const pageTokens = this.estimatePageTokensFromData(content, summary)
      if (usedTokens + pageTokens > pagesBudget && selected.length > 0) break

      let sourceDocumentIds = candidate.sourceDocumentIds
      if (sourceDocumentIds.length === 0 && candidate.concept?.id) {
        try {
          sourceDocumentIds = await this.wikiSearchService.getConceptSources(candidate.concept.id)
        } catch {}
      }

      selected.push({
        citationIndex: selected.length + 1,
        conceptId: candidate.conceptId,
        conceptName: candidate.conceptName,
        slug: candidate.concept?.slug ?? '',
        content,
        summary,
        relevanceScore: candidate.relevanceScore,
        sourceDocumentIds,
        sourceDocuments: [] as { docName: string; docPath?: string; docUrl?: string }[],
      })

      usedTokens += pageTokens
    }

    const allDocIds = [...new Set(selected.flatMap(p => p.sourceDocumentIds))]
    if (allDocIds.length > 0) {
      try {
        const docRows = await db
          .select({ id: documents.id, metadata: documents.metadata })
          .from(documents)
          .where(inArray(documents.id, allDocIds))
        const docMetaMap = new Map(docRows.map(d => {
          const meta = d.metadata as Record<string, any> || {}
          const docName = meta.filePath || meta.docName || meta.title || d.id
          const docPath = meta.docPath || meta.parentPath || undefined
          // fallback: generate docUrl from brandCode + languageCode + id (same pattern as documentSearchTool)
          let docUrl: string | undefined = meta.docUrl || undefined
          if (!docUrl && meta.brandCode && meta.languageCode) {
            docUrl = `https://www.yingdao.com/yddoc/${meta.brandCode}/${meta.languageCode}/${d.id}`
          }
          return [d.id, { docName, docPath, docUrl }]
        }))
        for (const page of selected) {
          page.sourceDocuments = page.sourceDocumentIds.map(id =>
            docMetaMap.get(id) || { docName: id }
          )
        }
      } catch {
        for (const page of selected) {
          page.sourceDocuments = page.sourceDocumentIds.map(id => ({ docName: id }))
        }
      }
    }

    return selected
  }

  private estimateTokens(text: string): number {
    if (!text) return 0
    const cjkCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef]/g) || []).length
    const otherCount = text.length - cjkCount
    return Math.ceil(cjkCount / 1.5 + otherCount / 4)
  }

  private estimatePageTokens(page: WikiCitedPage): number {
    const contentStr = page.content ? JSON.stringify(page.content) : ''
    const summaryStr = page.summary || ''
    return this.estimateTokens(contentStr + summaryStr)
  }

  private estimatePageTokensFromData(content: any, summary?: string): number {
    const contentStr = content ? JSON.stringify(content) : ''
    const summaryStr = summary || ''
    return this.estimateTokens(contentStr + summaryStr)
  }

  private formatIndexOverview(overview: any): string {
    const topNames = (overview.topConcepts || []).map((c: any) => c.conceptName).join(', ')
    return `Wiki 概览: ${overview.conceptCount} 个概念, ${overview.relationshipCount} 个关系。热门概念: ${topNames}`
  }

  private async getIndexOverview(collectionId: string, indexBudget: number): Promise<string> {
    const indexPage = await db
      .select({ content: wikiConcepts.content })
      .from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.slug, '_index')))
      .limit(1)

    if (indexPage[0]?.content) {
      const sections = (indexPage[0].content as any).sections ?? []
      const text = sections.map((s: any) => `${s.heading}:\n${s.content}`).join('\n\n')
      const tokens = this.estimateTokens(text)
      return tokens > indexBudget ? text.slice(0, indexBudget * 4) : text
    }

    const overview = await this.wikiNavigateService.getOverview(collectionId)
    const fallback = this.formatIndexOverview(overview)
    const tokens = this.estimateTokens(fallback)
    return tokens > indexBudget ? fallback.slice(0, indexBudget * 4) : fallback
  }

  private emptyContext(budgetTokens: number): WikiRetrievalContext {
    return {
      context: '',
      citedPages: [],
      indexOverview: '',
      totalEstimatedTokens: 0,
      budgetAllocation: {
        totalBudget: budgetTokens,
        pagesBudget: Math.floor(budgetTokens * 0.80),
        indexBudget: Math.floor(budgetTokens * 0.15),
        systemBudget: Math.floor(budgetTokens * 0.05),
      },
    }
  }

  private formatContext(citedPages: WikiCitedPage[]): string {
    if (citedPages.length === 0) return ''

    const parts: string[] = []
    for (const page of citedPages) {
      const summary = page.summary || ''
      const contentStr = page.content
        ? (typeof page.content === 'string' ? page.content : JSON.stringify(page.content))
        : ''
      const body = contentStr || summary || '(no content)'
      parts.push(`[${page.citationIndex}] ${page.conceptName}: ${body}`)
    }
    return parts.join('\n\n')
  }
}
