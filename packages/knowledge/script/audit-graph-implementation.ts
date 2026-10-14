/** 只读源库；所有写入仅在本脚本新建的随机 schema，结束后删除该 schema。 */
import { Pool } from 'pg'
import { PgGraphAdapter } from '../src/graph/pg-adapter/adapter.js'
import { GraphBuilder } from '../src/graph/extraction/graph-builder.js'
import { DocumentIngestPipeline } from '../src/graph/pipeline/document-pipeline.js'
import { UnifiedStoreEngine } from '../src/graph/unified/engine.js'
import { GraphCompletionRetriever } from '../src/graph/retrieval/graph-completion-retriever.js'

const url = process.env.KNOWLEDGE_DATABASE_URL || process.env.DATABASE_URL
if (!url) throw new Error('请设置测试 PostgreSQL 连接串')
const pool = new Pool({ connectionString: url })
const schema = `audit_graph_${crypto.randomUUID().replaceAll('-', '')}`
let created = false
const findings: Array<{ id: string; expected: unknown; actual?: unknown; status: string; error?: string }> = []
const adapter = new PgGraphAdapter(pool, schema, 64)
async function probe(id: string, expected: unknown, run: () => Promise<unknown>) {
  try {
    const actual = await run()
    findings.push({ id, expected, actual, status: JSON.stringify(actual) === JSON.stringify(expected) ? 'PASS' : 'FAIL' })
  } catch (error) {
    findings.push({ id, expected, status: 'ERROR', error: String(error) })
  }
}
try {
  await pool.query(`CREATE SCHEMA ${schema}`)
  created = true
  await adapter.init()
  const builder = new GraphBuilder(adapter)

  await probe('跨库同 documentId 删除隔离', true, async () => {
    for (const kb of ['isolation_a', 'isolation_b']) {
      await builder.buildFromExtraction({ entities: [{ name: kb, type: 'concept' }], triplets: [] }, {
        knowledgeBaseId: kb, documentId: 'same-doc', buildEntityTypeNodes: false,
      })
    }
    await new UnifiedStoreEngine(adapter, undefined, schema).deleteByDocument('same-doc', 'isolation_a')
    return (await adapter.getGraphData('isolation_b')).nodes.length === 1
  })

  await probe('边 upsert 合并来源数组', ['source-a', 'source-b'], async () => {
    const ids = await adapter.addNodes(['A', 'B'].map((name) => ({ knowledgeBaseId: 'edges', name, type: 'concept' })))
    for (const doc of ['source-a', 'source-b']) {
      await adapter.addEdges([{
        sourceId: ids[0], targetId: ids[1], relationshipName: 'uses', knowledgeBaseId: 'edges',
        properties: { sourceDocumentIds: [doc] },
      }])
    }
    return (await adapter.getEdges(ids[0]))[0].properties.sourceDocumentIds
  })

  await probe('批量节点写入失败原子性', 0, async () => {
    let failed = false
    try {
      await adapter.addNodes([
        { knowledgeBaseId: 'partial', name: '先写入节点', type: 'concept' },
        { knowledgeBaseId: 'partial', name: '错误向量节点', type: 'concept', embedding: [1, 0] },
      ])
    } catch { failed = true }
    if (!failed) throw new Error('故障注入未生效')
    return (await adapter.getGraphData('partial')).nodes.length
  })

  await probe('单文档多 chunk 删除不误判共享', 0, async () => {
    const [id] = await adapter.addNodes([{ knowledgeBaseId: 'multichunk', name: '同篇实体', type: 'concept' }])
    for (const chunkIndex of [0, 1]) {
      await adapter.linkNodesToDocument({ documentId: 'multi-doc', nodeIds: [id], chunkIndex })
    }
    await new DocumentIngestPipeline(adapter).removeDocument('multi-doc')
    return (await adapter.getGraphData('multichunk')).nodes.length
  })

  await probe('共享节点间独占来源边删除', 0, async () => {
    const ids = await adapter.addNodes(['共享A', '共享B'].map((name) => ({ knowledgeBaseId: 'shared', name, type: 'concept' })))
    for (const documentId of ['edge-owner', 'nodes-only-owner']) {
      await adapter.linkNodesToDocument({ documentId, nodeIds: ids })
    }
    await adapter.addEdges([{
      sourceId: ids[0], targetId: ids[1], relationshipName: 'uses', knowledgeBaseId: 'shared',
      properties: { sourceDocumentId: 'edge-owner' },
    }])
    await new UnifiedStoreEngine(adapter, undefined, schema).deleteByDocument('edge-owner', 'shared')
    return (await adapter.getGraphData('shared')).edges.length
  })

  await probe('词面锚点检索保持 topK 上限', 1, async () => {
    const ids = await adapter.addNodes(['审计主体', '目标一', '目标二', '目标三'].map((name) => ({
      knowledgeBaseId: 'anchor', name, type: 'concept',
    })))
    await adapter.addEdges(ids.slice(1).map((targetId) => ({
      sourceId: ids[0], targetId, relationshipName: '关联', knowledgeBaseId: 'anchor',
    })))
    const result = await new GraphCompletionRetriever(adapter).search(Array(64).fill(0), {
      knowledgeBaseId: 'anchor', queryText: '审计主体', topK: 1, neighborDepth: 1,
    })
    return result.triplets.length
  })
  await probe('chunk tracker 按文档删除前缀隔离', ['doc10#0', 'doc1_extra#0'], async () => {
    const [id] = await adapter.addNodes([{ knowledgeBaseId: 'prefix', name: '前缀实体', type: 'concept' }])
    for (const chunkId of ['doc1#0', 'doc10#0', 'doc1_extra#0']) {
      await adapter.chunkTracker.addEntityChunk(id, chunkId, 'prefix')
    }
    await adapter.chunkTracker.removeEntityChunksByDocument('doc1')
    return (await adapter.chunkTracker.getEntityChunks(id)).sort()
  })
  console.log(JSON.stringify({ schema, findings }, null, 2))
} catch (error) {
  console.error(String(error))
  process.exitCode = 1
} finally {
  try {
    // 仅清理由本脚本 CREATE SCHEMA 成功创建的随机 schema。
    if (created) await pool.query(`DROP SCHEMA ${schema} CASCADE`)
  } finally {
    await pool.end()
  }
}
