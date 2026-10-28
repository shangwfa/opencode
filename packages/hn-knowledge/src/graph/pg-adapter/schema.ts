import { pgSchema, uuid, varchar, text, jsonb, integer, real, timestamp, uniqueIndex, index, primaryKey } from 'drizzle-orm/pg-core'

export function createGraphSchema(schemaName: string) {
  const s = pgSchema(schemaName)

  const graphNodes = s.table(
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

  const graphEdges = s.table(
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

  const graphMetadata = s.table('graph_metadata', {
    key: varchar('key', { length: 255 }).primaryKey(),
    value: text('value').notNull(),
  })

  const graphDocumentNodes = s.table(
    'graph_document_nodes',
    {
      documentId: varchar('document_id', { length: 255 }).notNull(),
      nodeId: uuid('node_id').notNull(),
      chunkIndex: integer('chunk_index'),
      pageIndex: integer('page_index'),
      pipelineRunId: varchar('pipeline_run_id', { length: 255 }),
    },
    (table) => ({
      // 实际唯一性由 repository 的 COALESCE 表达式索引保证，允许同一节点关联多个 chunk。
      docNodeChunkIdx: uniqueIndex('idx_gdn_doc_node_chunk').on(table.documentId, table.nodeId, table.chunkIndex),
      docIdx: index('idx_gdn_doc_id').on(table.documentId),
      nodeIdx: index('idx_gdn_node_id').on(table.nodeId),
    })
  )

  const documentChunks = s.table(
    'document_chunks',
    {
      documentId: varchar('document_id', { length: 255 }).notNull(),
      chunkIndex: integer('chunk_index').notNull(),
      content: text('content').notNull(),
      pipelineRunId: varchar('pipeline_run_id', { length: 255 }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      pk: primaryKey({ columns: [table.documentId, table.chunkIndex] }),
      documentIdx: index('idx_dc_document').on(table.documentId),
    })
  )

  return { graphNodes, graphEdges, graphMetadata, graphDocumentNodes, documentChunks }
}

export type GraphNodesTable = ReturnType<typeof createGraphSchema>['graphNodes']
export type GraphEdgesTable = ReturnType<typeof createGraphSchema>['graphEdges']
export type GraphMetadataTable = ReturnType<typeof createGraphSchema>['graphMetadata']
export type GraphDocumentNodesTable = ReturnType<typeof createGraphSchema>['graphDocumentNodes']
export type DocumentChunksTable = ReturnType<typeof createGraphSchema>['documentChunks']
