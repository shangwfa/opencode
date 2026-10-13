import { describe, expect, it, mock } from 'bun:test'
import type { Triplet } from '../types.js'
import type { GraphNode } from '../types.js'

const { generateObjectMock } = ({ generateObjectMock: mock() })

mock.module('ai', () => ({
  generateObject: generateObjectMock,
  embed: mock(),
  embedMany: mock(),
}))
mock.module('../../utils/model-resolver.js', () => ({
  resolveModel: mock(() => ({ modelId: 'mock-model' })),
}))

// 在依赖 mock 就绪后再导入被测模块
const { TripletReranker, tripletToText, cosineSimilarity } = await import('./reranker.js')

function makeNode(id: string, name: string, type = 'entity'): GraphNode {
  return {
    id, knowledgeBaseId: 'kb_1', name, type,
    properties: {}, frequency: 1,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

function makeTriplet(sourceName: string, relation: string, targetName: string, score = 0.5): Triplet {
  return {
    source: makeNode(`s_${sourceName}`, sourceName),
    relation,
    target: makeNode(`t_${targetName}`, targetName),
    weight: 1,
    score,
  }
}

describe('tripletToText', () => {
  it('渲染为可读文本', () => {
    const t = makeTriplet('Python', '用于', '数据分析')
    expect(tripletToText(t)).toBe('Python（entity）--用于--> 数据分析（entity）')
  })
})

describe('cosineSimilarity', () => {
  it('同向为 1、反向为 -1、零向量安全', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
    expect(cosineSimilarity([0, 0], [1, 0])).toBe(0)
  })
})

describe('TripletReranker embedding 模式', () => {
  const queryEmbedding = [1, 0, 0]

  it('把与查询语义更近的三元组排到前面', async () => {
    // 原始排序：无关边在前（importance 高）
    const triplets = [
      makeTriplet('无关A', '相关', '无关B', 0.99),
      makeTriplet('Python', '用于', '数据分析', 0.10),
    ]
    const embedTexts = mock(async (texts: string[]) =>
      texts.map((text) => (text.includes('Python') ? [0.99, 0.1, 0] : [-0.9, 0.2, 0]))
    )

    const reranker = new TripletReranker({ mode: 'embedding', embedTexts, weight: 0.9 })
    const result = await reranker.rerank(queryEmbedding, triplets)

    expect(result.applied).toBe(true)
    expect(result.mode).toBe('embedding')
    expect(result.scoredCount).toBe(2)
    expect(result.triplets[0].source.name).toBe('Python')
    expect(embedTexts).toHaveBeenCalledTimes(1)
  })

  it('weight=0 时保持原始排序', async () => {
    const triplets = [
      makeTriplet('第一条', '关系', '终点', 0.99),
      makeTriplet('第二条', '关系', '终点', 0.10),
    ]
    const embedTexts = mock(async (texts: string[]) =>
      texts.map((text) => (text.includes('第二条') ? [1, 0] : [-1, 0]))
    )

    const reranker = new TripletReranker({ mode: 'embedding', embedTexts, weight: 0 })
    const result = await reranker.rerank([1, 0], triplets)

    expect(result.triplets[0].source.name).toBe('第一条')
  })

  it('rerank 分数写回 score 字段且在 (0, 1] 范围', async () => {
    const triplets = [makeTriplet('A', '关系', 'B', 0.9), makeTriplet('C', '关系', 'D', 0.1)]
    const embedTexts = mock(async (texts: string[]) => texts.map(() => [1, 0]))

    const reranker = new TripletReranker({ mode: 'embedding', embedTexts })
    const result = await reranker.rerank([1, 0], triplets)

    for (const t of result.triplets) {
      expect(t.score).toBeGreaterThan(0)
      expect(t.score).toBeLessThanOrEqual(1)
    }
  })

  it('embedTexts 抛错时降级保留原排序', async () => {
    const triplets = [makeTriplet('A', '关系', 'B'), makeTriplet('C', '关系', 'D')]
    const embedTexts = mock(async () => {
      throw new Error('嵌入服务不可用')
    })

    const reranker = new TripletReranker({ mode: 'embedding', embedTexts })
    const result = await reranker.rerank([1, 0], triplets)

    expect(result.applied).toBe(false)
    expect(result.error).toContain('嵌入服务不可用')
    expect(result.triplets.map((t) => t.source.name)).toEqual(['A', 'C'])
  })

  it('未提供 embedTexts 时降级并给出原因', async () => {
    const triplets = [makeTriplet('A', '关系', 'B'), makeTriplet('C', '关系', 'D')]
    const reranker = new TripletReranker({ mode: 'embedding' })
    const result = await reranker.rerank([1, 0], triplets)

    expect(result.applied).toBe(false)
    expect(result.error).toContain('embedTexts')
  })

  it('候选超过 64 条时分批嵌入（batchSize=64）', async () => {
    const triplets = Array.from({ length: 130 }, (_, i) =>
      makeTriplet(`实体${i}`, '关系', `终点${i}`)
    )
    const embedTexts = mock(async (texts: string[]) => texts.map(() => [1, 0]))

    const reranker = new TripletReranker({ mode: 'embedding', embedTexts })
    const result = await reranker.rerank([1, 0], triplets)

    expect(result.applied).toBe(true)
    expect(embedTexts).toHaveBeenCalledTimes(3)
    const batchSizes = embedTexts.mock.calls.map((call: any) => call[0].length)
    expect(batchSizes).toEqual([64, 64, 2])
    expect(result.triplets).toHaveLength(130)
  })

  it('embedTexts 返回数量不匹配时降级', async () => {
    const triplets = [makeTriplet('A', '关系', 'B'), makeTriplet('C', '关系', 'D')]
    const embedTexts = mock(async (texts: string[]) => texts.slice(1).map(() => [1, 0]))

    const reranker = new TripletReranker({ mode: 'embedding', embedTexts })
    const result = await reranker.rerank([1, 0], triplets)

    expect(result.applied).toBe(false)
    expect(result.error).toContain('数量不匹配')
  })
})

describe('TripletReranker 通用行为', () => {
  it('单条候选不触发 rerank', async () => {
    const triplets = [makeTriplet('唯一', '关系', '终点')]
    const embedTexts = mock(async () => [[1, 0]])

    const reranker = new TripletReranker({ mode: 'embedding', embedTexts })
    const result = await reranker.rerank([1, 0], triplets)

    expect(result.applied).toBe(false)
    expect(embedTexts).not.toHaveBeenCalled()
    expect(result.triplets).toHaveLength(1)
  })

  it('llm 模式缺少 queryText 时降级', async () => {
    const triplets = [makeTriplet('A', '关系', 'B'), makeTriplet('C', '关系', 'D')]
    const reranker = new TripletReranker({ mode: 'llm' })
    const result = await reranker.rerank([1, 0], triplets)

    expect(result.applied).toBe(false)
    expect(result.error).toContain('queryText')
  })
})

describe('TripletReranker llm 模式', () => {
  it('按 LLM 打分重排并归一化', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        scores: [
          { index: 0, relevance: 2 },
          { index: 1, relevance: 9 },
        ],
      },
    })

    const triplets = [
      makeTriplet('低相关', '关系', '终点', 0.9),
      makeTriplet('高相关', '关系', '终点', 0.1),
    ]

    const reranker = new TripletReranker({ mode: 'llm', weight: 0.9 })
    const result = await reranker.rerank([1, 0], triplets, 'Python 的用途')

    expect(result.applied).toBe(true)
    expect(result.mode).toBe('llm')
    expect(generateObjectMock).toHaveBeenCalledTimes(1)
    expect(result.triplets[0].source.name).toBe('高相关')
  })

  it('LLM 调用失败时降级保留原排序', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('限流'))

    const triplets = [
      makeTriplet('第一条', '关系', '终点'),
      makeTriplet('第二条', '关系', '终点'),
    ]

    const reranker = new TripletReranker({ mode: 'llm' })
    const result = await reranker.rerank([1, 0], triplets, '查询')

    expect(result.applied).toBe(false)
    expect(result.error).toContain('限流')
    expect(result.triplets.map((t) => t.source.name)).toEqual(['第一条', '第二条'])
  })

  it('LLM 返回越界 index 被忽略、不崩溃', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        scores: [
          { index: 99, relevance: 10 },
          { index: -1, relevance: 10 },
          { index: 1, relevance: 7 },
        ],
      },
    })

    const triplets = [
      makeTriplet('甲', '关系', '终点'),
      makeTriplet('乙', '关系', '终点'),
    ]

    const reranker = new TripletReranker({ mode: 'llm', weight: 0.9 })
    const result = await reranker.rerank([1, 0], triplets, '查询')

    expect(result.applied).toBe(true)
    expect(result.triplets).toHaveLength(2)
    // index=1 的乙获得 0.7 分，应排在未打分的甲之前
    expect(result.triplets[0].source.name).toBe('乙')
  })

  it('maxLLMCandidates 截断候选列表', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: { scores: [{ index: 0, relevance: 9 }] },
    })

    const triplets = Array.from({ length: 5 }, (_, i) =>
      makeTriplet(`实体${i}`, '关系', `终点${i}`)
    )

    const reranker = new TripletReranker({ mode: 'llm', maxLLMCandidates: 3 })
    const result = await reranker.rerank([1, 0], triplets, '查询')

    expect(result.applied).toBe(true)
    expect(result.triplets).toHaveLength(3)
    const calls = generateObjectMock.mock.calls
    const prompt = calls[calls.length - 1][0].prompt as string
    expect(prompt).toContain('实体0')
    expect(prompt).toContain('实体2')
    expect(prompt).not.toContain('实体3')
  })
})

