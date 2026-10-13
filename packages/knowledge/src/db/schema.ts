import { pgTable, varchar, text, jsonb, integer, timestamp, pgSchema } from "drizzle-orm/pg-core"
import { relations } from "drizzle-orm"

/**
 * 创建 schema（用于隔离不同环境的数据）
 */
export function createSchema(schemaName: string) {
  const schema = pgSchema(schemaName)

  /**
   * 知识库表
   */
  const knowledgeBases = schema.table("knowledge_bases", {
    id: varchar("id", { length: 255 }).primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    description: text("description"),
    embeddingModel: varchar("embedding_model", { length: 255 }).notNull().default("openai/text-embedding-3-small"),
    defaultChunkStrategy: varchar("default_chunk_strategy", { length: 50 }).notNull().default("recursive"),
    defaultChunkConfig: jsonb("default_chunk_config"),
    // 索引相关字段
    indexName: varchar("index_name", { length: 255 }),
    indexDimension: integer("index_dimension").default(1536),
    indexCreated: integer("index_created").default(0), // 0=false, 1=true
    indexCreatedAt: timestamp("index_created_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /**
   * 文档表
   */
  const documents = schema.table("documents", {
    id: varchar("id", { length: 255 }).primaryKey(),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 255 })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    type: varchar("type", { length: 50 }).notNull().default("text"),
    chunkStrategy: varchar("chunk_strategy", { length: 50 }).notNull().default("recursive"),
    chunkConfig: jsonb("chunk_config"),
    metadata: jsonb("metadata"),
    chunkCount: integer("chunk_count").notNull().default(0),
    status: varchar("status", { length: 50 }).notNull().default("processing"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /**
   * 同步任务表
   */
  const syncTasks = schema.table("sync_tasks", {
    id: varchar("id", { length: 255 }).primaryKey(),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 255 })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    status: varchar("status", { length: 50 }).notNull().default("pending"),
    config: jsonb("config").notNull(),
    progress: jsonb("progress").notNull().default({}),
    failedDocuments: jsonb("failed_documents").default([]),
    error: text("error"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /**
   * 定义关系
   */
  const knowledgeBasesRelations = relations(knowledgeBases, ({ many }) => ({
    documents: many(documents),
    syncTasks: many(syncTasks),
  }))

  const documentsRelations = relations(documents, ({ one }) => ({
    knowledgeBase: one(knowledgeBases, {
      fields: [documents.knowledgeBaseId],
      references: [knowledgeBases.id],
    }),
  }))

  const syncTasksRelations = relations(syncTasks, ({ one }) => ({
    knowledgeBase: one(knowledgeBases, {
      fields: [syncTasks.knowledgeBaseId],
      references: [knowledgeBases.id],
    }),
  }))

  return {
    knowledgeBases,
    documents,
    syncTasks,
    knowledgeBasesRelations,
    documentsRelations,
    syncTasksRelations,
  }
}
