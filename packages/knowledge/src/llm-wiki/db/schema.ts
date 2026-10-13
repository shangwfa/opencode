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
  error: text("error"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
})