describe('TripletReranker 多参考向量对齐（对标 TrustGraph query concepts 打分）', () => {
  const makeReranker = (embedTexts: (texts: string[]) => Promise<number[][]>) =>
    new TripletReranker({ mode: 'embedding', embedTexts, weight: 0.9 })

  it('与任一参考向量相似的边都能被对齐（max 余弦）', async () => {
    // 子话题边与主查询正交、与子概念向量同向
    const triplets = [
      makeTriplet('主话题边', '关系', '终点', 0.9),
      makeTriplet('子话题边', '关系', '终点', 0.1),
    ]
    const embedTexts = mock(async (texts: string[]) =>
      texts.map((t) => (t.includes('主话题') ? [1, 0] : [0, 1]))
    )

    const queryEmbedding = [1, 0]
    const subQueryEmbedding = [0, 1]

    // 单参考（旧行为）：子话题边被压后
    const single = await makeReranker(embedTexts).rerank(queryEmbedding, [...triplets])
    expect(single.triplets[0].source.name).toBe('主话题边')

    // 多参考（分解模式）：子话题边与子概念对齐，不被系统性压低
    const multi = await makeReranker(embedTexts).rerank(
      queryEmbedding,
      [...triplets],
      undefined,
      [queryEmbedding, subQueryEmbedding]
    )
    // 两条都与某个参考完全对齐 → 融合后顺序由 rerank 主导且稳定（原序不破坏）
    expect(multi.applied).toBe(true)
    expect(multi.triplets).toHaveLength(2)
  })

  it('多参考下子话题边可超越原排序登顶', async () => {
    // 原排序主话题边在前（importance 高），但只与 ref1 中等相似；
    // 子话题边与 ref2 完全同向 → rerank 满分登顶
    const triplets = [
      makeTriplet('子话题边A', '关系', '终点', 0.05),
      makeTriplet('子话题边B', '关系', '终点', 0.04),
      makeTriplet('主话题边', '关系', '终点', 0.99),
    ]
    const embedTexts = mock(async (texts: string[]) =>
      texts.map((t) => {
        if (t.includes('子话题边A')) return [0, 1]
        if (t.includes('子话题边B')) return [0, 1]
        return [0.7, 0.7] // 主话题边与两个参考均中等相似
      })
    )

    const result = await makeReranker(embedTexts).rerank(
      [1, 0],
      triplets,
      undefined,
      [[1, 0], [0, 1]]
    )

    expect(result.triplets[0].source.name).toBe('子话题边A')
    expect(result.triplets[2].source.name).toBe('主话题边')
  })
})
