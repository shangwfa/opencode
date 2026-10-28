/**
 * Wiki 检索/修订/编译 HTTP 契约矩阵：真实 HTTP + PG，确定性模型。
 * 只验证请求面契约与执行路径，不评估真实 LLM 忠实度。
 * 原文复制自已有 RAG 库到唯一临时 schema；绝不更新原库。
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { createHash } from 'crypto'

const vector = Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0)
let holdPage: Promise<void> | undefined
let lintOutput: string | null = null

mock.module('pdf-parse', () => ({ PDFParse: class {
  constructor() { throw new Error('Wiki 契约回归不应调用 PDF 解析器') }
} }))

mock.module('ai', () => ({
  embed: async () => ({ embedding: vector }),
  embedMany: async ({ values }: any) => ({ embeddings: values.map(() => vector) }),
  generateObject: async () => ({ object: {} }),
  streamText: async () => ({}),
  generateText: async ({ system = '' }: any) => {
    const source = (system.split('--- 文档内容 ---\n\n')[1] || '').split('\n\n【重要提示】')[0]
    if (system.startsWith('你是一个知识提取引擎')) {
      const concepts = source.trim() ? [{ concept: '同步任务', summary: '同步任务的来源说明', is_new: false }] : []
      if (source.includes('# 从文档平台同步内容')) concepts.push({ concept: '文档平台同步', summary: '文档平台同步来源', is_new: false })
      return { text: JSON.stringify({ concepts }) }
    }
    if (system.startsWith('你是一个 Wiki 作者')) {
      if (holdPage) await holdPage
      const materials: string = system.split('--- 源材料 ---\n\n')[1] || ''
      const digest = createHash('sha256').update(materials).digest('hex')
      // 瘦身协议：源材料清单为全局块序号 + 原文；证据用 blockIndex + anchor 指认。
      const flatBlocks: Array<{ blockIndex: number; documentTitle: string; text: string }> =
        materials.split('\n\n---\n\n').map(material => JSON.parse(material))
      const anchorOf = (text: string) => text.slice(0, Math.min(12, text.length))
      const proof = [{ blockIndex: flatBlocks[0].blockIndex, anchor: anchorOf(flatBlocks[0].text) }]
      const claims = flatBlocks.map(block => ({ statement: block.text,
        evidence: [{ blockIndex: block.blockIndex, anchor: anchorOf(block.text) }] }))
      return { text: JSON.stringify({ definition: `本次定义 ${digest}`, summary: `本次摘要 ${digest}`,
        definitionEvidence: proof, summaryEvidence: proof,
        tags: [digest], sections: [{ heading: '源材料汇编', content: flatBlocks.map(block => block.text).join('\n\n'),
          sourceBlockIndexes: flatBlocks.map(block => block.blockIndex), claims }],
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
run('Wiki HTTP 契约矩阵 e2e', () => {
  const schema = `wiki_contract_${process.pid}_${Date.now()}`
  const kb = 'wiki-contract'
  const emptyKb = 'wiki-contract-empty'
  let server: ReturnType<typeof Bun.serve>
  let pool: any
  let collectionId: string
  let conceptId: string
  let relatedId: string
  let originalHashes: Array<{ id: string; content: string }>

  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${server.url}api${path}`, { method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) })
    const json: any = await response.json()
    return { status: response.status, json }
  }
  const compile = async () => {
    const response = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: kb })
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

  beforeAll(async () => {
    process.env.KNOWLEDGE_DATABASE_SCHEMA = schema
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
    expect((await call('POST', '/knowledge-base', { id: kb, name: 'Wiki 契约用例' })).status).toBe(200)
    expect((await call('POST', '/knowledge-base', { id: emptyKb, name: 'Wiki 契约空库' })).status).toBe(200)
    for (const [index, id] of ['a', 'b'].entries()) {
      expect((await call('POST', `/knowledge-base/${kb}/documents`, { id, content: texts[index], type: 'markdown' })).status).toBe(200)
    }
    const task = await wait(await compile())
    expect(task.status).toBe('completed')
    const collections = await call('GET', `/llm-wiki/collections?knowledgeBaseId=${kb}`)
    collectionId = collections.json.data.items[0].id
    const concepts = await call('GET', `/llm-wiki/collections/${collectionId}/navigate/concepts?pageSize=100`)
    conceptId = concepts.json.data.concepts.find((item: any) => item.conceptName === '同步任务').id
    relatedId = concepts.json.data.concepts.find((item: any) => item.conceptName === '文档平台同步').id
    expect(conceptId && relatedId).toBeTruthy()
  })

  afterAll(async () => {
    holdPage = undefined
    lintOutput = null
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
        await call('DELETE', `/knowledge-base/${emptyKb}`)
        server.stop(true)
      }
      if (pool) {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
        await pool.end()
      }
    }
  })

  test('WS01 search 请求契约负例：zod 校验拒绝', async () => {
    expect((await call('POST', '/llm-wiki/search', { query: '同步' })).status).toBe(400)
    expect((await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb })).status).toBe(400)
    for (const body of [
      { knowledgeBaseId: kb, query: '同步', topK: 0 },
      { knowledgeBaseId: kb, query: '同步', topK: -1 },
      { knowledgeBaseId: kb, query: '同步', depth: 0 },
      { knowledgeBaseId: kb, query: '同步', depth: 4 },
      { knowledgeBaseId: kb, query: '同步', budgetTokens: 0 },
      { knowledgeBaseId: kb, query: '同步', budgetTokens: -5 },
    ]) {
      expect((await call('POST', '/llm-wiki/search', body)).status).toBe(400)
    }
  })

  test('WS02 topK 边界与结果结构契约', async () => {
    const one = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '同步任务', topK: 1, includeRelated: false })
    expect(one.status).toBe(200)
    expect(one.json.data.results).toHaveLength(1)
    const item = one.json.data.results[0]
    expect(item.concept.id).toBe(conceptId)
    expect(Array.isArray(item.relatedConcepts)).toBe(true)
    expect(Array.isArray(item.sourceDocumentIds)).toBe(true)
    expect(item.sourceDocumentIds.sort()).toEqual(['a', 'b'])
  })

  test('WS03 空态契约：未编译库 search 与预算检索均为空结构非错误', async () => {
    const search = await call('POST', '/llm-wiki/search', { knowledgeBaseId: emptyKb, query: '同步任务' })
    expect(search.status).toBe(200)
    expect(search.json.data.results).toEqual([])
    const retrieval = await call('POST', '/llm-wiki/search', { knowledgeBaseId: emptyKb, query: '同步任务', budgetTokens: 1000 })
    expect(retrieval.status).toBe(200)
    expect(retrieval.json.data.citedPages).toEqual([])
    expect(retrieval.json.data.budgetAllocation.totalBudget).toBe(1000)
    expect(retrieval.json.data.totalEstimatedTokens).toBeLessThanOrEqual(1000)
  })

  test('WS04 越库隔离：检索与预算检索结果只含本集合概念', async () => {
    await pool.query(`INSERT INTO ${schema}.wiki_collections(id,knowledge_base_id,status,concept_count)
      VALUES('foreign-collection','${emptyKb}','active',1)`)
    const foreign = await pool.query(`INSERT INTO ${schema}.wiki_concepts(id,collection_id,concept_name,slug,content,status,citation_status,occurrence_count,tags)
      VALUES('foreign-page','foreign-collection','外库专属概念','foreign',$1,'compiled','verified',1,'[]'::jsonb) RETURNING id`,
      [{ sections: [{ heading: '外库', content: '外库专属概念正文' }] }])
    try {
      const owned = new Set((await pool.query(`SELECT id FROM ${schema}.wiki_concepts WHERE collection_id=$1`, [collectionId])).rows.map((row: any) => row.id))
      expect(owned.size).toBeGreaterThan(0)
      for (const body of [
        { knowledgeBaseId: kb, query: '概念' },
        { knowledgeBaseId: kb, query: '同步', budgetTokens: 8000 },
      ]) {
        const response = await call('POST', '/llm-wiki/search', body)
        expect(response.status).toBe(200)
        const pages = response.json.data.results?.map((result: any) => result.concept.id)
          ?? response.json.data.citedPages.map((page: any) => page.conceptId)
        for (const id of pages) expect(owned.has(id)).toBe(true)
      }
    } finally {
      await pool.query(`DELETE FROM ${schema}.wiki_concepts WHERE id=$1`, [foreign.rows[0].id])
      await pool.query(`DELETE FROM ${schema}.wiki_collections WHERE id='foreign-collection'`)
    }
  })

  test('WS05 includeRelated=false：不返回图扩展关联概念', async () => {
    const response = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '同步任务', topK: 5, includeRelated: false })
    expect(response.status).toBe(200)
    expect(response.json.data.results.length).toBeGreaterThan(0)
    for (const item of response.json.data.results) expect(item.relatedConcepts).toEqual([])
    const expanded = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '同步任务', topK: 5 })
    expect(expanded.json.data.results[0].relatedConcepts.map((concept: any) => concept.id)).toContain(relatedId)
  })

  test('WS06 预算检索契约：80/15/5 分配且总估算不超预算', async () => {
    const response = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '同步任务', topK: 3, depth: 2, budgetTokens: 8000 })
    expect(response.status).toBe(200)
    const { budgetAllocation, citedPages, indexOverview, context, totalEstimatedTokens } = response.json.data
    expect(budgetAllocation).toEqual({ totalBudget: 8000, pagesBudget: 6400, indexBudget: 1200, systemBudget: 400 })
    expect(citedPages.length).toBeGreaterThan(0)
    expect(citedPages[0].citationIndex).toBe(1)
    expect(citedPages[0].content.sections.length).toBeGreaterThan(0)
    expect(Array.isArray(citedPages[0].sourceDocumentIds)).toBe(true)
    expect(typeof context).toBe('string')
    expect(context.length).toBeGreaterThan(0)
    expect(typeof indexOverview).toBe('string')
    expect(totalEstimatedTokens).toBeLessThanOrEqual(8000)
  })

  test('WS07 编译任务契约：创建返回 pending、状态可查、不存在 404、运行中重复 400', async () => {
    expect((await call('GET', '/llm-wiki/compile/wiki_task_no_such')).status).toBe(404)
    let release!: () => void
    holdPage = new Promise<void>(resolve => { release = resolve })
    try {
      const created = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: kb })
      expect(created.status).toBe(200)
      expect(created.json.data.status).toBe('pending')
      expect(created.json.data.mode).toBe('full')
      const taskId = created.json.data.taskId
      const status = await call('GET', `/llm-wiki/compile/${taskId}`)
      expect(status.status).toBe(200)
      expect(['pending', 'running']).toContain(status.json.data.status)
      const duplicate = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: kb })
      expect(duplicate.status).toBe(400)
      expect(duplicate.json.message).toContain('already has a running compile task')
      release()
      expect((await wait(taskId)).status).toBe('completed')
    } finally {
      release()
      holdPage = undefined
    }
  })

  test('WS08 概念详情契约：conceptId/slug 查询、缺参 400、不存在 404', async () => {
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts`)).status).toBe(400)
    const byId = await call('GET', `/llm-wiki/collections/${collectionId}/concepts?conceptId=${conceptId}`)
    expect(byId.status).toBe(200)
    expect(byId.json.data.concept.id).toBe(conceptId)
    expect(byId.json.data.sourceDocumentIds.sort()).toEqual(['a', 'b'])
    expect(byId.json.data.relatedConcepts.map((concept: any) => concept.id)).toContain(relatedId)
    const bySlug = await call('GET', `/llm-wiki/collections/${collectionId}/concepts?slug=${encodeURIComponent('同步任务')}`)
    expect(bySlug.status).toBe(200)
    expect(bySlug.json.data.concept.id).toBe(conceptId)
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts?conceptId=wiki_concept_no_such`)).status).toBe(404)
  })

  test('WS09 集合契约：详情回读、列表按 KB 过滤（跨库隔离）、不存在 404', async () => {
    const detail = await call('GET', `/llm-wiki/collections/${collectionId}`)
    expect(detail.status).toBe(200)
    expect(detail.json.data.knowledgeBaseId).toBe(kb)
    expect((await call('GET', '/llm-wiki/collections/col_no_such')).status).toBe(404)
    // 越库过滤：建对照库集合后，按本库过滤必须只返回本库（曾因忽略参数泄漏全部集合）。
    const otherKb = 'ws09-other-kb'
    await call('POST', '/knowledge-base', { id: otherKb, name: '对照' })
    await call('POST', '/llm-wiki/collections', { knowledgeBaseId: otherKb, name: '对照集合' })
    try {
      const list = await call('GET', `/llm-wiki/collections?knowledgeBaseId=${kb}`)
      expect(list.status).toBe(200)
      expect(list.json.data.items).toHaveLength(1)
      expect(list.json.data.items[0].id).toBe(collectionId)
      const foreignList = await call('GET', `/llm-wiki/collections?knowledgeBaseId=${otherKb}`)
      expect(foreignList.json.data.items).toHaveLength(1)
      expect(foreignList.json.data.items[0].knowledgeBaseId).toBe(otherKb)
    } finally {
      await call('DELETE', `/knowledge-base/${otherKb}`)
    }
  })

  test('WS15 任务列表与取消：按集合过滤分页；取消挂起任务后不再发布', async () => {
    const missing = await call('GET', '/llm-wiki/compile')
    expect(missing.status).toBe(400)
    let release!: () => void
    holdPage = new Promise<void>(resolve => { release = resolve })
    const created = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: kb })
    const taskId = created.json.data.taskId
    try {
      const list = await call('GET', `/llm-wiki/compile?collectionId=${collectionId}&pageSize=50`)
      expect(list.status).toBe(200)
      expect(list.json.data.items.some((task: any) => task.id === taskId)).toBe(true)
      expect(list.json.data.items.every((task: any) => task.collectionId === collectionId)).toBe(true)

      const cancelled = await call('POST', `/llm-wiki/compile/${taskId}/cancel`)
      expect(cancelled.status).toBe(200)
      const status = await call('GET', `/llm-wiki/compile/${taskId}`)
      expect(status.json.data.status).toBe('failed')
      expect(status.json.data.error).toContain('cancelled')
      expect((await call('POST', `/llm-wiki/compile/${taskId}/cancel`)).status).toBe(400)
    } finally {
      release()
      holdPage = undefined
    }
    // worker 放行后因 fencing 终止：任务保持 cancelled failed，不发布（修订数为 0 变化）。
    await Bun.sleep(300)
    const final = await call('GET', `/llm-wiki/compile/${taskId}`)
    expect(final.json.data.status).toBe('failed')
  })

  test('WS10 修订 API 契约：默认分页、非法分页/版本 400、越界 404', async () => {
    const list = await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions`)
    expect(list.status).toBe(200)
    expect(list.json.data.items.length).toBeGreaterThanOrEqual(1)
    expect(list.json.data.items[0].revision).toBe(1)
    expect(list.json.data.items[0].reason).toBe('compiled')
    for (const suffix of ['?page=0', '?pageSize=0', '?pageSize=101', '?page=1.5']) {
      expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions${suffix}`)).status).toBe(400)
    }
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/abc`)).status).toBe(400)
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/-1`)).status).toBe(400)
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/999`)).status).toBe(404)
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/${conceptId}/revisions/0`)).status).toBe(404)
    expect((await call('GET', `/llm-wiki/collections/${collectionId}/concepts/wiki_concept_no_such/revisions`)).status).toBe(404)
  })

  test('WS11 导航与 lint 契约：结构完整且只统计可见概念', async () => {
    const overview = await call('GET', `/llm-wiki/collections/${collectionId}/navigate`)
    expect(overview.status).toBe(200)
    expect(overview.json.data.conceptCount).toBe(2)
    expect(overview.json.data.relationshipCount).toBeGreaterThanOrEqual(1)
    const stats = await call('GET', `/llm-wiki/collections/${collectionId}/navigate/graph-stats`)
    expect(stats.status).toBe(200)
    expect(stats.json.data.totalEdges).toBeGreaterThanOrEqual(1)
    expect(stats.json.data.maxDegree).toBeGreaterThanOrEqual(1)
    const lint = await call('POST', `/llm-wiki/collections/${collectionId}/lint`, {})
    expect(lint.status).toBe(200)
    expect(lint.json.data.total).toBe(lint.json.data.results.length)
    const structural = await call('GET', `/llm-wiki/collections/${collectionId}/lint`)
    expect(structural.status).toBe(200)
    expect(structural.json.data.total).toBe(structural.json.data.results.length)
    for (const result of structural.json.data.results) {
      expect(['orphan', 'broken_link', 'no_outlinks', 'contradiction', 'stale', 'missing_page', 'suggestion']).toContain(result.type)
      expect(['warning', 'info']).toContain(result.severity)
      expect(result.page).toBeTruthy()
      expect(typeof result.detail).toBe('string')
    }
    const known = structural.json.data.results.find((result: any) => result.type === 'no_outlinks')
    expect(known?.page).toBe('文档平台同步')
  })

  test('WS12 任务状态透传 documentId 与 attempt', async () => {
    const created = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: kb, documentId: 'a' })
    expect(created.status).toBe(200)
    expect(created.json.data.mode).toBe('document')
    expect((await wait(created.json.data.taskId)).status).toBe('completed')
    const status = await call('GET', `/llm-wiki/compile/${created.json.data.taskId}`)
    expect(status.status).toBe(200)
    expect(status.json.data.documentId).toBe('a')
    expect(status.json.data.attempt).toBeGreaterThanOrEqual(1)
    const full = await call('POST', '/llm-wiki/compile', { knowledgeBaseId: kb })
    expect((await wait(full.json.data.taskId)).status).toBe('completed')
    const fullStatus = await call('GET', `/llm-wiki/compile/${full.json.data.taskId}`)
    expect(fullStatus.json.data.documentId).toBeNull()
    expect(fullStatus.json.data.attempt).toBeGreaterThanOrEqual(1)
  })

  test('WS13 精确名排序：概念名与问句核心词一致时排第一（S01/S04）', async () => {
    // 复现 Q07 竞争形态：多个含核心词的长名概念 + 摘要命中噪声词，口语问句下精确名概念必须第一。
    const cloned = await pool.query(`INSERT INTO ${schema}.wiki_concepts(id,collection_id,concept_name,slug,definition,summary,content,status,citation_status,occurrence_count,tags)
      VALUES($1,$2,'同步任务验证','sync-task-verify','验证同步任务的配置','使用同步任务时的验证场景，适合检查使用效果','[{"heading":"h","content":"同步任务的使用验证"}]','compiled','verified',1,'[]'::jsonb),
            ($3,$2,'同步任务API','sync-task-api','同步任务的接口','适合在业务系统里使用同步任务 API 完成集成','[{"heading":"h","content":"同步任务API使用"}]','compiled','verified',1,'[]'::jsonb),
            ($4,$2,'同步任务写入','sync-task-write','通过同步任务写入内容','适合把外部内容使用同步任务写入知识库','[{"heading":"h","content":"同步任务写入使用"}]','compiled','verified',1,'[]'::jsonb)
      RETURNING id`, ['ws13-a', collectionId, 'ws13-b', 'ws13-c'])
    try {
      const response = await call('POST', '/llm-wiki/search', { knowledgeBaseId: kb, query: '同步任务是个什么东西，适合什么场景使用？', topK: 5, includeRelated: false })
      expect(response.status).toBe(200)
      expect(response.json.data.results.length).toBeGreaterThan(0)
      expect(response.json.data.results[0].concept.conceptName).toBe('同步任务')
    } finally {
      await pool.query(`DELETE FROM ${schema}.wiki_concepts WHERE id = ANY($1::text[])`, [cloned.rows.map((row: any) => row.id)])
    }
  })

  test('WS14 语义 lint：问题清单与结构问题一起透出，无效输出与限流显式报错', async () => {
    // 合法 LINT 块：语义问题与结构问题（no_outlinks）同时返回。
    lintOutput = '---LINT: contradiction | warning | 同步任务 ---\n正文断言与来源原文方向相反：原文说不要重复发起，页面写成可以重复。\n---END LINT---'
    const response = await call('POST', `/llm-wiki/collections/${collectionId}/lint`, { includeSemantic: true })
    expect(response.status).toBe(200)
    const semantic = response.json.data.results.find((result: any) => result.type === 'contradiction')
    expect(semantic).toMatchObject({ severity: 'warning', page: '同步任务' })
    expect(semantic.detail).toContain('方向相反')
    expect(response.json.data.results.some((result: any) => result.type === 'no_outlinks')).toBe(true)

    // NO_ISSUES：语义为空，仅结构问题。
    lintOutput = 'NO_ISSUES'
    const clean = await call('POST', `/llm-wiki/collections/${collectionId}/lint`, { includeSemantic: true })
    expect(clean.status).toBe(200)
    expect(clean.json.data.results.every((result: any) => ['orphan', 'broken_link', 'no_outlinks'].includes(result.type))).toBe(true)

    // 无效输出：页面级降级为 skipped 结果（info），不伪装无问题、不放大为全库失败。
    lintOutput = '随意文字不是审查结果'
    const invalid = await call('POST', `/llm-wiki/collections/${collectionId}/lint`, { includeSemantic: true })
    expect(invalid.status).toBe(200)
    const skipped = invalid.json.data.results.find((result: any) => result.type === 'skipped')
    expect(skipped.severity).toBe('info')
    expect(skipped.detail).toContain('无法解析')
    expect(invalid.json.data.results.some((result: any) => result.type === 'contradiction')).toBe(false)

    // 限流：报错原文透出，不降级成空结果。
    lintOutput = 'RATE_LIMIT'
    const limited = await call('POST', `/llm-wiki/collections/${collectionId}/lint`, { includeSemantic: true })
    expect(limited.status).toBe(500)
    expect(limited.json.message).toContain('速率限制')
  })
})
