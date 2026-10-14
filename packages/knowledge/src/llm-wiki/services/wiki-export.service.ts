/**
 * Markdown 导出（Karpathy 模式的人可读产物）：PG 仍是唯一真源，导出只读。
 * verified 概念导出完整正文；needs_review 标注【待确认】；answer- 前缀标注【回写答案】；
 * legacy/no_concepts/failed 不导出（不可作为有效知识）。
 */
import { db, wikiConcepts } from '../db/index.js'
import { and, eq, inArray, asc } from 'drizzle-orm'

export class WikiExportService {
  async exportCollection(collectionId: string): Promise<string> {
    const concepts = await db.select().from(wikiConcepts)
      .where(and(eq(wikiConcepts.collectionId, collectionId),
        inArray(wikiConcepts.status, ['compiled', 'needs_review'])))
      .orderBy(asc(wikiConcepts.slug))
    const lines: string[] = [`# Wiki Export (${collectionId})`, ``, `导出时间：${new Date().toISOString()}`, `概念数：${concepts.length}`, ``]
    for (const concept of concepts) {
      const flag = concept.slug.startsWith('answer-') ? '【回写答案】'
        : concept.status === 'needs_review' ? '【待确认】' : ''
      const content = concept.content as { sections?: Array<{ heading?: string; content?: string }> } | null
      lines.push(`## ${concept.conceptName} ${flag}`, ``)
      if (concept.summary) lines.push(`> ${concept.summary}`, ``)
      for (const section of content?.sections || []) {
        if (section.heading) lines.push(`### ${section.heading}`)
        if (section.content) lines.push(section.content)
        lines.push(``)
      }
      lines.push(`---`, ``)
    }
    return lines.join('\n')
  }
}
