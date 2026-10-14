import { pgSchema, varchar, text, jsonb, integer, timestamp } from 'drizzle-orm/pg-core'

/**
 * 与 knowledge_bases 对齐的元数据表，并记录动态关系表名与列定义
 */
export function createDatabaseSchema(schemaName: string) {
  const schema = pgSchema(schemaName)

  const databaseBases = schema.table('databases', {
    id: varchar('id', { length: 255 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    embeddingModel: varchar('embedding_model', { length: 255 }).notNull().default('openai/text-embedding-3-small'),
    defaultChunkStrategy: varchar('default_chunk_strategy', { length: 50 }).notNull().default('recursive'),
    defaultChunkConfig: jsonb('default_chunk_config'),
    indexName: varchar('index_name', { length: 255 }),
    indexDimension: integer('index_dimension').default(1536),
    indexCreated: integer('index_created').default(0),
    indexCreatedAt: timestamp('index_created_at'),
    vectorStrategy: varchar('vector_strategy', { length: 20 }).notNull().default('row'),
    keyColumn: varchar('key_column', { length: 63 }),
    dataTableName: varchar('data_table_name', { length: 255 }).notNull().unique(),
    columnDefinitions: jsonb('column_definitions').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow()
  })

  return { databaseBases }
}
