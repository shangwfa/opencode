import { db, wikiCollections, wikiConcepts, wikiConceptSources, wikiRelationships, wikiCompileTasks } from '../db/index.js'
import { eq, desc, sql } from 'drizzle-orm'
import type { WikiCollection, WikiCollectionStatus } from '../types/wiki.types.js'

export class WikiCollectionService {
  /**
   * 生成 Wiki 集合 ID
   */
  private generateId(): string {
    return `wiki_col_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
  }

  /**
   * 创建 Wiki 集合（一个知识库只能有一个）
   */
  async createCollection(knowledgeBaseId: string, name?: string): Promise<WikiCollection> {
    const id = this.generateId()
    const now = new Date()

    try {
      const [result] = await db
        .insert(wikiCollections)
        .values({
          id,
          knowledgeBaseId,
          name: name || null,
          status: 'active' as WikiCollectionStatus,
          conceptCount: 0,
          createdAt: now,
          updatedAt: now
        })
        .returning()

      if (!result) {
        throw new Error('Failed to create wiki collection: no rows inserted')
      }

      return this.mapRowToCollection(result)
    } catch (error: any) {
      if (error.message?.includes('unique') || error.code === '23505') {
        throw new Error(`Knowledge base ${knowledgeBaseId} already has a wiki collection`)
      }
      throw error
    }
  }

  /**
   * 按 ID 获取集合
   */
  async getCollection(collectionId: string): Promise<WikiCollection | null> {
    try {
      const [result] = await db
        .select()
        .from(wikiCollections)
        .where(eq(wikiCollections.id, collectionId))

      if (!result) {
        return null
      }

      return this.mapRowToCollection(result)
    } catch (error: any) {
      throw new Error(`Failed to get wiki collection: ${error.message}`)
    }
  }

  /**
   * 按知识库 ID 获取集合
   */
  async getCollectionByKnowledgeBaseId(knowledgeBaseId: string): Promise<WikiCollection | null> {
    try {
      const [result] = await db
        .select()
        .from(wikiCollections)
        .where(eq(wikiCollections.knowledgeBaseId, knowledgeBaseId))

      if (!result) {
        return null
      }

      return this.mapRowToCollection(result)
    } catch (error: any) {
      throw new Error(`Failed to get wiki collection by knowledge base id: ${error.message}`)
    }
  }

  /**
   * 获取或创建集合（存在则返回，不存在则创建）
   */
  async getOrCreateCollection(knowledgeBaseId: string, name?: string): Promise<WikiCollection> {
    try {
      const existing = await this.getCollectionByKnowledgeBaseId(knowledgeBaseId)
      if (existing) {
        return existing
      }

      return await this.createCollection(knowledgeBaseId, name)
    } catch (error: any) {
      throw new Error(`Failed to get or create wiki collection: ${error.message}`)
    }
  }

  /**
   * 更新集合（状态、编译时间、概念数量等）
   */
  async updateCollection(
    collectionId: string,
    updates: {
      status?: WikiCollectionStatus
      lastCompiledAt?: Date
      conceptCount?: number
      name?: string
    }
  ): Promise<WikiCollection | null> {
    try {
      const updateData: Record<string, unknown> = {
        updatedAt: new Date()
      }

      if (updates.status !== undefined) {
        updateData.status = updates.status
      }
      if (updates.lastCompiledAt !== undefined) {
        updateData.lastCompiledAt = updates.lastCompiledAt
      }
      if (updates.conceptCount !== undefined) {
        updateData.conceptCount = updates.conceptCount
      }
      if (updates.name !== undefined) {
        updateData.name = updates.name
      }

      const [result] = await db
        .update(wikiCollections)
        .set(updateData)
        .where(eq(wikiCollections.id, collectionId))
        .returning()

      if (!result) {
        return null
      }

      return this.mapRowToCollection(result)
    } catch (error: any) {
      throw new Error(`Failed to update wiki collection: ${error.message}`)
    }
  }

  /**
   * 删除集合（级联删除概念、关系、编译任务）
   */
  async deleteCollection(collectionId: string): Promise<void> {
    try {
      await db.delete(wikiCollections).where(eq(wikiCollections.id, collectionId))
    } catch (error: any) {
      throw new Error(`Failed to delete wiki collection: ${error.message}`)
    }
  }

  /**
   * 列出所有集合（分页）
   */
  async listCollections(options?: {
    page?: number
    pageSize?: number
    knowledgeBaseId?: string
  }): Promise<{ items: WikiCollection[]; total: number; page: number; pageSize: number; totalPages: number }> {
    try {
      const page = options?.page || 1
      const pageSize = options?.pageSize || 10
      const offset = (page - 1) * pageSize
      // 越库隔离：显式传入 knowledgeBaseId 时必须过滤（曾因忽略该参数导致跨库集合泄漏）。
      const where = options?.knowledgeBaseId ? eq(wikiCollections.knowledgeBaseId, options.knowledgeBaseId) : undefined

      // 获取总数
      const [countResult] = await db
        .select({ count: sql<number>`count(*)` })
        .from(wikiCollections)
        .where(where)

      const total = countResult?.count || 0

      // 获取分页数据
      const results = await db
        .select()
        .from(wikiCollections)
        .where(where)
        .orderBy(desc(wikiCollections.createdAt))
        .limit(pageSize)
        .offset(offset)

      const items = results.map((row) => this.mapRowToCollection(row))
      const totalPages = Math.ceil(total / pageSize)

      return {
        items,
        total,
        page,
        pageSize,
        totalPages
      }
    } catch (error: any) {
      throw new Error(`Failed to list wiki collections: ${error.message}`)
    }
  }

  /**
   * 将数据库行转换为 WikiCollection 接口
   */
  private mapRowToCollection(row: Record<string, unknown>): WikiCollection {
    return {
      id: row.id as string,
      knowledgeBaseId: row.knowledgeBaseId as string,
      name: (row.name as string) || undefined,
      status: row.status as WikiCollectionStatus,
      lastCompiledAt: (row.lastCompiledAt as Date) || undefined,
      conceptCount: (row.conceptCount as number) || 0,
      createdAt: row.createdAt as Date,
      updatedAt: row.updatedAt as Date
    }
  }
}
