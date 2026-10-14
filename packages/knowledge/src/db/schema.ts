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
    // ── 文档平台(doc-platform)产品化字段 ──
    slug: varchar("slug", { length: 64 }),
    languageCode: varchar("language_code", { length: 32 }),
    isPublic: integer("is_public").default(0), // 0=私密, 1=公开
    ownerId: varchar("owner_id", { length: 64 }),
    settings: jsonb("settings"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /**
   * 文档表
   * content: 发布正文的 markdown/纯文本派生(分块输入)
   * contentJson / draftContentJson: 文档平台的结构化正文(TipTap JSON),仅文档平台文档使用
   * menuId 为空 = 纯语料文档(直接 API 添加),非空 = 文档平台文档(1:1 menus)
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
    // ── 文档平台(doc-platform)字段 ──
    menuId: varchar("menu_id", { length: 64 }),
    contentJson: jsonb("content_json"),
    draftContentJson: jsonb("draft_content_json"),
    publishedAt: timestamp("published_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /**
   * 菜单树(文档平台):文件夹/文档两级语义,兄弟链表排序(parent+previous)
   */
  const menus = schema.table("menus", {
    id: varchar("id", { length: 64 }).primaryKey(),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 255 })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    parentId: varchar("parent_id", { length: 64 }),
    previousId: varchar("previous_id", { length: 64 }),
    name: varchar("name", { length: 255 }).notNull(),
    type: varchar("type", { length: 16 }).notNull().default("doc"), // folder | doc
    iconUrl: text("icon_url"),
    slug: varchar("slug", { length: 255 }),
    enable: integer("enable").notNull().default(1),
    docUniqueId: varchar("doc_unique_id", { length: 64 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /**
   * 别名(文档平台):alias → 菜单,kb 内解析
   */
  const kbAliases = schema.table("kb_aliases", {
    alias: varchar("alias", { length: 255 }).primaryKey(),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 255 })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    menuId: varchar("menu_id", { length: 64 }).notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  })

  /**
   * 知识库×检索模式(多选):rag | llm-wiki | graph-rag
   * rag 模式的后端即 knowledge_bases 自身(backend_id 为空);
   * 其他模式 backend_id 指向各自实体(wiki collection / graph kb)
   */
  const kbModes = schema.table("kb_modes", {
    knowledgeBaseId: varchar("knowledge_base_id", { length: 255 })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    mode: varchar("mode", { length: 16 }).notNull(), // rag | llm-wiki | graph-rag
    enabled: integer("enabled").notNull().default(1),
    backendId: varchar("backend_id", { length: 255 }),
    config: jsonb("config"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  })

  /**
   * 文档派生任务(模式级异步状态):数据源保存/删除时按启用模式各插一行
   */
  const documentSyncTasks = schema.table("document_sync_tasks", {
    id: varchar("id", { length: 255 }).primaryKey(),
    knowledgeBaseId: varchar("knowledge_base_id", { length: 255 })
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    documentId: varchar("document_id", { length: 255 }).notNull(),
    mode: varchar("mode", { length: 16 }).notNull(),
    operation: varchar("operation", { length: 16 }).notNull(), // upsert | delete
    published: integer("published").notNull().default(1),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
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
    menus: many(menus),
    kbModes: many(kbModes),
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

  const menusRelations = relations(menus, ({ one }) => ({
    knowledgeBase: one(knowledgeBases, {
      fields: [menus.knowledgeBaseId],
      references: [knowledgeBases.id],
    }),
  }))

  const kbModesRelations = relations(kbModes, ({ one }) => ({
    knowledgeBase: one(knowledgeBases, {
      fields: [kbModes.knowledgeBaseId],
      references: [knowledgeBases.id],
    }),
  }))

  const documentSyncTasksRelations = relations(documentSyncTasks, ({ one }) => ({
    knowledgeBase: one(knowledgeBases, {
      fields: [documentSyncTasks.knowledgeBaseId],
      references: [knowledgeBases.id],
    }),
  }))

  return {
    knowledgeBases,
    documents,
    syncTasks,
    menus,
    kbAliases,
    kbModes,
    documentSyncTasks,
    knowledgeBasesRelations,
    documentsRelations,
    syncTasksRelations,
    menusRelations,
    kbModesRelations,
    documentSyncTasksRelations,
  }
}
