import { beforeEach, describe, expect, it, mock } from 'bun:test'
import { GraphMergePipeline, extractContextSnippets } from './merge-pipeline.js'
import type { GraphDB } from '../interface.js'
import type { EntityChunkTracker } from './entity-chunk-tracker.js'
import type { ChunkExtraction } from './merge-pipeline.js'
import type { OntologyConfig } from '../ontology/index.js'

function mockGraph(): GraphDB {
  const nodes = new Map<string, any>()
  const edges = new Map<string, any>()
  let nextId = 1

  return {
    supportsCypherQueries: false,
    query: mock(),
    isGraphEmpty: mock(),
    addNode: mock(async (input) => {
      const id = input.id || `id_${nextId++}`
      nodes.set(id, { ...input, id, frequency: 1, createdAt: new Date(), updatedAt: new Date() })
      return id
    }),
    addNodes: mock(async (inputs) => {
      return inputs.map((input: any) => {
        const id = input.id || `id_${nextId++}`
        nodes.set(id, { ...input, id, frequency: 1, createdAt: new Date(), updatedAt: new Date() })
        return id
      })
    }),
    getNode: mock(async (id) => nodes.get(id) || null),
    getNodes: mock(async (ids) => ids.map((id: any) => nodes.get(id)).filter(Boolean)),
    deleteNode: mock(),
    deleteNodes: mock(),
    updateNode: mock(),
    findNodeByName: mock(),
    findNodesByType: mock(),
    addEdge: mock(async (input) => {
      const key = `${input.sourceId}|${input.relationshipName}|${input.targetId}`
      edges.set(key, { ...input, createdAt: new Date(), updatedAt: new Date() })
    }),
    addEdges: mock(async (inputs) => {
      for (const input of inputs) {
        const key = `${input.sourceId}|${input.relationshipName}|${input.targetId}`
        edges.set(key, { ...input, createdAt: new Date(), updatedAt: new Date() })
      }
    }),
    getEdges: mock(),
    hasEdge: mock(),
    hasEdges: mock(),
    deleteEdge: mock(),
    getNeighbors: mock(),
    getNeighborhood: mock(),
    getConnections: mock(),
    getSubgraph: mock(),
    findPaths: mock(),
    getGraphData: mock(),
    getFilteredGraphData: mock(),
    getGraphMetrics: mock(),
    deleteGraph: mock(),
    getNodeCount: mock(),
    getEdgeCount: mock(),
    getNodeFeedbackWeights: mock(),
    setNodeFeedbackWeights: mock(),
    getEdgeFeedbackWeights: mock(),
    setEdgeFeedbackWeights: mock(),
    getNodeTruthState: mock(),
    setNodeTruthState: mock(),
    linkNodesToDocument: mock(),
  } as unknown as GraphDB
}

function mockTracker(): EntityChunkTracker {
  return {
    addEntityChunk: mock(),
    getEntityChunks: mock(),
    removeEntityChunk: mock(),
    removeEntityChunksByDocument: mock(),
    addRelationChunk: mock(),
    getRelationChunks: mock(),
    removeRelationChunk: mock(),
    removeRelationChunksByDocument: mock(),
    getEntityIdsByDocument: mock(),
    getRelationKeysByDocument: mock(),
  }
}

