import { pgTable, uuid, varchar, text, jsonb, integer, real, timestamp, index, uniqueIndex, primaryKey } from 'drizzle-orm/pg-core'

const schemaName = 'test'

export const graphNodes = pgTable(
  'graph_nodes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    knowledgeBaseId: varchar('knowledge_base_id', { length: 255 }).notNull(),
    name: text('name').notNull(),
    type: varchar('type', { length: 255 }).notNull().default('entity'),
    properties: jsonb('properties').default({}),
    frequency: integer('frequency').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    kbIdx: index('idx_gn_kb_id').on(table.knowledgeBaseId),
    typeIdx: index('idx_gn_type').on(table.type),
    nameIdx: index('idx_gn_name').on(table.name),
    propsIdx: index('idx_gn_props').using('gin', table.properties),
    kbNameIdx: uniqueIndex('idx_gn_kb_name_unique').on(table.knowledgeBaseId, table.name),
  })
)

export const graphEdges = pgTable(
  'graph_edges',
  {
    sourceId: uuid('source_id').notNull(),
    targetId: uuid('target_id').notNull(),
    relationshipName: varchar('relationship_name', { length: 255 }).notNull(),
    properties: jsonb('properties').default({}),
    weight: real('weight').notNull().default(1.0),
    knowledgeBaseId: varchar('knowledge_base_id', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.sourceId, table.targetId, table.relationshipName] }),
    sourceIdx: index('idx_ge_source').on(table.sourceId),
    targetIdx: index('idx_ge_target').on(table.targetId),
    relIdx: index('idx_ge_rel').on(table.relationshipName),
    kbIdx: index('idx_ge_kb_id').on(table.knowledgeBaseId),
    propsIdx: index('idx_ge_props').using('gin', table.properties),
  })
)

export const graphMetadata = pgTable('graph_metadata', {
  key: varchar('key', { length: 255 }).primaryKey(),
  value: text('value').notNull(),
})

export const graphDocumentNodes = pgTable(
  'graph_document_nodes',
  {
    documentId: varchar('document_id', { length: 255 }).notNull(),
    nodeId: uuid('node_id').notNull(),
    chunkIndex: integer('chunk_index'),
    pipelineRunId: varchar('pipeline_run_id', { length: 255 }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.documentId, table.nodeId] }),
    docIdx: index('idx_gdn_doc_id').on(table.documentId),
    nodeIdx: index('idx_gdn_node_id').on(table.nodeId),
  })
)