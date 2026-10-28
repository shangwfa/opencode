/**
 * 答案回写服务（Karpathy 模式的 Query→file back）：把有价值的问答沉淀为 Wiki 页面。
 * 约束（不降低证据强度）：
 * - 调用方必须提交 claims（statement + evidence[documentId, quote]），quote 逐字锚定当前文档原文；
 * - 回写页面 status='needs_review'：不进入默认检索，等待人工确认或后续升级；
 * - 概念 slug 带 answer- 前缀：编译计划跳过（答案不参与来源增删，不会被重编撤销）；
 * - 每次回写记入追加式操作日志（answer_filed）并写修订快照（reason='answer-filed'）。
 */
import { createHash } from 'crypto'
import { db, documents, pool, schemaName, wikiCollections, wikiConcepts, wikiPageRevisions } from '../db/index.js'
import { and, eq } from 'drizzle-orm'
import { buildSourceManifest } from './wiki-provenance.js'
import { WikiActivityLogService } from './wiki-activity-log.service.js'
import { conceptToSlug } from './wiki-prompts.js'

export interface FiledEvidence {
  documentId: string
  quote: string
}

export interface FiledClaim {
  statement: string
  evidence: FiledEvidence[]
}

export interface FileAnswerRequest {
  question: string
  answerMarkdown: string
  claims: FiledClaim[]
}

export class WikiAnswerService {
  constructor(private activityLog: WikiActivityLogService) {}

