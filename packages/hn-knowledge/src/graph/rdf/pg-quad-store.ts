import type { Pool } from 'pg'
import { ensurePgSchema } from '../../db/ensure-schema.js'
import type { RdfQuad, RdfQuadPattern, RdfQuadStore } from './quad-store.js'
import type { OntologyQueryPlan } from '../query/ontology-query-plan.js'
import type { OntologyQueryResult } from '../query/ontology-query-executor.js'
import { compileOntologyQuerySql } from '../query/sql-compiler.js'

/** PostgreSQL named-graph 存储。四元组正文与当前属性图解耦，便于后续接入查询编译器。 */
export class PgRdfQuadStore implements RdfQuadStore {
  constructor(private pool: Pool, private schemaName: string) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schemaName)) throw new Error('非法 PostgreSQL schema 名称')
  }

  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await ensurePgSchema(client, this.schemaName)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schemaName}.rdf_quads (
          id VARCHAR(128) PRIMARY KEY,
          subject TEXT NOT NULL,
          predicate TEXT NOT NULL,
          object TEXT NOT NULL,
          object_kind VARCHAR(16) NOT NULL,
          datatype TEXT,
          language VARCHAR(64),
          graph_name TEXT NOT NULL,
          source_run_id VARCHAR(255),
          source_chunk_id VARCHAR(255),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `)
      await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rdf_quad_unique ON ${this.schemaName}.rdf_quads(graph_name, subject, predicate, object, object_kind, COALESCE(datatype, ''), COALESCE(language, ''))`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rdf_subject ON ${this.schemaName}.rdf_quads(graph_name, subject, predicate)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rdf_object ON ${this.schemaName}.rdf_quads(graph_name, predicate, object)`)
      await client.query(`CREATE INDEX IF NOT EXISTS idx_rdf_source_run ON ${this.schemaName}.rdf_quads(source_run_id)`)
    } finally {
      client.release()
    }
  }

  async add(quads: RdfQuad[]): Promise<void> {
    if (quads.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const quad of quads) {
        await client.query(`
          INSERT INTO ${this.schemaName}.rdf_quads
            (id, subject, predicate, object, object_kind, datatype, language, graph_name, source_run_id, source_chunk_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT DO NOTHING
        `, [quad.id, quad.subject.value, quad.predicate.value, quad.object.value, quad.object.kind,
          quad.object.datatype || null, quad.object.language || null, quad.graph, quad.sourceRunId || null, quad.sourceChunkId || null])
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async match(pattern: RdfQuadPattern = {}): Promise<RdfQuad[]> {
    const clauses: string[] = []
    const params: unknown[] = []
    for (const [column, value] of [['subject', pattern.subject], ['predicate', pattern.predicate], ['object', pattern.object], ['graph_name', pattern.graph]] as const) {
      if (value !== undefined) {
        params.push(value)
        clauses.push(`${column} = $${params.length}`)
      }
    }
    const client = await this.pool.connect()
    try {
      const result = await client.query(`SELECT * FROM ${this.schemaName}.rdf_quads${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''}`, params)
      return result.rows.map((row) => ({
        id: row.id,
        subject: { value: row.subject, kind: 'iri' },
        predicate: { value: row.predicate, kind: 'iri' },
        object: { value: row.object, kind: row.object_kind, datatype: row.datatype || undefined, language: row.language || undefined },
        graph: row.graph_name,
        sourceRunId: row.source_run_id || undefined,
        sourceChunkId: row.source_chunk_id || undefined,
      })) as RdfQuad[]
    } finally {
      client.release()
    }
  }

  async deleteBySourceChunkPrefix(prefix: string): Promise<void> {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&')
    await this.pool.query(`DELETE FROM ${this.schemaName}.rdf_quads WHERE source_chunk_id LIKE $1 ESCAPE '\\'`, [`${escaped}%`])
  }

  async executePlan(plan: OntologyQueryPlan): Promise<OntologyQueryResult> {
    const compiled = compileOntologyQuerySql(plan, this.schemaName)
    const client = await this.pool.connect()
    try {
      const result = await client.query(compiled.text, compiled.params)
      return {
        bindings: result.rows.map((row) => ({
          values: Object.fromEntries(compiled.variables.map((variable) => [variable, { value: row[variable], kind: 'iri' }])),
          statementIds: Array.isArray(row.statementIds) ? row.statementIds : [],
          sourceChunkIds: Array.isArray(row.sourceChunkIds) ? row.sourceChunkIds : [],
          sourceRunIds: Array.isArray(row.sourceRunIds) ? row.sourceRunIds : [],
        })),
        scannedQuads: result.rowCount || 0,
      }
    } finally {
      client.release()
    }
  }
}
