import { pgSchema, varchar, text, jsonb, integer, timestamp } from "drizzle-orm/pg-core"
import { getDatabaseSchema } from "../../config/env.js"

/**
 * llm-wiki 子模块的表定义（自包含，模式同 data-table）。
 *
 * 说明：外键（knowledge_bases / 级联删除）由 initWikiTables() 的建表 SQL 负责，
 * 此处 drizzle 定义不重复 .references（运行期仅用于生成查询 SQL）。
 */
const schema = pgSchema(getDatabaseSchema())

/**
 * Wiki 集合表（与 knowledge_bases 一对一）
 */
export const wikiCollections = schema.table("wiki_collections", {
  id: varchar("id", { length: 255 }).primaryKey(),
  knowledgeBaseId: varchar("knowledge_base_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }),
  status: varchar("status", { length: 50 }).notNull().default("active"),
  lastCompiledAt: timestamp("last_compiled_at"),
  conceptCount: integer("concept_count").default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

/**
 * Wiki 概念表
 */
export const wikiConcepts = schema.table("wiki_concepts", {
  revision: integer("revision").notNull().default(0),
  citationStatus: varchar("citation_status", { length: 50 }).notNull().default("legacy"),
  id: varchar("id", { length: 255 }).primaryKey(),
  collectionId: varchar("collection_id", { length: 255 }).notNull(),
  conceptName: varchar("concept_name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull(),
  definition: text("definition"),
  summary: text("summary"),
  content: jsonb("content"),
  tags: jsonb("tags").default("[]"),
  occurrenceCount: integer("occurrence_count").default(1),
  status: varchar("status", { length: 50 }).notNull().default("compiled"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})

/** 修订只追加；来源正文快照不依赖当前 documents 行。 */
export const wikiPageRevisions = schema.table("wiki_page_revisions", {
  id: varchar("id", { length: 255 }).primaryKey(),
  conceptId: varchar("concept_id", { length: 255 }).notNull(),
  collectionId: varchar("collection_id", { length: 255 }).notNull(),
  revision: integer("revision").notNull(),
  taskId: varchar("task_id", { length: 255 }),
  reason: varchar("reason", { length: 50 }).notNull(),
  pageSnapshot: jsonb("page_snapshot").notNull(),
  sourceSnapshot: jsonb("source_snapshot").notNull(),
  relationshipSnapshot: jsonb("relationship_snapshot").notNull().default([]),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/**
 * 用户可编辑 schema（Karpathy 模式第三层）：按集合版本化的编译规则配置。
 * 只开放结构化字段；证据校验规则（quote 逐字、refId 绑定）不在配置面，由服务端强制。
 */
export const wikiSchemas = schema.table("wiki_schemas", {
  id: varchar("id", { length: 255 }).primaryKey(),
  collectionId: varchar("collection_id", { length: 255 }).notNull(),
  version: integer("version").notNull(),
  config: jsonb("config").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/**
 * 追加式操作日志（Karpathy 模式的 log.md 对应物）：只允许 INSERT。
 * collection_id 为逻辑引用（无外键）：集合删除后日志保留，审计链不断。
 */
export const wikiActivityLog = schema.table("wiki_activity_log", {
  id: varchar("id", { length: 255 }).primaryKey(),
  collectionId: varchar("collection_id", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  detail: jsonb("detail").notNull().default({}),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/**
 * Wiki 概念来源表（联结表）
 */
export const wikiConceptSources = schema.table("wiki_concept_sources", {
  id: varchar("id", { length: 255 }).primaryKey(),
  conceptId: varchar("concept_id", { length: 255 }).notNull(),
  documentId: varchar("document_id", { length: 255 }).notNull(),
  contentHash: varchar("content_hash", { length: 64 }).notNull(),
  compiledAt: timestamp("compiled_at").notNull().defaultNow(),
})

/**
 * Wiki 关系表（概念关系图）
 */
export const wikiRelationships = schema.table("wiki_relationships", {
  origin: varchar("origin", { length: 50 }).notNull().default("legacy"),
  sourceRevision: integer("source_revision"),
  evidence: jsonb("evidence").notNull().default([]),
  id: varchar("id", { length: 255 }).primaryKey(),
  collectionId: varchar("collection_id", { length: 255 }).notNull(),
  sourceConceptId: varchar("source_concept_id", { length: 255 }).notNull(),
  targetConceptId: varchar("target_concept_id", { length: 255 }).notNull(),
  relationshipType: varchar("relationship_type", { length: 50 }).notNull(),
  strength: integer("strength").default(1),
  createdAt: timestamp("created_at").notNull().defaultNow(),
})

/**
 * Wiki 编译任务表
 */
export const wikiCompileTasks = schema.table("wiki_compile_tasks", {
  id: varchar("id", { length: 255 }).primaryKey(),
  collectionId: varchar("collection_id", { length: 255 }).notNull(),
  knowledgeBaseId: varchar("knowledge_base_id", { length: 255 }).notNull(),
  status: varchar("status", { length: 50 }).notNull().default("pending"),
  progress: jsonb("progress").notNull().default({}),
  documentId: varchar("document_id", { length: 255 }),
  workerId: varchar("worker_id", { length: 255 }),
  leaseExpiresAt: timestamp("lease_expires_at"),
  heartbeatAt: timestamp("heartbeat_at"),
  attempt: integer("attempt").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})
