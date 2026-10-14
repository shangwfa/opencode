/** 六个只读接口的真实 PG/Hono 或 Docker HTTP 契约；需显式启用，无 LLM。 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Pool } from 'pg'
import { PgGraphAdapter } from '../src/graph/pg-adapter/adapter.js'
import { createOwnedTestSchema } from './helpers/owned-schema.js'

const enabled = process.env.KNOWLEDGE_GRAPH_BROWSE_E2E === '1' && Boolean(process.env.KNOWLEDGE_DATABASE_URL)
const useDocker = process.env.KNOWLEDGE_GRAPH_BROWSE_DOCKER === '1'
const suite = enabled ? describe : describe.skip
const a = '11111111-1111-4111-8111-111111111111'
const b = '22222222-2222-4222-8222-222222222222'
const c = '33333333-3333-4333-8333-333333333333'
const d = '44444444-4444-4444-8444-444444444444'
const foreign = '55555555-5555-4555-8555-555555555555'
const missing = '66666666-6666-4666-8666-666666666666'
const kb = 'browse-a'

suite(`Graph browse ${useDocker ? 'Docker HTTP' : 'Hono request'} + PG`, () => {
  const schema = createOwnedTestSchema('browse')
  const container = schema.name.replaceAll('_', '-')
  let pool: Pool | undefined
  let adapter: PgGraphAdapter
  let app: import('hono').Hono | undefined
  let base = ''
  let created = false
  let before: Record<string, unknown> | undefined
  const tables = ['graph_nodes', 'graph_edges', 'graph_document_nodes', 'document_chunks',
    'document_chunk_extractions', 'entity_chunks', 'relation_chunks', 'rdf_quads', 'ontology_versions']
  const snapshot = async () => {
    const result: Record<string, unknown> = {}
    for (const table of tables) {
      const r = await pool!.query(`SELECT count(*)::int AS count,md5(coalesce(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),'')) AS hash FROM "${schema.name}".${table} t`)
      result[table] = r.rows[0]
    }
    return result
  }
  const docker = (...args: string[]) => {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 30_000 })
    if (result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${(result.stderr ?? '').replace(/(postgres(?:ql)?:\/\/)[^@\s]+@/g, '$1***@').slice(-400)}`)
    return result.stdout
  }
  const request = async (path: string, body?: unknown) => {
    const options = { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20_000) }
    const response = app ? await app.request(`/api/graph${path}`, options) : await fetch(`${base}/api/graph${path}`, options)
    const json: any = await response.json()
    if (response.status === 200) expect(JSON.stringify(json)).not.toContain('foreign-node-secret')
    return { status: response.status, json, data: json.data }
  }
  const relations = (id: string, query = '') => request(`/nodes/${id}/relations?knowledgeBaseId=${kb}${query}`)
  const closed = (graph: { nodes: any[]; edges: any[] }) => {
    const ids = new Set(graph.nodes.map(n => n.id))
    for (const node of graph.nodes) { expect(node.knowledgeBaseId).toBe(kb); expect(node.embedding).toBeUndefined() }
    for (const edge of graph.edges) {
      expect(edge.knowledgeBaseId).toBe(kb)
      expect(ids.has(edge.sourceId) && ids.has(edge.targetId)).toBe(true)
    }
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.KNOWLEDGE_DATABASE_URL })
    await schema.prepare(pool, schema.name)
    process.env.KNOWLEDGE_DATABASE_SCHEMA = schema.name
    adapter = new PgGraphAdapter(pool, schema.name)
    await adapter.init()
    for (const [id, name, type, properties] of [
      [a, 'Alpha', 'service', { active: true, tier: 'core', belongsToSet: ['backend'], sourceDocumentIds: ['doc-edge', 'doc-node-only'] }],
      [b, 'Beta', 'service', { active: true, tier: 'core', belongsToSet: ['backend'] }],
      [c, 'Gamma', 'database', { active: false, belongsToSet: ['storage'] }],
      [d, 'Delta', 'service', { active: false }],
      [foreign, 'Alpha', 'service', { secret: 'foreign-node-secret' }],
    ] as const) await adapter.addNode({ id, name, type, properties, knowledgeBaseId: id === foreign ? 'browse-b' : kb })
    for (const [sourceId, targetId, relationshipName, weight, knowledgeBaseId] of [
      [a, b, 'uses', 2, kb], [b, c, 'calls', 3, kb], [a, c, 'calls', 4, kb],
      [c, a, 'loop', 1, kb], [d, a, 'incoming', 1, kb], [a, b, 'uses,(comma)', 7, kb],
      [a, a, 'self', 0.5, kb], [a, foreign, 'cross-link', 100, kb], [a, b, 'foreign-tag', 100, 'browse-b'],
      [foreign, foreign, 'private', 1, 'browse-b'],
    ] as const) await adapter.addEdge({ sourceId, targetId, relationshipName, weight, knowledgeBaseId,
      properties: { sourceDocumentIds: sourceId === a && targetId === b && relationshipName === 'uses' ? ['doc-edge'] : [] } })
    await adapter.linkNodesToDocument({ documentId: 'doc-edge', nodeIds: [a, b], chunkIndex: 0 })
    await adapter.linkNodesToDocument({ documentId: 'doc-node-only', nodeIds: [a], chunkIndex: 1 })
    await adapter.linkNodesToDocument({ documentId: 'doc-edge10', nodeIds: [d], chunkIndex: 0 })
    await adapter.linkNodesToDocument({ documentId: 'doc-shared', nodeIds: [foreign], chunkIndex: 0 })
    await adapter.storeDocumentChunks([
      { documentId: 'doc-edge', chunkIndex: 0, content: 'Alpha uses Beta: actual relationship evidence.' },
      { documentId: 'foreign-only', chunkIndex: 0, content: 'FOREIGN-CHUNK-SECRET' },
      { documentId: 'doc-shared', chunkIndex: 0, content: 'AMBIGUOUS-CHUNK-SECRET' },
    ])
    await adapter.chunkTracker.addRelationChunk(a, b, 'uses', 'doc-edge#0', kb)
    await adapter.chunkTracker.addRelationChunk(a, b, 'uses', 'foreign-only#0', 'browse-b')
    await adapter.chunkTracker.addRelationChunk(a, b, 'uses', 'doc-shared#0', kb)
    await adapter.chunkTracker.addRelationChunk(foreign, foreign, 'private', 'doc-shared#0', 'browse-b')
    if (useDocker) {
      const preload = process.env.KNOWLEDGE_RECOVERY_PRELOAD_DIR
      const runtime = process.env.KNOWLEDGE_RECOVERY_RUNTIME_VOLUME
      if (!preload || !runtime) throw new Error('Requires Linux preload directory and runtime volume')
      const url = new URL(process.env.KNOWLEDGE_DATABASE_URL!)
      if (['127.0.0.1', 'localhost'].includes(url.hostname)) url.hostname = 'host.docker.internal'
      docker('run', '-d', '--name', container, '--publish', '127.0.0.1::18787',
        '--volume', `${resolve(import.meta.dir, '../../..')}:/repo:ro`, '--volume', `${preload}:/fixtures:ro`,
        '--volume', `${runtime}:/runtime:ro`, '--workdir', '/repo/packages/knowledge',
        '--env', `KNOWLEDGE_DATABASE_URL=${url}`, '--env', `KNOWLEDGE_DATABASE_SCHEMA=${schema.name}`,
        '--env', 'KNOWLEDGE_PORT=18787', '--env', 'no_proxy=host.docker.internal,localhost,127.0.0.1',
        '--env', 'KNOWLEDGE_LLM_BASE_URL=http://127.0.0.1:1', '--env', 'KNOWLEDGE_EMBEDDING_BASE_URL=http://127.0.0.1:1',
        'oven/bun:1.3.14', 'bun', 'run', '--preload', '/fixtures/linux-preload.mjs', 'src/server.ts')
      created = true
      base = `http://127.0.0.1:${docker('port', container, '18787/tcp').trim().split(':').pop()}`
      const deadline = Date.now() + 20_000
      while (true) {
        try { if ((await fetch(base + '/health', { signal: AbortSignal.timeout(1000) })).status === 200) break } catch {}
        if (Date.now() > deadline) throw new Error('Docker service startup timed out')
        await Bun.sleep(250)
      }
    } else {
      const { createKnowledgeApp } = await import('../src/app.js')
      app = await createKnowledgeApp({ initDatabase: false })
    }
    expect((await request(`/relation-types?knowledgeBaseId=${kb}`)).status).toBe(200)
    before = await snapshot()
  }, 60_000)

  afterAll(async () => {
    try {
      if (before) {
        const after = await snapshot()
        if (process.env.KNOWLEDGE_GRAPH_BROWSE_EVIDENCE) writeFileSync(process.env.KNOWLEDGE_GRAPH_BROWSE_EVIDENCE,
          JSON.stringify({ mode: useDocker ? 'docker-http' : 'hono-pg', schema: schema.name, before, after, readOnly: JSON.stringify(before) === JSON.stringify(after) }, null, 2))
        expect(after).toEqual(before)
      }
    } finally {
      try { if (created) docker('rm', '-f', container) } finally {
        if (!useDocker) { const { closeGraphEngine } = await import('../src/graph/pg-adapter/index.js'); closeGraphEngine() }
        if (pool) { try { await schema.cleanup(pool) } finally { await pool.end() } }
      }
    }
  })

  test('relations filters incoming/outgoing/both without dangling or cross-KB edges', async () => {
    for (const [direction, count] of [['both', 6], ['outgoing', 4], ['incoming', 3]] as const) {
      const result = await relations(a, `&direction=${direction}`)
      expect(result.status).toBe(200); expect(result.data.edges).toHaveLength(count); closed(result.data)
    }
  })
  test('relations pagination is stable with hasMore', async () => {
    const first = await relations(a, '&limit=1')
    const next = await relations(a, '&limit=1&offset=1')
    expect(first.data.hasMore).toBe(true)
    expect(first.data.edges).toHaveLength(1)
    expect(first.data.edges).not.toEqual(next.data.edges)
  })
  test('missing and foreign anchors both return scoped 404', async () => {
    expect((await relations(foreign)).status).toBe(404)
    expect((await relations(missing)).status).toBe(404)
  })
  test('subgraph combines type, attribute and label dimensions', async () => {
    const result = await request('/subgraph', { knowledgeBaseId: kb, nodeTypes: ['service'], attributes: { active: true }, nodeSetLabel: 'backend' })
    expect(result.data.nodes.map((n: any) => n.id)).toEqual([a, b])
    // 两条 Alpha→Beta 关系加 Alpha 自环，都属于诱导子图。
    expect(result.data.edges).toHaveLength(3); closed(result.data)
  })
  test('document filter is exact, not prefix based', async () => {
    const result = await request('/subgraph', { knowledgeBaseId: kb, documentId: 'doc-edge' })
    expect(result.data.nodes.map((n: any) => n.id)).toEqual([a, b]); closed(result.data)
  })
  test('empty KB has empty subgraph and relation types', async () => {
    const result = await request('/subgraph', { knowledgeBaseId: 'empty-kb' })
    expect(result.data.nodes).toEqual([]); expect(result.data.edges).toEqual([])
    expect((await request('/relation-types?knowledgeBaseId=empty-kb')).data.items).toEqual([])
  })
  test('subgraph node ID filter excludes foreign nodes and incident edges', async () => {
    const result = await request('/subgraph', { knowledgeBaseId: kb, nodeIds: [a, foreign] })
    expect(result.data.nodes.map((n: any) => n.id)).toEqual([a]); closed(result.data)
  })
  test('subgraph node and edge caps explicitly report truncation', async () => {
    const result = await request('/subgraph', { knowledgeBaseId: kb, maxNodes: 1, maxEdges: 1 })
    expect(result.data.nodes).toHaveLength(1); expect(result.data.edges.length).toBeLessThanOrEqual(1)
    expect(result.data.nodeHasMore).toBe(true); closed(result.data)
    const fullNodes = await request('/subgraph', { knowledgeBaseId: kb, maxEdges: 1 })
    expect(fullNodes.data.edgeHasMore).toBe(true)
  })
  test('cyclic neighborhood terminates and is endpoint-closed', async () => {
    const result = await request('/neighborhood', { knowledgeBaseId: kb, seedIds: [a], direction: 'outgoing', maxDepth: 4 })
    expect(result.data.nodes.map((n: any) => n.id)).toEqual([a, b, c])
    expect(result.data.truncated).toBe(false); closed(result.data)
  })
  test('neighborhood relation filter and one-hop depth', async () => {
    const result = await request('/neighborhood', { knowledgeBaseId: kb, seedIds: [a], relationTypes: ['uses'], maxDepth: 1 })
    expect(result.data.nodes.map((n: any) => n.id)).toEqual([a, b]); expect(result.data.edges).toHaveLength(1)
  })
  test('incoming neighborhood preserves original edge direction', async () => {
    const result = await request('/neighborhood', { knowledgeBaseId: kb, seedIds: [a], direction: 'incoming', maxDepth: 1 })
    expect(result.data.nodes.map((n: any) => n.id)).toEqual([a, c, d])
    expect(result.data.edges.some((e: any) => e.sourceId === d && e.targetId === a)).toBe(true); closed(result.data)
  })
  test('neighborhood caps do not produce edges to omitted nodes', async () => {
    const result = await request('/neighborhood', { knowledgeBaseId: kb, seedIds: [a], maxNodes: 1, maxEdges: 1 })
    expect(result.data.nodes).toHaveLength(1); expect(result.data.edges.length).toBeLessThanOrEqual(1)
    expect(result.data.truncated).toBe(true); closed(result.data)
  })
  test('foreign neighborhood seed is 404', async () => {
    expect((await request('/neighborhood', { knowledgeBaseId: kb, seedIds: [a, foreign] })).status).toBe(404)
  })
  test('paths preserve ordered nodes, actual edge properties and summed weights', async () => {
    const result = await request('/paths', { knowledgeBaseId: kb, sourceId: a, targetId: c, relationTypes: ['uses', 'calls'], maxDepth: 2 })
    expect(result.data.paths).toHaveLength(2)
    expect(result.data.paths.map((p: any) => p.totalWeight)).toEqual([4, 5])
    for (const path of result.data.paths) {
      expect(new Set(path.nodes.map((n: any) => n.id)).size).toBe(path.nodes.length)
      expect(path.nodes[0].id).toBe(a); expect(path.nodes.at(-1).id).toBe(c); closed(path)
      expect(path.totalWeight).toBe(path.edges.reduce((sum: number, e: any) => sum + e.weight, 0))
    }
  })
  test('parallel edge names containing commas retain separate paths', async () => {
    const result = await request('/paths', { knowledgeBaseId: kb, sourceId: a, targetId: c, maxDepth: 2 })
    expect(result.data.paths).toHaveLength(3)
    expect(result.data.paths.some((p: any) => p.edges.some((e: any) => e.relationshipName === 'uses,(comma)') && p.totalWeight === 10)).toBe(true)
  })
  test('same-node path is length zero and missing route is empty', async () => {
    const same = await request('/paths', { knowledgeBaseId: kb, sourceId: a, targetId: a })
    expect(same.data.paths[0].edges).toEqual([]); expect(same.data.paths[0].totalWeight).toBe(0)
    expect((await request('/paths', { knowledgeBaseId: kb, sourceId: a, targetId: d })).data.paths).toEqual([])
  })
  test('both-direction path may traverse incoming edge without rewriting it', async () => {
    const result = await request('/paths', { knowledgeBaseId: kb, sourceId: a, targetId: d, direction: 'both', maxDepth: 1 })
    expect(result.data.paths[0].nodes.map((n: any) => n.id)).toEqual([a, d])
    expect(result.data.paths[0].edges[0].sourceId).toBe(d)
  })
  test('path count cap reports truncation, foreign endpoint is not traversed', async () => {
    const result = await request('/paths', { knowledgeBaseId: kb, sourceId: a, targetId: c, maxPaths: 1 })
    expect(result.data.paths).toHaveLength(1); expect(result.data.truncated).toBe(true)
    expect((await request('/paths', { knowledgeBaseId: kb, sourceId: a, targetId: foreign })).status).toBe(404)
  })
  test('provenance uses edge sources, not shared node sources, and withholds ambiguous chunks', async () => {
    const result = await request('/edges/provenance', { knowledgeBaseId: kb, sourceId: a, targetId: b, relationshipName: 'uses' })
    expect(result.status).toBe(200); expect(result.data.documents).not.toContain('doc-node-only')
    expect(result.data.documents).not.toContain('foreign-only')
    expect(result.data.chunks.find((x: any) => x.documentId === 'doc-edge').content).toContain('actual relationship evidence')
    const ambiguous = result.data.chunks.find((x: any) => x.documentId === 'doc-shared')
    expect(ambiguous.content).toBeNull(); expect(ambiguous.contentAvailable).toBe(false)
    expect(JSON.stringify(result.data)).not.toContain('FOREIGN-CHUNK-SECRET')
    expect(JSON.stringify(result.data)).not.toContain('AMBIGUOUS-CHUNK-SECRET')
  })
  test('provenance pagination and relation SQL-injection strings are safe', async () => {
    const page = await request('/edges/provenance', { knowledgeBaseId: kb, sourceId: a, targetId: b, relationshipName: 'uses', limit: 1 })
    expect(page.data.chunks).toHaveLength(1); expect(page.data.hasMore).toBe(true)
    expect((await request('/edges/provenance', { knowledgeBaseId: kb, sourceId: a, targetId: b, relationshipName: "uses' OR 1=1 --" })).status).toBe(404)
  })
  test('relation type counts exclude cross-linked and wrong-KB edges', async () => {
    const result = await request(`/relation-types?knowledgeBaseId=${kb}`)
    expect(result.data.items.find((x: any) => x.name === 'calls').count).toBe(2)
    expect(result.data.items.some((x: any) => ['cross-link', 'foreign-tag', 'private'].includes(x.name))).toBe(false)
    const foreignResult = await request('/relation-types?knowledgeBaseId=browse-b')
    expect(foreignResult.data.items).toEqual([{ name: 'private', count: 1 }])
  })
})
