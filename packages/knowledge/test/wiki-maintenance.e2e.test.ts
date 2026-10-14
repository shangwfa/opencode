/**
 * Wiki 维护机制：真实 HTTP + PG，确定性模型，不评估真实 LLM 忠实度。
 * 原文来自已有 RAG 库，复制到唯一测试 schema；绝不更新原库。
 * KNOWLEDGE_DATABASE_URL 指向含 knowledge 原文 schema 的测试 PG。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'crypto'

const traces: string[] = []
let failPage = false
let failExtraction = false
let invalidExtraction = false
let badReference = false
let badQuote = false
let conflictPage = false
let rateLimitPage = false
let rateLimitExtraction = false
let lintOutput: string | null = null
let holdPage: Promise<void> | undefined
let pageStarted: (() => void) | undefined
const removedFact = '任务尚未结束时不要重复发起相同的全量同步。'
const conceptName = '同步任务'
const vector = Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0)

// 本用例只消费已有 Markdown；避免挂载宿主依赖时加载 macOS PDF 原生绑定。
mock.module('pdf-parse', () => ({ PDFParse: class {
  constructor() { throw new Error('Wiki Markdown 回归不应调用 PDF 解析器') }
} }))

mock.module('ai', () => ({
  embed: async () => ({ embedding: vector }),
  embedMany: async ({ values }: any) => ({ embeddings: values.map(() => vector) }),
  generateObject: async () => ({ object: {} }),
  streamText: async () => ({}),
  generateText: async ({ system = '' }: any) => {
    traces.push(system)
    const source = (system.split('--- 文档内容 ---\n\n')[1] || '').split('\n\n【重要提示】')[0]
    if (system.startsWith('你是一个知识提取引擎')) {
      if (rateLimitExtraction) {
        const err = new Error('Failed after 2 attempts. Last error: 您的账户已达到速率限制，请您控制请求频率')
        ;(err as any).name = 'AI_RetryError'
        throw err
      }
      if (failExtraction) throw new Error('受控提取失败')
      if (invalidExtraction) return { text: 'not a JSON extraction' }
      const concepts = source.trim() ? [{ concept: conceptName, summary: '同步任务的来源说明', is_new: false }] : []
      if (source.includes('# 从文档平台同步内容')) concepts.push({ concept: '文档平台同步', summary: '文档平台同步来源', is_new: false })
      return { text: JSON.stringify({ concepts }) }
    }
    if (system.startsWith('你是一个 Wiki 作者')) {
      pageStarted?.()
      if (holdPage) await holdPage
      if (rateLimitPage) {
        const err = new Error('Failed after 3 attempts. Last error: 您的账户已达到速率限制，请您控制请求频率')
        ;(err as any).name = 'AI_RetryError'
        throw err
      }
      if (failPage) return { text: '受控无效页面' }
      const materials: string = system.split('--- 源材料 ---\n\n')[1] || ''
      const digest = createHash('sha256').update(materials).digest('hex')
      // 瘦身协议：源材料清单为全局块序号 + 原文；证据用 blockIndex + anchor 指认。
      const flatBlocks: Array<{ blockIndex: number; documentTitle: string; text: string }> =
        materials.split('\n\n---\n\n').map(material => JSON.parse(material))
      const docOf = (title: string) => flatBlocks.filter(block => block.documentTitle === title)
      const blocksA = docOf('同步与重试') || flatBlocks.slice(0, Math.ceil(flatBlocks.length / 2))
      const blocksB = docOf('文档平台同步') || flatBlocks.slice(Math.ceil(flatBlocks.length / 2))
      const anchorOf = (text: string) => text.slice(0, Math.min(12, text.length))
      const claimOf = (block: { blockIndex: number; text: string }, forgeAnchor = false) => ({
        statement: block.text,
        evidence: [{ blockIndex: block.blockIndex, anchor: forgeAnchor ? '原文中不存在的锚点' : anchorOf(block.text) }],
      })
      const proof = [{ blockIndex: flatBlocks[0].blockIndex, anchor: anchorOf(flatBlocks[0].text) }]
      const claims = flatBlocks.map(block => claimOf(block, badQuote && block === flatBlocks[0]))
      if (badReference) claims[0].evidence[0].blockIndex = 999
      const statements = conflictPage && new Set(flatBlocks.map(block => block.documentTitle)).size > 1 ? [
        flatBlocks.find(block => block.text.includes('任务尚未结束时')) ?? blocksA[0],
        flatBlocks.find(block => block.text.includes('可以重复发起')) ?? blocksB[0],
      ].map(block => {
        const statement = block.text.includes('可以重复发起') ? '任务尚未结束时可以重复发起相同的全量同步。' : removedFact
        return { statement, evidence: [{ blockIndex: block.blockIndex, anchor: anchorOf(block.text) }] }
      }) : []
      return { text: JSON.stringify({ definition: `本次定义 ${digest}`, summary: `本次摘要 ${digest}`,
        definitionEvidence: proof, summaryEvidence: proof,
        tags: [digest], sections: [{ heading: '源材料汇编', content: flatBlocks.map(block => block.text).join('\n\n') + (statements.length ? '\n冲突待确认：同步任务的来源差异' : ''),
          sourceBlockIndexes: flatBlocks.map(block => block.blockIndex), claims }],
        conflicts: statements.length ? [{ topic: '同步任务的来源差异', statements }] : [],
        relatedConcepts: system.includes('为"同步任务"') ? ['[[文档平台同步]]'] : [] }) }
    }
    if (system.startsWith('你是一个 Wiki 索引生成器')) return { text: JSON.stringify({ sections: [{ heading: '索引', content: '同步任务与文档平台同步' }] }) }
    if (system.startsWith('你是一个 Wiki 质量分析师')) {
      if (lintOutput === 'RATE_LIMIT') {
        const err = new Error('Failed after 3 attempts. Last error: 您的账户已达到速率限制，请您控制请求频率')
        ;(err as any).name = 'AI_RetryError'
        throw err
      }
      return { text: lintOutput ?? 'NO_ISSUES' }
    }
    return { text: JSON.stringify({ relations: [] }) }
  },
}))

const run = process.env.KNOWLEDGE_DATABASE_URL ? describe : describe.skip
run('Wiki 来源维护 HTTP/PG e2e', () => {
  const schema = `wiki_maintenance_${process.pid}_${Date.now()}`
  const kb = 'wiki-maintenance'
  let server: ReturnType<typeof Bun.serve>
  let pool: any
  let originalA: string
  let originalB: string
  let collectionId: string
  let conceptId: string
  let baseline: any
  let originalHashes: Array<{ id: string; content: string }>

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}api${path}`, { method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    const json: any = await response.json()
    return { status: response.status, json }
  }
  const compile = async (documentId?: string) => {
    const response = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: kb, documentId })
    expect(response.status).toBe(200)
    return response.json.data.taskId as string
  }
  const wait = async (id: string) => {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const response = await call('GET', `/llm-wiki/compile/${id}`)
      expect(response.status).toBe(200)
      if (!['pending', 'running'].includes(response.json.data.status)) return response.json.data
      await Bun.sleep(10)
    }
    throw new Error('Wiki 编译测试超时')
  }
  const retryTask = async (id: string) => {
    const response = await call('POST', `/llm-wiki/compile/${id}/retry`)
    expect(response.status).toBe(200)
    return response.json.data.taskId as string
  }
  const row = async () => (await pool.query(`SELECT * FROM ${schema}.wiki_concepts WHERE id=$1`, [conceptId])).rows[0]
  const sourceRows = async () => (await pool.query(`SELECT document_id,content_hash FROM ${schema}.wiki_concept_sources WHERE concept_id=$1 ORDER BY document_id`, [conceptId])).rows
  const updateA = async (content: string) => {
    const response = await call('PUT', `/knowledge-base/${kb}/documents/a`, { content, type: 'markdown' })
    expect(response.status).toBe(200)
  }
  const toggleA = async () => {
    const current = await call('GET', `/knowledge-base/${kb}/documents/a`)
    expect(current.status).toBe(200)
    await updateA(current.json.data.content.includes(removedFact) ? originalA.replace(removedFact, '') : originalA)
  }

  beforeAll(async () => {
    process.env.KNOWLEDGE_DATABASE_SCHEMA = schema
    // 各域启动初始化会并发执行；先创建本用例专用 schema，避免命名空间创建竞态。
    const { Client } = await import('pg')
    const bootstrap = new Client({ connectionString: process.env.KNOWLEDGE_DATABASE_URL })
    await bootstrap.connect()
    try { await bootstrap.query(`CREATE SCHEMA "${schema}"`) }
    finally { await bootstrap.end() }
    const { createKnowledgeApp } = await import('../src/app.js')
    const app = await createKnowledgeApp()
    pool = (await import('../src/db/index.js')).pool
    server = Bun.serve({ port: 0, hostname: '0.0.0.0', fetch: app.fetch })
    const original = await pool.query(`SELECT id,content,type,metadata FROM knowledge.documents WHERE knowledge_base_id=$1 AND id=ANY($2::text[]) ORDER BY id`,
      ['kb_yingdao_harness_zh_cn', ['996621057543712768', '996621067853312000']])
    expect(original.rows).toHaveLength(2)
    originalHashes = original.rows.map((doc: any) => ({ id: doc.id, content: doc.content }))
    const { tiptapToMarkdown } = await import('../src/utils/tiptap-to-markdown.js')
    const texts = original.rows.map((doc: any) => doc.type === 'tiptap' ? tiptapToMarkdown(JSON.parse(doc.content)) : doc.content)
    originalA = texts[0]
    originalB = texts[1]
    expect(originalA).toContain(removedFact)
    expect(originalB).toContain('只对失败文档发起重试，不必重新同步全部内容。')
    expect((await call('POST', '/knowledge-base', { id: kb, name: 'Wiki 原文维护测试' })).status).toBe(200)
    for (const [index, id] of ['a', 'b'].entries()) {
      const content = index === 0 ? originalA : originalB
      expect((await call('POST', `/knowledge-base/${kb}/documents`, { id, content, type: 'markdown',
        metadata: { ...original.rows[index].metadata, originalDocumentId: original.rows[index].id } })).status).toBe(200)
    }
  })

  afterAll(async () => {
    failPage = false
    failExtraction = false
    invalidExtraction = false
    badReference = false
    badQuote = false
    conflictPage = false
    rateLimitPage = false
    rateLimitExtraction = false
    lintOutput = null
    holdPage = undefined
    pageStarted = undefined
    try {
      if (pool && originalHashes) {
        const current = await pool.query('SELECT id,content FROM knowledge.documents WHERE id=ANY($1::text[]) ORDER BY id', [originalHashes.map(doc => doc.id)])
        expect(current.rows).toEqual(originalHashes)
      }
    } finally {
      if (server) {
        const { wikiCompilerService } = await import('../src/llm-wiki/services/index.js')
        wikiCompilerService.stopRecovery()
        await call('DELETE', `/knowledge-base/${kb}`)
        server.stop(true)
      }
      if (pool) {
        // 仅删除本用例创建的唯一 schema，不接收外部传入名称。
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await pool.end()
      }
    }
  })

  test('首次编译：正文、元信息和两篇来源一起发布', async () => {
    const task = await wait(await compile())
    expect(task.status).toBe('completed')
    expect(task.progress.pagesGenerated).toBe(2)
    const collections = await call('GET', '/llm-wiki/collections')
    collectionId = collections.json.data.items[0].id
    const concepts = await call('GET', `/llm-wiki/collections/${collectionId}/navigate/concepts`)
    expect(concepts.status).toBe(200)
    conceptId = concepts.json.data.concepts.find((item: any) => item.conceptName === conceptName).id
    baseline = await row()
    expect(JSON.stringify(baseline.content)).toContain(removedFact)
    expect(JSON.stringify(baseline.content)).toContain('只对失败文档发起重试')
    expect(baseline.occurrence_count).toBe(2)
    expect((await sourceRows()).map((source: any) => source.document_id)).toEqual(['a', 'b'])
  })

  test('仅更新 A：B 的事实保留，A 的撤销事实与旧摘要消失', async () => {
    await updateA(originalA.replace(removedFact, ''))
    const staleSearch = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: conceptName, includeRelated: false })
    expect(staleSearch.json.data.results.some((result: any) => result.concept.id === conceptId)).toBe(false)
    const task = await wait(await compile('a'))
    expect(task.status).toBe('completed')
    const current = await row()
    expect(JSON.stringify(current.content)).not.toContain(removedFact)
    expect(JSON.stringify(current.content)).toContain('只对失败文档发起重试')
    expect(current.summary).not.toBe(baseline.summary)
    expect(current.definition).not.toBe(baseline.definition)
    expect(current.tags).not.toEqual(baseline.tags)
    expect(current.occurrence_count).toBe(2)
    const pagePrompt = traces.filter(prompt => prompt.startsWith('你是一个 Wiki 作者') && prompt.includes('为"同步任务"')).at(-1)!
    expect(pagePrompt).toContain('现有页面内容')
    expect(pagePrompt).toContain('"documentTitle":"同步与重试"')
    expect(pagePrompt).toContain('"blockIndex"')
    expect(pagePrompt).toContain('"documentTitle":"文档平台同步"')
  })

  test('图扩展附带正文和来源；预算分支遵守参数', async () => {
    const response = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: conceptName, topK: 1, depth: 1, budgetTokens: 8000 })
    expect(response.status).toBe(200)
    const related = response.json.data.citedPages.find((page: any) => page.conceptName === '文档平台同步')
    expect(related.content.sections[0].content).toContain('从文档平台同步内容')
    expect(related.sourceDocumentIds).toEqual(['b'])
    expect(related.sourceDocuments[0].docName).toBe('文档平台同步')
    expect(related.sourceDocuments[0].docUrl).toContain('996621067853312000')
    const noRelated = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: conceptName, topK: 1, includeRelated: false, budgetTokens: 300 })
    expect(noRelated.json.data.citedPages).toHaveLength(1)
    expect(noRelated.json.data.totalEstimatedTokens).toBeLessThanOrEqual(300)
    expect(noRelated.json.data.citedPages[0].truncated).toBe(true)
  })

  test('修订 API 保存旧原文快照，查询范围绑定集合且分页校验严格', async () => {
    const revisions = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions?pageSize=1`)
    expect(revisions.status).toBe(200)
    expect(revisions.json.data.items).toHaveLength(1)
    expect(revisions.json.data.items[0].revision).toBe(2)
    expect(revisions.json.data.items[0].reason).toBe('compiled')
    const first = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/1`)
    expect(first.status).toBe(200)
    expect(first.json.data.sourceSnapshot.find((source: any) => source.document.id === 'a').document.content).toContain(removedFact)
    const second = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/2`)
    expect(second.json.data.sourceSnapshot.find((source: any) => source.document.id === 'a').document.content).not.toContain(removedFact)
    expect(first.json.data.pageSnapshot.citationStatus).toBe('verified')
    const proof = first.json.data.pageSnapshot.content.sections[0].claims[0].evidence[0]
    expect(proof.refId).toStartWith('wiki-ref:')
    expect((await call('GET', `/llm-wiki/collections/other/concepts/${conceptId}/revisions/1`)).status).toBe(404)
    expect((await call('GET', `/llm-wiki/collections/other/concepts/${conceptId}/revisions`)).status).toBe(404)
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions?pageSize=101`)).status).toBe(400)
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/-1`)).status).toBe(400)
  })

  test('已有旧表可幂等迁移，基线不冒充已验证原文版本', async () => {
    const legacy = `${schema}_legacy`
    const client = await pool.connect()
    try {
      await client.query(`CREATE SCHEMA ${legacy}`)
      await client.query(`CREATE TABLE ${legacy}.wiki_collections(id varchar(255) PRIMARY KEY)`)
      await client.query(`CREATE TABLE ${legacy}.wiki_concepts(id varchar(255) PRIMARY KEY,collection_id varchar(255),content jsonb,status text)`)
      await client.query(`CREATE TABLE ${legacy}.wiki_concept_sources(concept_id varchar(255),document_id varchar(255),content_hash varchar(64))`)
      await client.query(`CREATE TABLE ${legacy}.wiki_relationships(id varchar(255) PRIMARY KEY)`)
      await client.query(`CREATE TABLE ${legacy}.wiki_compile_tasks(id varchar(255) PRIMARY KEY,status text,collection_id varchar(255),progress jsonb,created_at timestamp)`)
      await client.query(`INSERT INTO ${legacy}.wiki_collections VALUES('old-col')`)
      await client.query(`INSERT INTO ${legacy}.wiki_concepts VALUES('old-page','old-col',$1,'compiled')`, [{ sections: [{ heading: '旧页', content: originalA }] }])
      await client.query(`INSERT INTO ${legacy}.wiki_concept_sources VALUES('old-page','a',$1)`, [createHash('sha256').update(originalA).digest('hex')])
      const { migrateWikiProvenance } = await import('../src/llm-wiki/db/provenance-migration.js')
      await migrateWikiProvenance(client, legacy)
      await migrateWikiProvenance(client, legacy)
      const old = (await client.query(`SELECT revision,citation_status FROM ${legacy}.wiki_concepts`)).rows[0]
      expect(old).toEqual({ revision: 0, citation_status: 'legacy' })
      const history = (await client.query(`SELECT * FROM ${legacy}.wiki_page_revisions`)).rows
      expect(history).toHaveLength(1)
      expect(history[0].reason).toBe('legacy-baseline')
      expect(history[0].page_snapshot.content.sections[0].content).toBe(originalA)
      expect(history[0].source_snapshot[0].historicalContentUnavailable).toBe(true)
      expect(history[0].source_snapshot[0].document).toBeUndefined()
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${legacy} CASCADE`)
      client.release()
    }
  })

  test('未校验的旧页不进入默认检索；旧版本关系不会被用于图扩展', async () => {
    await pool.query(`INSERT INTO ${schema}.wiki_concepts(id,collection_id,concept_name,slug,content,status)
      VALUES('legacy-page',$1,'旧页专用关键词','legacy',$2,'compiled')`, [collectionId, { sections: [{ heading: '旧页', content: originalA }] }])
    try {
      const response = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '旧页专用关键词' })
      expect(response.status).toBe(200)
      expect(response.json.data.results.some((result: any) => result.concept.id === 'legacy-page')).toBe(false)
      const navigation = await call('GET', `/llm-wiki/collections/${collectionId}/navigate/concepts?pageSize=100`)
      expect(navigation.json.data.concepts.some((concept: any) => concept.id === 'legacy-page')).toBe(false)
      await pool.query(`UPDATE ${schema}.wiki_relationships SET source_revision=0 WHERE source_concept_id=$1`, [conceptId])
      const stale = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: conceptName, topK: 1, depth: 1, budgetTokens: 8000 })
      expect(stale.json.data.citedPages.map((page: any) => page.conceptId)).toEqual([conceptId])
    } finally {
      await pool.query(`UPDATE ${schema}.wiki_relationships SET source_revision=(SELECT revision FROM ${schema}.wiki_concepts WHERE id=$1) WHERE source_concept_id=$1`, [conceptId])
      await pool.query(`DELETE FROM ${schema}.wiki_concepts WHERE id='legacy-page'`)
    }
  })

  test('伪造引用或不存在的引文：拒绝发布，修订和来源均不推进', async () => {
    const before = await row()
    const sources = await sourceRows()
    const count = (await pool.query(`SELECT count(*)::int n FROM ${schema}.wiki_page_revisions WHERE concept_id=$1`, [conceptId])).rows[0].n
    await updateA(originalA)
    for (const kind of ['ref', 'quote']) {
      badReference = kind === 'ref'
      badQuote = kind === 'quote'
      try {
        const task = await wait(await compile('a'))
        expect(task.status).toBe('failed')
        expect(task.progress.warnings.join(';')).toContain(kind === 'ref' ? 'Invalid block index' : 'Anchor not found')
        expect((await row()).revision).toBe(before.revision)
        expect((await row()).content).toEqual(before.content)
        expect(await sourceRows()).toEqual(sources)
        expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.wiki_page_revisions WHERE concept_id=$1`, [conceptId])).rows[0].n).toBe(count)
      } finally { badReference = false; badQuote = false }
    }
    expect((await wait(await compile('a'))).status).toBe('completed')
  })

  test('来源冲突保留双方原文证据；待确认页不用于默认回答', async () => {
    await updateA(originalA)
    expect((await call('PUT', `/knowledge-base/${kb}/documents/b`, { type: 'markdown',
      content: originalB + '\n\n任务尚未结束时可以重复发起相同的全量同步。' })).status).toBe(200)
    conflictPage = true
    try {
      expect((await wait(await compile())).status).toBe('completed')
      const current = await row()
      expect(current.status).toBe('needs_review')
      expect(current.citation_status).toBe('verified')
      expect(current.content.conflicts[0].statements).toHaveLength(2)
      expect(JSON.stringify(current.content)).toContain('冲突待确认')
      const search = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: conceptName, includeRelated: false })
      expect(search.json.data.results.some((result: any) => result.concept.id === conceptId)).toBe(false)
      const detail = await call('GET', `/llm-wiki/collections/${collectionId}/concepts?conceptId=${conceptId}`)
      expect(detail.json.data.concept.content.conflicts).toHaveLength(1)
      const history = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/${current.revision}`)
      expect(history.json.data.pageSnapshot.status).toBe('needs_review')
      expect(history.json.data.sourceSnapshot.find((source: any) => source.document.id === 'b').document.content).toContain('可以重复发起')
    } finally {
      conflictPage = false
      expect((await call('PUT', `/knowledge-base/${kb}/documents/b`, { content: originalB, type: 'markdown' })).status).toBe(200)
    }
    expect((await wait(await compile())).status).toBe('completed')
    expect((await row()).status).toBe('compiled')
  })

  test('页面失败：保留旧正文和哈希、标记过时，重试不能跳过', async () => {
    const before = await row()
    const beforeSources = await sourceRows()
    await toggleA()
    failPage = true
    const failed = await wait(await compile('a'))
    failPage = false
    expect(failed.status).toBe('failed')
    expect(failed.progress.pagesGenerated).toBe(0)
    expect(failed.progress.pagesFailed).toBe(1)
    const preserved = await row()
    expect(preserved.content).toEqual(before.content)
    expect(preserved.status).toBe('outdated')
    expect(await sourceRows()).toEqual(beforeSources)
    const search = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: conceptName, includeRelated: false })
    expect(search.json.data.results.some((result: any) => result.concept.id === conceptId)).toBe(false)
    expect((await wait(await compile('a'))).status).toBe('completed')
    expect((await row()).status).toBe('compiled')
  })

  test('即使 PG 中存在跨集合关系，也不能把外库正文与来源带入检索', async () => {
    const otherKb = 'wiki-foreign'
    expect((await call('POST', '/knowledge-base', { id: otherKb, name: '隔离对照库' })).status).toBe(200)
    try {
      expect((await call('POST', `/knowledge-base/${otherKb}/documents`, { id: 'foreign-doc', content: originalB, type: 'markdown' })).status).toBe(200)
      const created = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: otherKb })
      expect((await wait(created.json.data.taskId)).status).toBe('completed')
      const foreign = await pool.query(`SELECT c.id FROM ${schema}.wiki_concepts c
        JOIN ${schema}.wiki_collections col ON col.id=c.collection_id
        WHERE col.knowledge_base_id=$1 AND c.slug != '_index'`, [otherKb])
      const foreignIds = foreign.rows.map((page: any) => page.id)
      const revision = (await pool.query(`SELECT revision FROM ${schema}.wiki_concepts WHERE id=$1`, [conceptId])).rows[0].revision
      await pool.query(`INSERT INTO ${schema}.wiki_relationships(id,collection_id,source_concept_id,target_concept_id,relationship_type,origin,source_revision)
        VALUES('cross-collection-edge',$1,$2,$3,'related','model-inferred',$4::integer)`, [collectionId, conceptId, foreignIds[0], revision])
      const response = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: conceptName, topK: 1, depth: 3, budgetTokens: 8000 })
      expect(response.status).toBe(200)
      expect(response.json.data.citedPages.some((page: any) => foreignIds.includes(page.conceptId))).toBe(false)
      expect(response.json.data.citedPages.flatMap((page: any) => page.sourceDocumentIds)).not.toContain('foreign-doc')
    } finally { expect((await call('DELETE', `/knowledge-base/${otherKb}`)).status).toBe(200) }
  })

  test('模型调用期间来源变化：拒绝发布过期草稿', async () => {
    await toggleA()
    let release!: () => void
    holdPage = new Promise(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { pageStarted = resolve })
    const id = await compile('a')
    try {
      await Promise.race([started, Bun.sleep(5000).then(() => { throw new Error('页面生成未开始') })])
      await toggleA()
    } finally {
      release()
      holdPage = undefined
      pageStarted = undefined
    }
    const task = await wait(id)
    expect(task.status).toBe('failed')
    expect(task.error).toContain('sources changed')
    expect((await wait(await compile('a'))).status).toBe('completed')
  })

  test('发布事务失败：正文与来源都回滚，不能留下半成品', async () => {
    const before = await row()
    const beforeSources = await sourceRows()
    const historyCount = (await pool.query(`SELECT count(*)::int n FROM ${schema}.wiki_page_revisions WHERE concept_id=$1`, [conceptId])).rows[0].n
    await toggleA()
    await pool.query(`CREATE FUNCTION ${schema}.reject_source() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION '受控来源写入失败'; END $$`)
    await pool.query(`CREATE TRIGGER reject_source BEFORE INSERT ON ${schema}.wiki_concept_sources
      FOR EACH ROW EXECUTE FUNCTION ${schema}.reject_source()`)
    try {
      const task = await wait(await compile('a'))
      expect(task.status).toBe('failed')
      expect(task.progress.pagesGenerated).toBe(1)
      expect(task.progress.pagesPublished).toBe(0)
      expect(task.error).toContain('Failed query')
      expect((await row()).content).toEqual(before.content)
      expect(await sourceRows()).toEqual(beforeSources)
      expect((await row()).revision).toBe(before.revision)
      expect((await pool.query(`SELECT count(*)::int n FROM ${schema}.wiki_page_revisions WHERE concept_id=$1`, [conceptId])).rows[0].n).toBe(historyCount)
    } finally {
      await pool.query(`DROP TRIGGER reject_source ON ${schema}.wiki_concept_sources`)
      await pool.query(`DROP FUNCTION ${schema}.reject_source()`)
    }
    expect((await wait(await compile('a'))).status).toBe('completed')
  })

  test('提取格式错误不是零概念：旧来源仍保留', async () => {
    const beforeSources = await sourceRows()
    const before = await row()
    await toggleA()
    invalidExtraction = true
    try {
      const task = await wait(await compile('a'))
      expect(task.status).toBe('failed')
      expect((await row()).content).toEqual(before.content)
      expect(await sourceRows()).toEqual(beforeSources)
    } finally { invalidExtraction = false }
    expect((await wait(await compile('a'))).status).toBe('completed')
  })

  test('删除 B 后全量编译：清理孤儿来源并撤销失效概念关系', async () => {
    expect((await call('DELETE', `/knowledge-base/${kb}/documents/b`)).status).toBe(200)
    expect((await wait(await compile())).status).toBe('completed')
    expect((await sourceRows()).map((source: any) => source.document_id)).toEqual(['a'])
    expect(JSON.stringify((await row()).content)).not.toContain('只对失败文档发起重试')
    const stale = await pool.query(`SELECT id,status,occurrence_count FROM ${schema}.wiki_concepts WHERE concept_name='文档平台同步'`)
    expect(stale.rows[0].status).toBe('no_concepts')
    expect(stale.rows[0].occurrence_count).toBe(0)
    const relationships = await pool.query(`SELECT * FROM ${schema}.wiki_relationships WHERE source_concept_id=$1 OR target_concept_id=$1`, [stale.rows[0].id])
    expect(relationships.rows).toHaveLength(0)
    const first = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/1`)
    expect(first.json.data.sourceSnapshot.find((source: any) => source.document.id === 'b').document.content).toBe(originalB)
    expect(first.json.data.relationshipSnapshot[0].sourceRevision).toBe(1)
    expect(first.json.data.relationshipSnapshot[0].origin).not.toBe('legacy')
  })

  test('有效空提取撤销最后来源，不把旧正文当有效知识', async () => {
    await updateA('')
    expect((await wait(await compile('a'))).status).toBe('completed')
    expect((await row()).status).toBe('no_concepts')
    expect(await sourceRows()).toHaveLength(0)
  })

  test('全部提取失败不能报告 completed', async () => {
    await updateA(originalA)
    failExtraction = true
    try {
      const task = await wait(await compile('a'))
      expect(task.status).toBe('failed')
      expect(task.progress.failed).toBe(1)
    } finally { failExtraction = false }
  })

  test('过期运行任务由恢复器接管，并复用来源哈希匹配的提取检查点', async () => {
    await updateA(originalA)
    const taskId = `recovery-${Date.now()}`
    const sourceHash = createHash('sha256').update(originalA).digest('hex')
    await pool.query(`INSERT INTO ${schema}.wiki_compile_tasks
      (id,collection_id,knowledge_base_id,document_id,status,progress,worker_id,lease_expires_at,attempt)
      VALUES($1,$2,$3,'a','running','{"total":1,"processed":0,"skipped":0,"failed":0,"extracted":0}',
        'dead-worker',NOW()-INTERVAL '1 minute',1)`, [taskId, collectionId, kb])
    await pool.query(`INSERT INTO ${schema}.wiki_compile_checkpoints(task_id,checkpoint_key,source_hash,payload)
      VALUES($1,'extract:a',$2,$3::jsonb)`,
    [taskId, sourceHash, JSON.stringify([{ concept: conceptName, summary: 'checkpoint recovered', is_new: false }])])

    traces.length = 0
    const { wikiCompilerService } = await import('../src/llm-wiki/services/index.js')
    await wikiCompilerService.recoverAvailableTasks()
    expect((await wait(taskId)).status).toBe('completed')
    expect(traces.some(prompt => prompt.startsWith('你是一个知识提取引擎'))).toBe(false)
    const task = await pool.query(`SELECT worker_id,attempt,heartbeat_at,lease_expires_at FROM ${schema}.wiki_compile_tasks WHERE id=$1`, [taskId])
    expect(task.rows[0].worker_id).not.toBe('dead-worker')
    expect(task.rows[0].attempt).toBe(2)
    expect(task.rows[0].heartbeat_at).toBeNull()
    expect(task.rows[0].lease_expires_at).toBeNull()
    // completed 状态先于 checkpoint 清理落库：轮询等待清空，避免竞态误报。
    let checkpoints: any
    for (let i = 0; i < 20; i++) {
      checkpoints = await pool.query(`SELECT * FROM ${schema}.wiki_compile_checkpoints WHERE task_id=$1`, [taskId])
      if (checkpoints.rows.length === 0) break
      await Bun.sleep(100)
    }
    expect(checkpoints.rows).toHaveLength(0)
  })

  test('超过重试上限的过期任务直接判 failed，不再被领取执行', async () => {
    const taskId = `attempts-${Date.now()}`
    await pool.query(`INSERT INTO ${schema}.wiki_compile_tasks
      (id,collection_id,knowledge_base_id,document_id,status,progress,worker_id,lease_expires_at,attempt)
      VALUES($1,$2,$3,'a','running','{}','dead-worker',NOW()-INTERVAL '1 minute',5)`, [taskId, collectionId, kb])
    traces.length = 0
    const { wikiCompilerService } = await import('../src/llm-wiki/services/index.js')
    await wikiCompilerService.recoverAvailableTasks()
    await Bun.sleep(100)
    const task = await pool.query(`SELECT status,error,lease_expires_at FROM ${schema}.wiki_compile_tasks WHERE id=$1`, [taskId])
    expect(task.rows[0].status).toBe('failed')
    expect(task.rows[0].error).toContain('attempts')
    expect(task.rows[0].lease_expires_at).toBeNull()
    expect(traces.length).toBe(0)
  })

  test('提取失败的任务：状态列出失败文档与原因，原地重试只重做失败文档', async () => {
    await updateA(originalA + '\n\n补充一句用于触发 A 的重新提取。')
    const taskId = await compile()
    invalidExtraction = true
    try {
      const failed = await wait(taskId)
      expect(failed.status).toBe('failed')
      expect(failed.progress.warnings.join(';')).toContain('extract a: no_json')
    } finally { invalidExtraction = false }

    const before = traces.length
    const retry = await call('POST', `/llm-wiki/compile/${taskId}/retry`)
    expect(retry.status).toBe(200)
    expect(retry.json.data.taskId).toBe(taskId)
    expect((await wait(taskId)).status).toBe('completed')
    const extractions = traces.slice(before).filter(prompt => prompt.startsWith('你是一个知识提取引擎'))
    expect(extractions).toHaveLength(1)
    expect((await call('GET', `/llm-wiki/compile/${taskId}`)).json.data.attempt).toBe(1)
    expect((await call('POST', `/llm-wiki/compile/${taskId}/retry`)).status).toBe(400)
  })

  test('WM20 页面生成遇限流：立即中断批次，不计为页面失败，error 指明限流', async () => {
    await updateA(originalA + '\n\n限流批次验证用的文档变化。')
    const taskId = await compile()
    rateLimitPage = true
    try {
      const task = await wait(taskId)
      expect(task.status).toBe('failed')
      expect(task.error).toContain('rate limit')
      expect(task.progress.pagesFailed ?? 0).toBe(0)
      expect(task.progress.warnings?.join(';') ?? '').not.toContain('rate limit')
    } finally { rateLimitPage = false }
    expect((await wait(await retryTask(taskId))).status).toBe('completed')
  })

  test('WM21 提取遇限流：任务立即失败，限流文档不计为提取失败数', async () => {
    await toggleA()
    rateLimitExtraction = true
    try {
      const task = await wait(await compile())
      expect(task.status).toBe('failed')
      expect(task.error).toContain('rate limit')
      expect(task.progress.failed).toBe(0)
      expect(task.progress.warnings?.join(';') ?? '').not.toContain('rate limit')
    } finally { rateLimitExtraction = false }
    expect((await wait(await compile())).status).toBe('completed')
  })

  test('WM22 增量编译：零变更不生成页面，改一篇只重编受影响概念', async () => {
    // 此前用例已删除文档 b，fixture 终态仅存 a 与概念"同步任务"。
    const before = await row()

    // 零变更全量编译：提取全部 skip（来源哈希一致且 verified），无页面生成调用，概念 revision 不变。
    traces.length = 0
    const noop = await wait(await compile())
    expect(noop.status).toBe('completed')
    expect(traces.filter(prompt => prompt.startsWith('你是一个 Wiki 作者'))).toHaveLength(0)
    expect((await row()).revision).toBe(before.revision)

    // 改 a：来源含 a 的概念受影响并重新生成；提取与页面调用各恰好一次。
    await updateA(originalA + '\n\n增量验证追加的一句。')
    traces.length = 0
    const incremental = await wait(await compile())
    expect(incremental.status).toBe('completed')
    expect(incremental.progress.pagesGenerated).toBe(1)
    expect(traces.filter(prompt => prompt.startsWith('你是一个知识提取引擎'))).toHaveLength(1)
    expect(traces.filter(prompt => prompt.startsWith('你是一个 Wiki 作者'))).toHaveLength(1)
    expect((await row()).revision).toBe(before.revision + 1)
    expect(JSON.stringify((await row()).content)).toContain('增量验证追加的一句')
  })

  test('WM23 操作日志：编译事件可查，UPDATE/DELETE 被触发器拒绝', async () => {
    const log = await call('GET', `/llm-wiki/collections/${collectionId}/log`)
    expect(log.status).toBe(200)
    expect(log.json.data.total).toBeGreaterThan(0)
    const compileEntries = log.json.data.items.filter((entry: any) => entry.type === 'compile')
    expect(compileEntries.length).toBeGreaterThan(0)
    expect(compileEntries[0].detail).toMatchObject({ partial: false })
    const forbidden = await pool.query(`UPDATE ${schema}.wiki_activity_log SET type='tampered'`).catch((error: any) => String(error.message))
    expect(forbidden).toContain('append-only')
    const forbiddenDelete = await pool.query(`DELETE FROM ${schema}.wiki_activity_log`).catch((error: any) => String(error.message))
    expect(forbiddenDelete).toContain('append-only')
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/log?pageSize=0`)).status).toBe(400)
  })

  test('WM24 答案回写：证据校验入库 needs_review，默认检索不返回，重编不撤销', async () => {
    const quote = '增量验证追加的一句'
    const bad = await call('POST', `/llm-wiki/collections/${collectionId}/answers`, { question: '增量验证是什么？',
      answerMarkdown: '增量验证的说明。', claims: [{ statement: '增量验证', evidence: [{ documentId: 'a', quote: '原文中不存在的引文' }] }] })
    expect(bad.status).toBe(400)
    expect(bad.json.message).toContain('Quote not found')

    const filed = await call('POST', `/llm-wiki/collections/${collectionId}/answers`, { question: '增量验证是什么？',
      answerMarkdown: `增量验证的说明：${quote}。`, claims: [{ statement: quote, evidence: [{ documentId: 'a', quote }] }] })
    expect(filed.status).toBe(200)
    const slug = filed.json.data.slug
    expect(slug.startsWith('answer-')).toBe(true)

    const stored = (await pool.query(`SELECT status,citation_status,revision FROM ${schema}.wiki_concepts WHERE slug=$1`, [slug])).rows[0]
    expect(stored).toMatchObject({ status: 'needs_review', citation_status: 'verified', revision: 1 })
    const search = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '增量验证', includeRelated: false })
    expect(search.json.data.results.some((result: any) => result.concept.slug === slug)).toBe(false)
    const revisions = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${filed.json.data.conceptId}/revisions`)
    expect(revisions.json.data.items[0].reason).toBe('answer-filed')
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/log`)).json.data.items[0].type).toBe('answer_filed')

    // 重编（零变更）不撤销答案页。
    expect((await wait(await compile())).status).toBe('completed')
    const after = (await pool.query(`SELECT status,revision FROM ${schema}.wiki_concepts WHERE slug=$1`, [slug])).rows[0]
    expect(after).toMatchObject({ status: 'needs_review', revision: 1 })
  })

  test('WM25 Markdown 导出：含 verified 正文与回写答案标记，legacy 不导出', async () => {
    const body = await (await fetch(`${server.url}api/llm-wiki/collections/${collectionId}/export`)).text()
    expect(body).toContain('# Wiki Export')
    expect(body).toContain('## 同步任务')
    expect(body).toContain('增量验证追加的一句')
    expect(body).toContain('【回写答案】')
    expect((await fetch(`${server.url}api/llm-wiki/collections/col_no_such/export`)).status).toBe(404)
  })

  test('WM26 用户可编辑 schema：配置生效、非法值拒绝、证据字段不可覆盖、编译记录版本', async () => {
    // 默认：未配置时返回默认值，version=0。
    const initial = await call('GET', `/llm-wiki/collections/${collectionId}/schema`)
    expect(initial.status).toBe(200)
    expect(initial.json.data).toMatchObject({ version: 0, config: { maxConceptsPerDoc: 20, outputLanguage: 'zh', tagWhitelist: [] } })

    // 非法值与未知字段（含试图覆盖证据规则）均 400。
    for (const bad of [
      { maxConceptsPerDoc: 999, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [] },
      { maxConceptsPerDoc: 20, sourceCharLimit: 10, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [] },
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'fr', pageStyle: 'neutral', tagWhitelist: [] },
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [], evidenceRequired: false },
    ]) {
      expect((await call('PUT', `/llm-wiki/collections/${collectionId}/schema`, bad)).status).toBe(400)
    }

    // 保存生效：上限 1 + 白名单。
    const saved = await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 1, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'formal', tagWhitelist: ['白名单标签'] })
    expect(saved.status).toBe(200)
    expect(saved.json.data.version).toBe(1)

    // 触发重编（改文档），断言提示词注入与截断生效、tags 被白名单过滤。
    await updateA(originalA + '\n\nschema 验证追加的一句。')
    traces.length = 0
    const task = await wait(await compile())
    expect(task.status).toBe('completed')
    expect(task.progress.schemaVersion).toBe(1)
    const extractPrompt = traces.find(prompt => prompt.startsWith('你是一个知识提取引擎'))!
    expect(extractPrompt).toContain('概念数量上限为 1 个')
    expect(extractPrompt).toContain('白名单中选择：白名单标签')
    const pagePrompt = traces.find(prompt => prompt.startsWith('你是一个 Wiki 作者'))!
    expect(pagePrompt).toContain('正式书面语')
    expect((await row()).tags.every((tag: string) => tag === '白名单标签' || tag.startsWith('alias:'))).toBe(true)
    // completed 状态先于活动日志落库：轮询等待 compile 条目（含 schemaVersion）出现。
    let latest: any
    for (let i = 0; i < 20; i++) {
      latest = (await call('GET', `/llm-wiki/collections/${collectionId}/log`)).json.data.items[0]
      if (latest?.type === 'compile') break
      await Bun.sleep(100)
    }
    expect(latest).toMatchObject({ type: 'compile' })
    expect(latest.detail).toMatchObject({ schemaVersion: 1 })

    // 恢复默认（version 2），后续用例不受影响。
    const restored = await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [] })
    expect(restored.json.data.version).toBe(2)
    await updateA(originalA + '\n\n增量验证追加的一句。')
    expect((await wait(await compile())).progress.schemaVersion).toBe(2)
  })

  test('WM27 schema 页面结构选项：关闭 definition/summary 不生成不兜底', async () => {
    const saved = await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [],
        pageStructure: { definition: false, summary: false } })
    expect(saved.status).toBe(200)
    await updateA(originalA + '\n\n结构选项验证的一句。')
    traces.length = 0
    const task = await wait(await compile())
    expect(task.status).toBe('completed')
    const pagePrompt = traces.find(prompt => prompt.startsWith('你是一个 Wiki 作者'))!
    expect(pagePrompt).toContain('不要输出 definition 与 definitionEvidence')
    expect(pagePrompt).toContain('不要输出 summary 与 summaryEvidence')
    const current = await row()
    expect(current.definition).toBeNull()
    expect(current.summary).toBeNull()
    // 恢复结构选项与文档，避免影响后续。
    await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [] })
    await updateA(originalA + '\n\n增量验证追加的一句。')
    expect((await wait(await compile())).status).toBe('completed')
    expect((await row()).definition).toBeTruthy()
  })

  test('WM28 schema 自动语义 lint：结果进 lintResults 与 warnings，失败不阻断', async () => {
    // 正常输出：语义问题出现在编译任务的 lintResults，并计入 warnings。
    lintOutput = '---LINT: contradiction | warning | 同步任务 ---\n正文断言与来源方向相反。\n---END LINT---'
    const putResp = await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [], autoSemanticLint: true })
    expect(putResp.status).toBe(200)
    await updateA(originalA + '\n\n自动语义 lint 验证的一句。')
    try {
      const task = await wait(await compile())
      expect(task.status).toBe('completed')
      expect(task.progress.lintResults.some((result: any) => result.type === 'contradiction' && result.detail.includes('方向相反'))).toBe(true)
      expect(task.progress.warnings.join(';')).toContain('semantic lint: 1 issue')
    } finally { lintOutput = null }

    // 语义审查失败（限流）：记 warning，编译仍 completed。
    lintOutput = 'RATE_LIMIT'
    await updateA(originalA + '\n\n自动语义 lint 失败路径的一句。')
    try {
      const task = await wait(await compile())
      expect(task.status).toBe('completed')
      expect(task.progress.warnings.join(';')).toContain('Lint failed')
    } finally { lintOutput = null }

    // 恢复默认配置与文档。
    await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [] })
    await updateA(originalA + '\n\n增量验证追加的一句。')
    expect((await wait(await compile())).status).toBe('completed')
  })

  test('WM29 页面级语义 lint：单页超限降级 skipped，自动巡检零变更不调用，手动全量限 50 页', async () => {
    // 零变更 + autoSemanticLint：无发布页 → 不发起语义调用（traces 无审查提示词），lintResults 仅结构。
    await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [], autoSemanticLint: true })
    lintOutput = 'NO_ISSUES'
    traces.length = 0
    try {
      const noop = await wait(await compile())
      expect(noop.status).toBe('completed')
      expect(traces.some(prompt => prompt.startsWith('你是一个 Wiki 质量分析师'))).toBe(false)
      expect((noop.progress.lintResults || []).every((result: any) => ['orphan', 'broken_link', 'no_outlinks'].includes(result.type))).toBe(true)
    } finally { lintOutput = null }

    // 单页材料超限：降级为 skipped（info），其余页正常审查。
    const huge = await pool.query(`INSERT INTO ${schema}.wiki_concepts(id,collection_id,concept_name,slug,summary,content,status,citation_status,occurrence_count,tags)
      VALUES('wm29-huge',$1,'超大页面','wm29-huge','摘要',$2,'compiled','verified',1,'[]'::jsonb) RETURNING id`,
      [collectionId, { sections: [{ heading: '大', content: '巨'.repeat(31000) }] }])
    try {
      lintOutput = 'NO_ISSUES'
      const lint = await call('POST', `/llm-wiki/collections/${collectionId}/lint`, { includeSemantic: true })
      expect(lint.status).toBe(200)
      const skipped = lint.json.data.results.find((result: any) => result.type === 'skipped' && result.page === '超大页面')
      expect(skipped.detail).toContain('超过审查上限')
      expect(lint.json.data.results.some((result: any) => result.type === 'no_outlinks')).toBe(true)
    } finally { lintOutput = null }

    // 手动全量 >50 页：400 引导走自动增量巡检。
    const bulk: string[][] = []
    for (let i = 0; i < 51; i++) bulk.push([`wm29-bulk-${i}`, `批量页${i}`])
    const values: any[] = []
    const placeholders = bulk.map(([id, name], index) => {
      values.push(id, collectionId, name, id)
      return `($${index * 4 + 1},$${index * 4 + 2},$${index * 4 + 3},$${index * 4 + 4},'compiled','verified',1,'[]'::jsonb)`
    }).join(',')
    await pool.query(`INSERT INTO ${schema}.wiki_concepts(id,collection_id,concept_name,slug,status,citation_status,occurrence_count,tags) VALUES ${placeholders}`, values)
    try {
      const limited = await call('POST', `/llm-wiki/collections/${collectionId}/lint`, { includeSemantic: true })
      expect(limited.status).toBe(400)
      expect(limited.json.message).toContain('limited to 50 pages')
    } finally {
      await pool.query(`DELETE FROM ${schema}.wiki_concepts WHERE id = ANY($1::text[])`,
        [[huge.rows[0].id, ...bulk.map(([id]) => id)]])
    }

    // 恢复默认配置。
    await call('PUT', `/llm-wiki/collections/${collectionId}/schema`,
      { maxConceptsPerDoc: 20, sourceCharLimit: 30000, outputLanguage: 'zh', pageStyle: 'neutral', tagWhitelist: [] })
  })

  test('WM30 答案升级、概念归档、文档反查、修订 diff', async () => {
    // 答案回写 → approve 升级 compiled → 默认检索可见；repeat review 拒绝。
    const quote = '增量验证追加的一句'
    const filed = await call('POST', `/llm-wiki/collections/${collectionId}/answers`, { question: '升级验证的问题？',
      answerMarkdown: `说明：${quote}。`, claims: [{ statement: quote, evidence: [{ documentId: 'a', quote }] }] })
    expect(filed.status).toBe(200)
    const answerId = filed.json.data.conceptId
    expect((await call('POST', `/llm-wiki/collections/${collectionId}/answers/${answerId}/review`, { action: 'approve`' })).status).toBe(400)
    const approved = await call('POST', `/llm-wiki/collections/${collectionId}/answers/${answerId}/review`, { action: 'approve' })
    expect(approved.status).toBe(200)
    expect(approved.json.data.status).toBe('compiled')
    const searchVisible = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '升级验证的问题', includeRelated: false })
    expect(searchVisible.json.data.results.some((result: any) => result.concept.id === answerId)).toBe(true)
    expect((await call('POST', `/llm-wiki/collections/${collectionId}/answers/${answerId}/review`, { action: 'approve' })).status).toBe(400)
    const revisions = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${answerId}/revisions`)
    expect(revisions.json.data.items[0].reason).toBe('human-approved')

    // 修订 diff：rev2(approved) vs rev1(filed) 的状态变化可见。
    const diff = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${answerId}/revisions/2/diff?against=1`)
    expect(diff.status).toBe(200)
    expect(diff.json.data.status).toEqual({ from: 'needs_review', to: 'compiled' })
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${answerId}/revisions/2/diff?against=99`)).status).toBe(404)

    // 文档反查：文档 a 的当前 verified 概念包含同步任务与刚升级的答案（其证据在 a）。
    const byDoc = await call('GET', `/llm-wiki/collections/${collectionId}/documents/a/concepts`)
    expect(byDoc.status).toBe(200)
    expect(byDoc.json.data.concepts.some((concept: any) => concept.slug === '同步任务')).toBe(true)

    // 概念归档：检索/导航/导出排除；unarchive 恢复；重编不复活归档。
    const archived = await call('POST', `/llm-wiki/collections/${collectionId}/concepts/${answerId}/archive`)
    expect(archived.status).toBe(200)
    const afterArchive = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '升级验证的问题', includeRelated: false })
    expect(afterArchive.json.data.results.some((result: any) => result.concept.id === answerId)).toBe(false)
    await updateA(originalA + '\n\n归档后重编验证的一句。')
    expect((await wait(await compile())).status).toBe('completed')
    const stillArchived = (await pool.query(`SELECT status FROM ${schema}.wiki_concepts WHERE id=$1`, [answerId])).rows[0].status
    expect(stillArchived).toBe('archived')
    const restored = await call('POST', `/llm-wiki/collections/${collectionId}/concepts/${answerId}/unarchive`)
    expect(restored.json.data.status).toBe('compiled')
    const visibleAgain = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '升级验证的问题', includeRelated: false })
    expect(visibleAgain.json.data.results.some((result: any) => result.concept.id === answerId)).toBe(true)
    await updateA(originalA + '\n\n增量验证追加的一句。')
    expect((await wait(await compile())).status).toBe('completed')
  })
})
