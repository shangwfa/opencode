/**
 * 构建影刀 Harness 图库：RAG 36 篇真实文档 → DocumentIngestPipeline 完整链路入库。
 *
 * 链路：tiptap→markdown → 章节分块 → LLM 抽取(azure/gpt-5.5 内网) → 跨chunk合并 →
 *       属性图 + 文档/chunk 溯源 + RDF facts，实体嵌入走 inner embedding。
 *
 * 用法：
 *   DATABASE_URL=... 及内网代理环境变量就绪后：
 *   bun run script/build-harness-graph.ts            # 断点续跑（进度文件跳过已完成）
 *   bun run script/build-harness-graph.ts --fresh    # 清空目标图 KB 重新构建
 *
 * 输出：script/.harness-graph-progress.json（进度）+ stdout 汇总。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { Pool } from 'pg'
import { getDatabaseSchema } from '../src/config/env.js'
import { PgGraphAdapter } from '../src/graph/pg-adapter/adapter.js'
import { DocumentIngestPipeline } from '../src/graph/pipeline/document-pipeline.js'
import { defaultEmbedFn } from '../src/graph/extraction/index.js'
import { getGraphAdapter } from '../src/graph/pg-adapter/index.js'

const SOURCE_KB = 'kb_yingdao_harness_zh_cn'
const GRAPH_KB = 'kb_yingdao_harness_graph'
const PROGRESS_FILE = new URL('./.harness-graph-progress.json', import.meta.url).pathname

type DocRow = { id: string; content: string; metadata: { docName?: string } }
type DocResult = {
  id: string
  name: string
  status: 'ok' | 'fail'
  mode?: string
  chunkCount?: number
  nodeCount?: number
  edgeCount?: number
  emptyChunks?: number
  error?: string
  ms: number
}

const progress: { results: DocResult[] } = existsSync(PROGRESS_FILE)
  ? JSON.parse(readFileSync(PROGRESS_FILE, 'utf8'))
  : { results: [] }
const doneIds = new Set(progress.results.filter((r) => r.status === 'ok').map((r) => r.id))

const schemaName = getDatabaseSchema()
const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.KNOWLEDGE_DATABASE_URL })
const adapter = new PgGraphAdapter(pool, schemaName, 1536)
await adapter.init()

if (process.argv.includes('--fresh')) {
  await adapter.deleteGraph(GRAPH_KB)
  progress.results = []
  doneIds.clear()
  console.log(`[fresh] 已清空图知识库 ${GRAPH_KB}`)
}

const { rows: docs } = await pool.query<DocRow>(
  `SELECT id, content, metadata FROM ${schemaName}.documents
   WHERE knowledge_base_id = $1 ORDER BY id`,
  [SOURCE_KB]
)
const limit = Number(process.env.BUILD_LIMIT ?? 0)
const sourceDocs = limit > 0 ? docs.slice(0, limit) : docs
console.log(`[源] ${SOURCE_KB} 共 ${docs.length} 篇；已完成 ${doneIds.size}，待处理 ${sourceDocs.length - doneIds.size}${limit ? `（BUILD_LIMIT=${limit} 烟测）` : ''}`)

const embedFn = await defaultEmbedFn()
const pipeline = new DocumentIngestPipeline(adapter, {
  tracker: adapter.chunkTracker,
  embedFn,
  concurrency: 3,
  extractMaxRetries: 2,
  extractTimeoutMs: 180_000,
})

/** 单篇入库（进度落盘在调用方） */
async function ingestOne(pipeline: DocumentIngestPipeline, doc: DocRow): Promise<DocResult> {
  const name = doc.metadata.docName ?? doc.id
  const started = Date.now()
  try {
    const result = await pipeline.ingest(JSON.parse(doc.content), {
      type: 'tiptap',
      knowledgeBaseId: GRAPH_KB,
      documentId: doc.id,
      chunkCheckpoint: true,
      extractTimeoutMs: 180_000,
    })
    return {
      id: doc.id, name, status: 'ok', ms: Date.now() - started,
      mode: result.mode, chunkCount: result.chunkCount, nodeCount: result.nodeCount,
      edgeCount: result.edgeCount, emptyChunks: result.emptyExtractionChunkCount,
    }
  } catch (e: any) {
    return { id: doc.id, name, status: 'fail', error: String(e.message ?? e), ms: Date.now() - started }
  }
}

// 篇间并行（默认 2 路）：断点续跑按完成序输出，进度文件在每篇完成时落盘。
const DOC_PARALLEL = Number(process.env.DOC_PARALLEL ?? 2)
let processed = doneIds.size
const queue = [...sourceDocs.filter((d) => !doneIds.has(d.id))]
const workers = Array.from({ length: Math.min(DOC_PARALLEL, queue.length) }, async () => {
  while (queue.length > 0) {
    const doc = queue.shift()!
    const entry = await ingestOne(pipeline, doc)
    progress.results.push(entry)
    processed++
    console.log(`[${processed}] ${entry.status === 'ok' ? 'ok' : 'FAIL'} ${entry.name}${entry.status === 'ok' ? ` mode=${entry.mode} chunks=${entry.chunkCount} nodes=${entry.nodeCount} edges=${entry.edgeCount} empty=${entry.emptyChunks}` : `: ${entry.error}` } ${entry.ms}ms`)
    writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2))
  }
})
await Promise.all(workers)

const ok = progress.results.filter((r) => r.status === 'ok')
const fail = progress.results.filter((r) => r.status === 'fail')
const stats = await pool.query(
  `SELECT
     (SELECT count(*) FROM ${schemaName}.graph_nodes WHERE knowledge_base_id=$1) AS nodes,
     (SELECT count(*) FROM ${schemaName}.graph_edges WHERE knowledge_base_id=$1) AS edges,
     (SELECT count(DISTINCT document_id) FROM ${schemaName}.graph_document_nodes gdn
        JOIN ${schemaName}.graph_nodes n ON n.id=gdn.node_id WHERE n.knowledge_base_id=$1) AS linked_docs,
     (SELECT count(*) FROM ${schemaName}.document_chunks WHERE document_id = ANY($2::varchar[])) AS chunks,
     (SELECT count(*) FROM ${schemaName}.rdf_quads WHERE graph_name LIKE 'urn:graph:%'||$1) AS rdf_quads`,
  [GRAPH_KB, docs.map((d) => d.id)]
)
console.log('\n=== 构建汇总 ===')
console.log(JSON.stringify({
  ok: ok.length, fail: fail.length,
  totalMs: ok.reduce((s, r) => s + r.ms, 0),
  modeLlm: ok.filter((r) => r.mode === 'llm').length,
  modeFallback: ok.filter((r) => r.mode === 'fallback').length,
  emptyChunkDocs: ok.filter((r) => (r.emptyChunks ?? 0) > 0).map((r) => r.name),
  graph: stats.rows[0],
  failures: fail.map((r) => ({ name: r.name, error: r.error?.slice(0, 120) })),
}, null, 2))
await pool.end()
