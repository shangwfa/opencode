/**
 * 追加式操作日志服务：Wiki 演化历史的可审计记录（编译发布、答案回写、导出等事件）。
 * 表由触发器强制 append-only；集合删除后日志保留（collection_id 为逻辑引用），
 * 因此不校验集合存在性——删除过的集合仍可追溯历史。
 */
import { db, pool, schemaName, wikiActivityLog } from '../db/index.js'
import { desc, eq } from 'drizzle-orm'

export interface ActivityLogEntry {
  id: string
  collectionId: string
  type: string
  detail: Record<string, unknown>
  createdAt: Date
}

export class WikiActivityLogService {
  async append(collectionId: string, type: string, detail: Record<string, unknown> = {}): Promise<ActivityLogEntry> {
    const id = `wiki_log_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
    const [row] = await db.insert(wikiActivityLog)
      .values({ id, collectionId, type, detail, createdAt: new Date() })
      .returning()
    return row as ActivityLogEntry
  }

  async list(collectionId: string, page: number, pageSize: number): Promise<{ items: ActivityLogEntry[]; total: number }> {
    const items = await db.select().from(wikiActivityLog)
      .where(eq(wikiActivityLog.collectionId, collectionId))
      .orderBy(desc(wikiActivityLog.createdAt), desc(wikiActivityLog.id))
      .limit(pageSize).offset((page - 1) * pageSize)
    const countRows = await pool.query(
      `SELECT count(*)::int AS n FROM ${schemaName}.wiki_activity_log WHERE collection_id=$1`, [collectionId])
    return { items: items as ActivityLogEntry[], total: countRows.rows[0]?.n ?? 0 }
  }
}
