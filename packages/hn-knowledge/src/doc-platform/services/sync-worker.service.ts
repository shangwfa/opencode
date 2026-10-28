/**
 * 派生任务异步 worker(决策 #11):
 * - 数据源保存(发布/草稿)与删除时,按知识库启用的模式各写一行 document_sync_tasks
 * - 本 worker 进程内串行消费:rag 模式复用 rag 的 DocumentSyncService 管道
 *   (内容 hash 幂等 / 失败重试 / sync_tasks 审计),其余模式置 failed(NOT_IMPLEMENTED)
 * - 保存动作不被阻塞:enqueue 立即返回,worker 异步消化
 */
import { and, asc, eq } from "drizzle-orm"
import {
  db,
  documentSyncTasks,
  documents,
  kbModes,
  knowledgeBases,
  menus,
} from "../../db/index.js"
import {
  documentSyncService,
  syncTaskService,
  vectorService,
} from "../../rag/knowledge-base/services/index.js"

function newId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`
}

type TaskRow = typeof documentSyncTasks.$inferSelect

export class SyncWorkerService {
  /** 防重入锁:同一时刻只有一个 drain 循环 */
  private draining = false

  /**
   * 写入派生任务并触发消费(立即返回,不阻塞调用方)
   */
  async enqueueDocumentSync(
    kbId: string,
    documentId: string,
    operation: "upsert" | "delete",
    published: boolean,
    store: Pick<typeof db, "select" | "insert"> = db,
    schedule = true,
  ): Promise<void> {
    const modes = await store
      .select({ mode: kbModes.mode })
      .from(kbModes)
      .where(and(eq(kbModes.knowledgeBaseId, kbId), eq(kbModes.enabled, 1)))
    if (!modes.length) return

    for (const { mode } of modes) {
      await store.insert(documentSyncTasks).values({
        id: newId("dst"),
        knowledgeBaseId: kbId,
        documentId,
        mode,
        operation,
        published: published ? 1 : 0,
        status: "pending",
      })
    }
    if (schedule) this.schedule()
  }

  /** 事务提交后再唤醒，避免 worker 读取未提交或旧正文。 */
  wake(): void {
    this.schedule()
  }

  /** 启动恢复:服务重启后把残留的 pending/processing 任务重新消费(upsert 幂等,安全) */
  async recoverPendingTasks(): Promise<number> {
    const pending = await db
      .select({ count: documentSyncTasks.id })
      .from(documentSyncTasks)
      .where(eq(documentSyncTasks.status, "pending"))
    const count = pending.length
    if (count > 0) {
      console.log(`[doc-platform/worker] 恢复 ${count} 个待处理派生任务`)
      // processing 状态的残留任务重置为 pending(进程崩溃恢复)
      await db
        .update(documentSyncTasks)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(documentSyncTasks.status, "processing"))
      this.schedule()
    }
    return count
  }

  private schedule(): void {
    if (this.draining) return
    this.draining = true
    setTimeout(() => {
      this.drain()
        .catch((error) => console.error("[doc-platform/worker] drain 异常:", error))
        .finally(() => {
          this.draining = false
        })
    }, 0)
  }

  private async drain(): Promise<void> {
    // 循环消费直到没有 pending 任务
    for (;;) {
      const claimed = await this.claimNext()
      if (!claimed) break
      await this.processTask(claimed)
    }
  }

  /** 条件更新抢占任务(状态 pending → processing),返回 null 表示队列空 */
  private async claimNext(): Promise<TaskRow | null> {
    const [candidate] = await db
      .select({ id: documentSyncTasks.id })
      .from(documentSyncTasks)
      .where(eq(documentSyncTasks.status, "pending"))
      .orderBy(asc(documentSyncTasks.createdAt))
      .limit(1)
    if (!candidate) return null
    const [claimed] = await db
      .update(documentSyncTasks)
      .set({ status: "processing", attempts: 1, updatedAt: new Date() })
      .where(and(eq(documentSyncTasks.id, candidate.id), eq(documentSyncTasks.status, "pending")))
      .returning()
    return claimed ?? null
  }

  private async processTask(task: TaskRow): Promise<void> {
    try {
      if (task.mode !== "rag") {
        throw new Error(`NOT_IMPLEMENTED: 检索模式 ${task.mode} 尚未接入`)
      }

      if (task.operation === "delete") {
        await this.ragDelete(task)
      } else if (task.published !== 1) {
        // 草稿保存:不进检索索引(未发布内容不泄漏),任务直接完成
      } else {
        await this.ragUpsert(task)
      }

      await db
        .update(documentSyncTasks)
        .set({ status: "synced", updatedAt: new Date() })
        .where(eq(documentSyncTasks.id, task.id))

      if (task.operation === "upsert" && task.published === 1) {
        await db
          .update(documents)
          .set({ status: "indexed", updatedAt: new Date() })
          .where(eq(documents.id, task.documentId))
      }
    } catch (error: any) {
      const message = error?.message || "Unknown error"
      console.error(`[doc-platform/worker] 任务失败 ${task.id}(${task.mode}/${task.operation}):`, message)
      await db
        .update(documentSyncTasks)
        .set({ status: "failed", error: message, updatedAt: new Date() })
        .where(eq(documentSyncTasks.id, task.id))
      if (task.operation === "upsert" && task.published === 1) {
        await db
          .update(documents)
          .set({ status: "failed", updatedAt: new Date() })
          .where(eq(documents.id, task.documentId))
      }
    }
  }

  /** rag upsert:构造单文档 sync task,完整复用 rag 管道(hash 幂等/重试/审计) */
  private async ragUpsert(task: TaskRow): Promise<void> {
    const [kb] = await db
      .select()
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, task.knowledgeBaseId))
      .limit(1)
    if (!kb) throw new Error(`知识库不存在: ${task.knowledgeBaseId}`)

    // 兜底确保向量索引存在(存量 KB / 建库时初始化失败的情况;幂等)
    await vectorService.createIndex(task.knowledgeBaseId, 1536).catch((error: any) => {
      throw new Error(`向量索引初始化失败: ${error.message}`)
    })

    const [doc] = await db.select().from(documents).where(eq(documents.id, task.documentId)).limit(1)
    if (!doc) {
      // 文档已被删除(如 delete 先于残留 upsert 消费):幂等 no-op,不标失败
      console.log(`[doc-platform/worker] upsert 跳过:文档已不存在 ${task.documentId}`)
      return
    }
    if (!doc.contentJson) throw new Error(`文档无发布内容: ${task.documentId}`)

    const { docPath, parentPath, name } = await this.menuContext(task.knowledgeBaseId, task.documentId)

    const config = {
      brandCode: kb.slug || kb.id,
      languageCode: kb.languageCode || "zh-cn",
      operation: "upsertDocument" as const,
      documents: [
        {
          docUniqueId: doc.id,
          menuId: doc.menuId ?? undefined,
          name,
          content: doc.contentJson,
          docPath,
          parentPath,
          metadata: {
            kbId: kb.id,
            kbSlug: kb.slug,
            menuId: doc.menuId,
            languageCode: kb.languageCode,
            menuPath: docPath.split("/"),
            publishedAt: doc.publishedAt?.toISOString(),
          },
        },
      ],
    }

    const taskId = await syncTaskService.createTask(task.knowledgeBaseId, config as any)
    await documentSyncService.syncDocumentsFromDocPlatform(taskId, task.knowledgeBaseId, config as any)

    const status = await syncTaskService.getTaskStatus(taskId)
    if (status?.status !== "completed") {
      const failedDoc = status?.failedDocuments?.[0]
      throw new Error(
        `rag 派生未完成(status=${status?.status})${failedDoc ? `: ${failedDoc.error}` : ""}`,
      )
    }
  }

  /** rag delete:documents 行可能已删,仅需 docUniqueId(delete 对不存在文档幂等 skip) */
  private async ragDelete(task: TaskRow): Promise<void> {
    const [kb] = await db
      .select({ slug: knowledgeBases.slug, languageCode: knowledgeBases.languageCode })
      .from(knowledgeBases)
      .where(eq(knowledgeBases.id, task.knowledgeBaseId))
      .limit(1)

    const config = {
      brandCode: kb?.slug || task.knowledgeBaseId,
      languageCode: kb?.languageCode || "zh-cn",
      operation: "deleteDocument" as const,
      documents: [{ docUniqueId: task.documentId }],
    }
    const taskId = await syncTaskService.createTask(task.knowledgeBaseId, config as any)
    await documentSyncService.syncDocumentsFromDocPlatform(taskId, task.knowledgeBaseId, config as any)
  }

  /** 菜单名称与路径(沿 parent 链向上) */
  private async menuContext(
    kbId: string,
    documentId: string,
  ): Promise<{ name: string; docPath: string; parentPath: string }> {
    const byId = new Map<string, { id: string; name: string; parentId: string | null }>()
    const rows = await db
      .select({ id: menus.id, name: menus.name, parentId: menus.parentId })
      .from(menus)
      .where(eq(menus.knowledgeBaseId, kbId))
    for (const row of rows) byId.set(row.id, row)

    const chain: string[] = []
    let cursor = byId.get(documentId)
    while (cursor) {
      chain.unshift(cursor.name)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined
    }
    const name = chain[chain.length - 1] || documentId
    return {
      name,
      docPath: chain.join("/"),
      parentPath: chain.slice(0, -1).join("/"),
    }
  }
}

export const syncWorkerService = new SyncWorkerService()