describe('GraphMergePipeline', () => {
  let graph: GraphDB
  let tracker: EntityChunkTracker
  let pipeline: GraphMergePipeline

  const KB = 'test_kb'

  beforeEach(() => {
    graph = mockGraph()
    tracker = mockTracker()
    pipeline = new GraphMergePipeline(graph, tracker)
  })

  it('空输入返回空结果', async () => {
    const result = await pipeline.merge([], { knowledgeBaseId: KB })
    expect(result.nodeIds).toEqual([])
    expect(result.edgeCount).toBe(0)
    expect(result.mergedEntities).toBe(0)
  })

  it('只有空提取的 chunk 也返回空', async () => {
    const chunks: ChunkExtraction[] = [
      { extraction: { entities: [], triplets: [] }, chunkId: 'c1', chunkIndex: 0, documentId: 'doc1' },
    ]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect(result.nodeIds).toEqual([])
    expect(result.edgeCount).toBe(0)
  })

  it('单 chunk 实体写入图存储', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '编程语言' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect(result.nodeIds).toHaveLength(1)
    expect(result.edgeCount).toBe(0)
    expect(result.mergedEntities).toBe(1)
    expect(graph.addNodes).toHaveBeenCalled()
    const call = (graph.addNodes as any).mock.calls[0][0]
    expect(call[0].name).toBe('Python')
    expect(call[0].type).toBe('language')
  })

  it('跨 chunk 同名实体合并：类型取高频、描述取最长', async () => {
    const chunks: ChunkExtraction[] = [
      {
        extraction: {
          entities: [{ name: 'Python', type: 'language', description: '短的' }],
          triplets: [],
        },
        chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
      },
      {
        extraction: {
          entities: [{ name: 'Python', type: 'language', description: '一个流行的编程语言' }],
          triplets: [],
        },
        chunkId: 'doc1_1', chunkIndex: 1, documentId: 'doc1',
      },
    ]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect(result.nodeIds).toHaveLength(1)
    expect(result.mergedEntities).toBe(1)
    const call = (graph.addNodes as any).mock.calls[0][0]
    expect(call[0].name).toBe('Python')
    expect(call[0].properties.description).toBe('一个流行的编程语言')
    expect(call[0].properties.mergedChunkCount).toBe(2)
  })

  it('跨 chunk 同名实体类型冲突时取高频类型', async () => {
    const chunks: ChunkExtraction[] = [
      {
        extraction: {
          entities: [{ name: 'Python', type: 'language', description: '' }],
          triplets: [],
        },
        chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
      },
      {
        extraction: {
          entities: [{ name: 'Python', type: 'language', description: '' }],
          triplets: [],
        },
        chunkId: 'doc1_1', chunkIndex: 1, documentId: 'doc1',
      },
      {
        extraction: {
          entities: [{ name: 'Python', type: 'tool', description: '' }],
          triplets: [],
        },
        chunkId: 'doc1_2', chunkIndex: 2, documentId: 'doc1',
      },
    ]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect(result.nodeIds).toHaveLength(1)
    const call = (graph.addNodes as any).mock.calls[0][0]
    expect(call[0].type).toBe('language') // 2 次 language > 1 次 tool
  })

  it('跨 chunk 关系合并：权重为 max(平均置信度, chunk 数)', async () => {
    const chunks: ChunkExtraction[] = [
      {
        extraction: {
          entities: [
            { name: 'Python', type: 'language', description: '' },
            { name: 'FastAPI', type: 'framework', description: '' },
          ],
          triplets: [{ source: 'Python', relation: '用于', target: 'FastAPI', confidence: 0.8 }],
        },
        chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
      },
      {
        extraction: {
          entities: [
            { name: 'Python', type: 'language', description: '' },
            { name: 'FastAPI', type: 'framework', description: '' },
          ],
          triplets: [{ source: 'Python', relation: '用于', target: 'FastAPI', confidence: 0.6 }],
        },
        chunkId: 'doc1_1', chunkIndex: 1, documentId: 'doc1',
      },
    ]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect(result.nodeIds).toHaveLength(2)
    expect(result.edgeCount).toBe(1)
    expect(result.mergedRelations).toBe(1)

    const edgeCall = (graph.addEdges as any).mock.calls
    // 检查业务关系（不是 is_a 边）
    const bizEdge = edgeCall.find((call: any) => call[0]?.some((e: any) => e.relationshipName !== 'is_a'))
    expect(bizEdge).toBeDefined()
    const bizEdgeData = bizEdge[0].find((e: any) => e.relationshipName !== 'is_a')
    // 权重契约：weight = max(avg_confidence, evidence_count)
    // avg_confidence = (0.8 + 0.6) / 2 = 0.7, evidence_count = chunkIds.size = 2
    expect(bizEdgeData.weight).toBeGreaterThanOrEqual(2)
    expect(bizEdgeData.relationshipName).toBe('用于')
  })

  it('写前日志：在写入图之前先写入 chunk tracking', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    // addEntityChunk 应该在 addNodes 之前被调用
    const addTrackerCall = (tracker.addEntityChunk as any).mock.calls[0]
    expect(addTrackerCall).toBeDefined()
    expect(addTrackerCall[1]).toBe('doc1_0')
    expect(addTrackerCall[2]).toBe(KB)
  })

  it('多实体多关系合并去重', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [
          { name: 'Python', type: 'language', description: '' },
          { name: 'TypeScript', type: 'language', description: '' },
          { name: 'FastAPI', type: 'framework', description: '' },
        ],
        triplets: [
          { source: 'Python', relation: '用于', target: 'FastAPI', confidence: 0.9 },
          { source: 'TypeScript', relation: '对比', target: 'Python', confidence: 0.7 },
        ],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect(result.nodeIds).toHaveLength(3)
    expect(result.edgeCount).toBe(2)
    expect(result.mergedEntities).toBe(3)
    expect(result.mergedRelations).toBe(2)
  })

  it('EntityType 节点创建', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [
          { name: 'Python', type: 'language', description: '' },
          { name: 'FastAPI', type: 'framework', description: '' },
        ],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    // addNodes 会被调用两次：一次是业务实体，一次是 EntityType 节点
    expect(graph.addNodes).toHaveBeenCalledTimes(2)
    // 第一次调用写入业务实体，第二次写入 EntityType 节点
    const secondCall = (graph.addNodes as any).mock.calls[1][0]
    const typeNames = secondCall.map((n: any) => n.name).sort()
    expect(typeNames).toEqual(['framework', 'language'])
  })

  it('buildEntityTypeNodes=false 时跳过 EntityType', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB, buildEntityTypeNodes: false })
    expect(graph.addNodes).toHaveBeenCalledTimes(1) // 只有业务实体，没有 EntityType
  })

  it('置信度 < 0.3 的三元组在 GraphBuilder 中被过滤，但 MergePipeline 保留所有有效实体', async () => {
    // MergePipeline 不过滤低置信度三元组（保留给下游处理），
    // 但关系必须有对应的实体才能写入。
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '' }],
        triplets: [{ source: 'Python', relation: '用于', target: 'FastAPI', confidence: 0.1 }],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    // FastAPI 不在实体列表中，所以关系被跳过
    expect(result.nodeIds).toHaveLength(1)
    expect(result.edgeCount).toBe(0)
  })

  it('文档-节点关联写入', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect((graph as any).linkNodesToDocument).toHaveBeenCalled()
    const linkCall = ((graph as any).linkNodesToDocument).mock.calls[0][0]
    expect(linkCall.documentId).toBe('doc1')
    expect(linkCall.nodeIds).toHaveLength(1)
  })
})