  async fileAnswer(collectionId: string, request: FileAnswerRequest): Promise<{ conceptId: string; slug: string }> {    const [collection] = await db.select().from(wikiCollections).where(eq(wikiCollections.id, collectionId)).limit(1)
    if (!collection) throw new Error(`Wiki collection ${collectionId} not found`)
    if (!request.question?.trim() || !request.answerMarkdown?.trim()) throw new Error('question and answerMarkdown are required')
    if (!request.claims?.length) throw new Error('claims with evidence are required: answers must be traceable to sources')

    const docs = await db.select().from(documents).where(eq(documents.knowledgeBaseId, collection.knowledgeBaseId))
    const docsById = new Map(docs.map(doc => [doc.id, doc]))
    for (const claim of request.claims) {
      if (!claim.statement?.trim() || !claim.evidence?.length) throw new Error('each claim needs a statement and at least one evidence')
      for (const evidence of claim.evidence) {
        const doc = docsById.get(evidence.documentId)
        if (!doc) throw new Error(`Unknown document: ${evidence.documentId}`)
        // 逐字锚定：quote 必须存在于该文档当前原文（与页面证据校验同一 manifest 语义）。
        const manifest = buildSourceManifest(doc as any)
        if (!manifest.blocks.some(block => block.text.includes(evidence.quote.trim()))) {
          throw new Error(`Quote not found in document ${evidence.documentId}: ${evidence.quote.slice(0, 50)}`)
        }
      }
    }

    const now = new Date()
    const questionKey = request.question.trim().slice(0, 80)
    const slug = `answer-${conceptToSlug(questionKey).slice(0, 60)}-${createHash('sha256').update(questionKey).digest('hex').slice(0, 8)}`
    const existing = await db.select().from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.slug, slug))).limit(1)
    const conceptId = existing[0]?.id ?? `wiki_concept_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const revision = (existing[0]?.revision ?? 0) + 1
    const content = {
      definition: questionKey,
      summary: request.answerMarkdown.slice(0, 200),
      sections: [{ heading: '回写答案', content: request.answerMarkdown, sourceRefs: [], claims: request.claims }],
    }
    const values = { conceptName: questionKey, definition: questionKey, summary: content.summary,
      content, tags: ['answer'], occurrenceCount: request.claims.length,
      status: 'needs_review' as const, citationStatus: 'verified' as const, revision, updatedAt: now }
    if (existing[0]) {
      await db.update(wikiConcepts).set(values)
        .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, conceptId)))
    } else {
      await db.insert(wikiConcepts).values({ id: conceptId, collectionId, slug, createdAt: now, ...values })
    }
    await db.insert(wikiPageRevisions).values({ id: `wiki_rev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      conceptId, collectionId, revision, reason: 'answer-filed', pageSnapshot: values,
      sourceSnapshot: request.claims.flatMap(claim => claim.evidence.map(evidence =>
        ({ documentId: evidence.documentId, quote: evidence.quote }))), createdAt: now })
    await this.activityLog.append(collectionId, 'answer_filed', { question: questionKey, conceptId, claims: request.claims.length })
    return { conceptId, slug }
  }

  /**
   * 答案人工升级（闭环最后一环）：approve → compiled（进入默认检索）；reject → archived（下线不可见）。
   * 仅接受 answer- 页面的 needs_review 状态，写修订与日志；正文不被改写（不触碰证据链）。
   */
  async reviewAnswer(collectionId: string, conceptId: string, action: 'approve' | 'reject'): Promise<{ status: string }> {
    const [concept] = await db.select().from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, conceptId))).limit(1)
    if (!concept) throw new Error('Concept not found')
    if (!concept.slug.startsWith('answer-')) throw new Error('Only filed answers (answer- pages) can be reviewed')
    if (concept.status !== 'needs_review') throw new Error(`Answer is not awaiting review (status=${concept.status})`)

    const status = action === 'approve' ? 'compiled' : 'archived'
    const revision = (concept.revision ?? 0) + 1
    const now = new Date()
    await db.update(wikiConcepts).set({ status, revision, updatedAt: now })
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, conceptId)))
    await db.insert(wikiPageRevisions).values({ id: `wiki_rev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      conceptId, collectionId, revision, reason: action === 'approve' ? 'human-approved' : 'human-rejected',
      pageSnapshot: { ...concept, status, revision }, sourceSnapshot: [], createdAt: now })
    await this.activityLog.append(collectionId, action === 'approve' ? 'answer_approved' : 'answer_rejected',
      { conceptId, question: concept.conceptName })
    return { status }
  }

  /**
   * 概念归档/恢复（人工下线）：archived 不进默认检索、导航、导出与重编（编译计划跳过，不会被动复活）。
   */
  async setConceptArchived(collectionId: string, conceptId: string, archived: boolean): Promise<{ status: string }> {
    const [concept] = await db.select().from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, conceptId))).limit(1)
    if (!concept) throw new Error('Concept not found')
    if (concept.slug === '_index') throw new Error('Index page cannot be archived')
    const status = archived ? 'archived' : 'compiled'
    const revision = (concept.revision ?? 0) + 1
    const now = new Date()
    await db.update(wikiConcepts).set({ status, revision, updatedAt: now })
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, conceptId)))
    await db.insert(wikiPageRevisions).values({ id: `wiki_rev_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      conceptId, collectionId, revision, reason: archived ? 'archived' : 'unarchived',
      pageSnapshot: { ...concept, status, revision }, sourceSnapshot: [], createdAt: now })
    await this.activityLog.append(collectionId, archived ? 'concept_archived' : 'concept_unarchived',
      { conceptId, conceptName: concept.conceptName })
    return { status }
  }

  /**
   * 文档→概念反查：哪些 verified 概念以该文档为来源（且哈希与当前文档一致），用于增量影响预判。
   */
  async conceptsByDocument(collectionId: string, documentId: string): Promise<Array<{ id: string; conceptName: string; slug: string; status: string }>> {
    const rows = await pool.query(`SELECT c.id, c.concept_name, c.slug, c.status
      FROM ${schemaName}.wiki_concepts c
      JOIN ${schemaName}.wiki_concept_sources s ON s.concept_id = c.id
      JOIN ${schemaName}.documents d ON d.id = s.document_id
      WHERE c.collection_id = $1 AND s.document_id = $2
        AND c.status = 'compiled' AND c.citation_status = 'verified'
        AND s.content_hash = encode(sha256(convert_to(d.content, 'UTF8')), 'hex')
      ORDER BY c.slug`, [collectionId, documentId])
    return rows.rows.map((row: any) => ({ id: row.id, conceptName: row.concept_name, slug: row.slug, status: row.status }))
  }
}
