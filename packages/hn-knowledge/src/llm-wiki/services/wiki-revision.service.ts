import { and, desc, eq, inArray } from 'drizzle-orm'
import { db, wikiConcepts, wikiPageRevisions } from '../db/index.js'

export class WikiRevisionService {
  async list(collectionId: string, conceptId: string, page: number, pageSize: number) {
    const [concept] = await db.select({ id: wikiConcepts.id }).from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId), eq(wikiConcepts.id, conceptId)))
    if (!concept) return null
    const revisions = await db.select({ revision: wikiPageRevisions.revision, taskId: wikiPageRevisions.taskId,
      reason: wikiPageRevisions.reason, createdAt: wikiPageRevisions.createdAt })
      .from(wikiPageRevisions).where(and(eq(wikiPageRevisions.collectionId, collectionId), eq(wikiPageRevisions.conceptId, conceptId)))
      .orderBy(desc(wikiPageRevisions.revision)).limit(pageSize).offset((page - 1) * pageSize)
    return { items: revisions, page, pageSize }
  }

  async get(collectionId: string, conceptId: string, revision: number) {
    const [result] = await db.select().from(wikiPageRevisions).where(and(
      eq(wikiPageRevisions.collectionId, collectionId), eq(wikiPageRevisions.conceptId, conceptId), eq(wikiPageRevisions.revision, revision)))
    return result ?? null
  }

  /**
   * 修订 diff：两版 pageSnapshot 的字段级对比（definition/summary/tags 与逐段正文前后）。
   * 行级变更用逐行对比近似（不追求 LCS 最小编辑脚本），足够人工审阅"改了什么"。
   */
  async diff(collectionId: string, conceptId: string, revision: number, against: number) {
    const rows = await db.select().from(wikiPageRevisions).where(and(
      eq(wikiPageRevisions.collectionId, collectionId), eq(wikiPageRevisions.conceptId, conceptId),
      inArray(wikiPageRevisions.revision, [revision, against])))
    const from = rows.find(row => row.revision === against) ?? null
    const to = rows.find(row => row.revision === revision) ?? null
    if (!from || !to) return null
    const fromPage = from.pageSnapshot as Record<string, any> ?? {}
    const toPage = to.pageSnapshot as Record<string, any> ?? {}
    const lineDiff = (a: string, b: string) => {
      const aLines = String(a ?? '').split('\n')
      const bLines = String(b ?? '').split('\n')
      const changed = aLines !== bLines
      const removed = aLines.filter(line => !bLines.includes(line))
      const added = bLines.filter(line => !aLines.includes(line))
      return { changed, removed, added }
    }
    const sections: Array<{ heading: any; status: string; diff?: { changed: boolean; removed: string[]; added: string[] } }> =
      (toPage.sections as any[] ?? []).map((section, index) => {
        const prev = (fromPage.sections as any[] ?? [])[index]
        return { heading: section.heading, status: prev ? section.content === prev.content ? 'unchanged' : 'changed' : 'added',
          diff: prev ? lineDiff(prev.content, section.content) : undefined }
      })
    for (const [index, prev] of (fromPage.sections as any[] ?? []).entries()) {
      if (index >= (toPage.sections as any[] ?? []).length) {
        sections.push({ heading: prev.heading, status: 'removed' })
      }
    }
    return {
      from: { revision: against, reason: from.reason, createdAt: from.createdAt },
      to: { revision, reason: to.reason, createdAt: to.createdAt },
      definition: lineDiff(fromPage.definition, toPage.definition),
      summary: lineDiff(fromPage.summary, toPage.summary),
      tags: { from: fromPage.tags ?? [], to: toPage.tags ?? [] },
      status: { from: fromPage.status, to: toPage.status },
      sections,
    }
  }
}