describe('GraphMergePipeline 本体硬校验（对标 TrustGraph OntoRAG is_valid_triple）', () => {
  const KB = 'test_kb'

  const miniOntology: OntologyConfig = {
    name: 'mini',
    nodes: [
      { type: 'language' },
      { type: 'framework' },
    ],
    edges: [
      { name: '使用', sourceTypes: ['person'], targetTypes: ['language'] },
      { name: '基于', sourceTypes: ['framework'], targetTypes: ['language'] },
    ],
  }

  let graph: GraphDB
  let tracker: EntityChunkTracker
  let pipeline: GraphMergePipeline

  beforeEach(() => {
    graph = mockGraph()
    tracker = mockTracker()
    pipeline = new GraphMergePipeline(graph, tracker)
  })

  it('剔除未知类型的实体并记录 violations', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [
          { name: 'Python', type: 'language', description: '' },
          { name: '神秘物质', type: 'alien_tech', description: '' },
        ],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0,
    }]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB, ontology: miniOntology })
    expect(result.mergedEntities).toBe(1)
    expect(result.violations).toHaveLength(1)
    expect(result.violations![0].kind).toBe('unknown_node_type')
    expect(result.violations![0].detail).toContain('alien_tech')
  })

  it('剔除 domain 违规的关系（source 类型不允许发出该关系）', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [
          { name: 'Python', type: 'language', description: '' },
          { name: 'Rust', type: 'language', description: '' },
        ],
        // 「使用」只允许 person 发出，language → language 违规
        triplets: [{ source: 'Python', relation: '使用', target: 'Rust', confidence: 0.9 }],
      },
      chunkId: 'doc1_0', chunkIndex: 0,
    }]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB, ontology: miniOntology })
    expect(result.edgeCount).toBe(0)
    expect(result.violations).toHaveLength(1)
    expect(result.violations![0].kind).toBe('relation_not_allowed')
  })

  it('保留符合本体约束的三元组', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [
          { name: 'FastAPI', type: 'framework', description: '' },
          { name: 'Python', type: 'language', description: '' },
        ],
        triplets: [{ source: 'FastAPI', relation: '基于', target: 'Python', confidence: 0.9 }],
      },
      chunkId: 'doc1_0', chunkIndex: 0,
    }]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB, ontology: miniOntology })
    expect(result.edgeCount).toBe(1)
    expect(result.violations).toHaveLength(0)
  })

  it('不传 ontology 时行为不变（无 violations 字段）', async () => {
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0,
    }]
    const result = await pipeline.merge(chunks, { knowledgeBaseId: KB })
    expect(result.violations).toBeUndefined()
    expect(result.mergedEntities).toBe(1)
  })
})

