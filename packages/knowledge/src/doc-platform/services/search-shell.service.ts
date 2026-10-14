/**
 * 智能检索外壳(决策 #11:默认 rag 能力)
 * 封装 rag hybridSearchService(语义向量 + pg_trgm 关键词 → RRF 融合),
 * 面向公开浏览页:kb 公开校验 → 检索 → 文档可见性过滤 → 面包屑/摘要组装
 */
import { and, eq, inArray } from "drizzle-orm"
import { db, knowledgeBases, menus } from "../../db/index.js"
import { hybridSearchService } from "../../rag/knowledge-base/services/index.js"
import type { MenuTreeNode } from "../types.js"

export interface SearchHit {
  menuId: string
  name: string
  /** 菜单路径面包屑(根→文档) */
  path: string[]
  snippet: string
  score: number
}

export interface SearchPublicResult {
  total: number
  page: number
  pageSize: number
  items: SearchHit[]
}

/** 摘要截断长度 */
const SNIPPET_LENGTH = 160

function toSnippet(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH)}…` : flat
}

export class SearchShellService {
  async searchPublic(
    kbSlug: string,
    params: { q: string; page?: number; pageSize?: number },
  ): Promise<SearchPublicResult & { kb: string; kbName: string }> {
    const q = params.q?.trim()
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(50, Math.max(1, params.pageSize ?? 10))
    if (!q) {
      return { total: 0, page, pageSize, items: [], kb: kbSlug, kbName: kbSlug }
    }

    // 公开校验:私密库一律 404 语义(调用方 routes 处理)
    const [kb] = await db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.slug, kbSlug))
      .limit(1)
    if (!kb || kb.isPublic !== 1) {
      throw Object.assign(new Error(`知识库不存在或未公开: ${kbSlug}`), { statusCode: 404 })
    }

    // 多召回用于可见性过滤 + 同文档去重后分页
    const recallK = page * pageSize + 20
    const results = await hybridSearchService.search(kb.id, q, { topK: recallK })

    // 同文档多 chunk 去重(保留最高分,rag 结果已按分数降序)
    const bestByDoc = new Map<string, { text: string; score: number; menuId?: string; menuPath?: string[] }>()
    for (const item of results) {
      const menuId = (item.metadata?.menuId as string) || item.documentId
      if (!bestByDoc.has(menuId)) {
        bestByDoc.set(menuId, {
          text: item.text,
          score: item.score ?? 0,
          menuId,
          menuPath: item.metadata?.menuPath,
        })
      }
    }

    // 文档可见性过滤(enable)并取名称
    const menuIds = [...bestByDoc.keys()]
    const nameById = new Map<string, { name: string; enable: boolean }>()
    if (menuIds.length) {
      const rows = await db
        .select({ id: menus.id, name: menus.name, enable: menus.enable })
        .from(menus)
        .where(and(eq(menus.knowledgeBaseId, kb.id), inArray(menus.id, menuIds)))
      for (const row of rows) nameById.set(row.id, { name: row.name, enable: row.enable === 1 })
    }

    const items: SearchHit[] = []
    for (const [menuId, best] of bestByDoc) {
      const menu = nameById.get(menuId)
      if (!menu || !menu.enable) continue // 已删除/隐藏文档不入结果
      items.push({
        menuId,
        name: menu.name,
        path: best.menuPath ?? [menu.name],
        snippet: toSnippet(best.text),
        score: best.score,
      })
    }

    const total = items.length
    const start = (page - 1) * pageSize
    return {
      total,
      page,
      pageSize,
      items: items.slice(start, start + pageSize),
      kb: kb.slug || kb.id,
      kbName: kb.name,
    }
  }
}

export const searchShellService = new SearchShellService()
export type { MenuTreeNode }
