import { beforeEach, describe, expect, it, mock } from 'bun:test'
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
const { EdgeReasoner } = await import('./edge-reasoner.js')

function makeNode(id: string, name: string): GraphNode {
  return {
    id, knowledgeBaseId: 'kb_1', name, type: 'entity',
    properties: {}, frequency: 1,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

function makeTriplet(s: string, rel: string, t: string): Triplet {
  return { source: makeNode(`s_${s}`, s), relation: rel, target: makeNode(`t_${t}`, t), weight: 1, score: 0.5 }
}

describe('EdgeReasoner（对标 TrustGraph edge reasoning）', () => {
  beforeEach(() => {
    generateObjectMock.mockReset()
  })

  it('为每条边生成解释并按 index 映射', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        reasons: [
          { index: 0, reason: 'Python 是回答语言问题的核心实体' },
          { index: 1, reason: '关联较弱：与问题无直接关系' },
        ],
      },
    })

    const reasoner = new EdgeReasoner()
    const map = await reasoner.explain('Python 能做什么', [
      makeTriplet('Python', '用于', '数据分析'),
      makeTriplet('无关A', '相关', '无关B'),
    ])

    expect(map.get(0)).toContain('Python')
    expect(map.get(1)).toContain('关联较弱')
    expect(map.size).toBe(2)
  })

  it('越界 index 被忽略', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        reasons: [
          { index: 5, reason: '越界' },
          { index: 0, reason: '有效解释' },
        ],
      },
    })

    const reasoner = new EdgeReasoner()
    const map = await reasoner.explain('q', [makeTriplet('A', '关系', 'B')])
    expect(map.size).toBe(1)
    expect(map.get(0)).toBe('有效解释')
  })

  it('maxEdges 截断候选', async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { reasons: [] } })

    const triplets = Array.from({ length: 20 }, (_, i) => makeTriplet(`E${i}`, '关系', `T${i}`))
    const reasoner = new EdgeReasoner({ maxEdges: 5 })
    await reasoner.explain('q', triplets)

    const prompt = generateObjectMock.mock.calls[0][0].prompt as string
    expect(prompt).toContain('E4')
    expect(prompt).not.toContain('E5')
  })

  it('LLM 失败时返回空映射（降级不抛异常）', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('模型超时'))

    const reasoner = new EdgeReasoner()
    const map = await reasoner.explain('q', [makeTriplet('A', '关系', 'B')])
    expect(map.size).toBe(0)
  })

  it('空查询或空三元组直接返回空映射（不调用 LLM）', async () => {
    const reasoner = new EdgeReasoner()
    expect((await reasoner.explain('', [makeTriplet('A', '关系', 'B')])).size).toBe(0)
    expect((await reasoner.explain('q', [])).size).toBe(0)
    expect(generateObjectMock).not.toHaveBeenCalled()
  })
})