describe('实体上下文嵌入（对标 TrustGraph EntityContexts）', () => {
  const KB = 'test_kb'

  it('extractContextSnippets 提取实体周围窗口片段', () => {
    const text = '前缀介绍。'.repeat(10) + 'Python 是一门流行的编程语言，广泛应用于数据领域。' + '后缀补充。'.repeat(10)
    const snippets = extractContextSnippets(text, 'Python', 20, 2)
    expect(snippets).toHaveLength(1)
    expect(snippets[0]).toContain('Python')
    expect(snippets[0].length).toBeLessThanOrEqual('Python'.length + 20 * 2 + 2)
  })

  it('extractContextSnippets 大小写不敏感且多次出现返回多个片段', () => {
    const text = 'python 很好。中间内容。Python 也很流行。'
    const snippets = extractContextSnippets(text, 'PYTHON', 5, 2)
    expect(snippets).toHaveLength(2)
  })

  it('extractContextSnippets 实体不存在返回空', () => {
    expect(extractContextSnippets('hello world', 'Java')).toEqual([])
    expect(extractContextSnippets('', 'Java')).toEqual([])
    expect(extractContextSnippets('hello', '')).toEqual([])
  })

  it('chunkText 提供时嵌入文本包含上下文片段', async () => {
    const graph = mockGraph()
    const tracker = mockTracker()
    const embeddedTexts: string[] = []
    const pipeline = new GraphMergePipeline(graph, tracker, async (texts) => {
      embeddedTexts.push(...texts)
      return texts.map(() => [0.1, 0.2, 0.3])
    })

    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '编程语言' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0,
      chunkText: '在本教程中，Python 被用于构建数据处理管道，非常高效。',
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    expect(embeddedTexts).toHaveLength(1)
    expect(embeddedTexts[0]).toContain('Python')
    expect(embeddedTexts[0]).toContain('编程语言')
    expect(embeddedTexts[0]).toContain('上下文')
    expect(embeddedTexts[0]).toContain('数据处理管道')
  })

  it('无 chunkText 时嵌入文本退化为名称+描述', async () => {
    const graph = mockGraph()
    const tracker = mockTracker()
    const embeddedTexts: string[] = []
    const pipeline = new GraphMergePipeline(graph, tracker, async (texts) => {
      embeddedTexts.push(...texts)
      return texts.map(() => [0.1, 0.2, 0.3])
    })

    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '编程语言' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0,
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    expect(embeddedTexts[0]).toBe('Python：编程语言')
  })

  it('嵌入文本超过 512 字符时截断', async () => {
    const graph = mockGraph()
    const tracker = mockTracker()
    const embeddedTexts: string[] = []
    const pipeline = new GraphMergePipeline(graph, tracker, async (texts) => {
      embeddedTexts.push(...texts)
      return texts.map(() => [0.1, 0.2, 0.3])
    })

    const longText = '很长的上下文内容'.repeat(200) // 1600 字符
    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '编程语言' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0,
      chunkText: longText,
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    expect(embeddedTexts).toHaveLength(1)
    expect(embeddedTexts[0].length).toBeLessThanOrEqual(512)
    expect(embeddedTexts[0].startsWith('Python：')).toBe(true)
  })

  it('重复上下文片段去重', async () => {
    const graph = mockGraph()
    const tracker = mockTracker()
    const embeddedTexts: string[] = []
    const pipeline = new GraphMergePipeline(graph, tracker, async (texts) => {
      embeddedTexts.push(...texts)
      return texts.map(() => [0.1, 0.2, 0.3])
    })

    const chunks: ChunkExtraction[] = [
      {
        extraction: {
          entities: [{ name: 'Python', type: 'language', description: '' }],
          triplets: [],
        },
        chunkId: 'doc1_0', chunkIndex: 0,
        chunkText: 'Python 很流行',
      },
      {
        extraction: {
          entities: [{ name: 'Python', type: 'language', description: '' }],
          triplets: [],
        },
        chunkId: 'doc1_1', chunkIndex: 1,
        chunkText: 'Python 很流行',
      },
    ]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    const count = embeddedTexts[0].split('Python 很流行').length - 1
    expect(count).toBe(1)
  })
})
describe('Page 级溯源透传（对标 TrustGraph Document→Page→Chunk 链）', () => {
  const KB = 'test_kb'

  it('ChunkExtraction.pageIndex 透传到 linkNodesToDocument', async () => {
    const graph = mockGraph()
    const tracker = mockTracker()
    const pipeline = new GraphMergePipeline(graph, tracker)

    const chunks: ChunkExtraction[] = [
      {
        extraction: {
          entities: [{ name: 'Python', type: 'language', description: '' }],
          triplets: [],
        },
        chunkId: 'doc1_0', chunkIndex: 3, documentId: 'doc1',
        pageIndex: 7,
      },
    ]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    expect((graph as any).linkNodesToDocument).toHaveBeenCalled()
    const linkCall = ((graph as any).linkNodesToDocument as any).mock.calls[0][0]
    expect(linkCall.pageIndex).toBe(7)
    expect(linkCall.chunkIndex).toBe(3)
  })

  it('无 pageIndex 时不阻断关联写入', async () => {
    const graph = mockGraph()
    const tracker = mockTracker()
    const pipeline = new GraphMergePipeline(graph, tracker)

    const chunks: ChunkExtraction[] = [{
      extraction: {
        entities: [{ name: 'Python', type: 'language', description: '' }],
        triplets: [],
      },
      chunkId: 'doc1_0', chunkIndex: 0, documentId: 'doc1',
    }]
    await pipeline.merge(chunks, { knowledgeBaseId: KB })

    const linkCall = ((graph as any).linkNodesToDocument as any).mock.calls[0][0]
    expect(linkCall.pageIndex).toBeUndefined()
    expect((graph as any).linkNodesToDocument).toHaveBeenCalled()
  })
})
