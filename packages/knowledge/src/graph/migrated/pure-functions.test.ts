/**
 * 移植自 cognee 的纯函数测试（图存储层不变量）
 *
 * 源：
 * - cognee/tests/unit/infrastructure/databases/graph/test_postgres_adapter.py（11 用例）
 * - cognee/tests/unit/modules/graph/test_temporal_conflict_resolver.py（12 用例）
 * - cognee/tests/unit/tasks/graph/test_detect_contradictions.py（纯函数部分）
 */
import { describe, expect, it } from 'bun:test'
import {
  stripNulBytesDeep,
  prepareNodeRows,
  prepareEdgeRows,
  componentSizes,
  selectNodesetNeighborIds,
} from '../pg-adapter/row-utils.js'
import { tagSupersededEdges, FUNCTIONAL_RELATIONS } from '../algorithms/temporal-conflict-resolver.js'
import type { GraphEdge } from '../types.js'

// =============== row-utils（对标 test_postgres_adapter.py） ===============

describe('移植: prepareNodeRows', () => {
  it('核心列提取，其余进 properties', () => {
    const rows = prepareNodeRows([
      { id: '1', knowledgeBaseId: 'kb', name: 'Alice', type: 'Person', properties: { age: 30 } },
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('1')
    expect(rows[0].name).toBe('Alice')
    expect(rows[0].type).toBe('Person')
    expect(rows[0].properties).toEqual({ age: 30 })
  })

  it('元组 id 权威，properties 里的 id 被剥离', () => {
    const rows = prepareNodeRows([
      { id: 'authentic', knowledgeBaseId: 'kb', name: 'A', type: 'T', properties: { id: 'conflicting' } },
    ])
    expect(rows[0].id).toBe('authentic')
    expect(rows[0].properties.id).toBeUndefined()
  })

  it('同 id 重复保留最后一条并按 id 排序', () => {
    const rows = prepareNodeRows([
      { id: 'b', knowledgeBaseId: 'kb', name: 'old-b', type: 'T' },
      { id: 'a', knowledgeBaseId: 'kb', name: 'a', type: 'T' },
      { id: 'b', knowledgeBaseId: 'kb', name: 'new-b', type: 'T' },
    ])
    expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    expect(rows.find((r) => r.id === 'b')!.name).toBe('new-b')
  })

  it('列与嵌套值中的 NUL 字节均被清除', () => {
    const rows = prepareNodeRows([
      { id: 'id\0bad', knowledgeBaseId: 'kb', name: 'Na\0me', type: 'T\0', properties: { nested: { v: 'x\0y' }, arr: ['a\0b'] } },
    ])
    expect(rows[0].id).toBe('idbad')
    expect(rows[0].name).toBe('Name')
    expect(rows[0].type).toBe('T')
    expect(rows[0].properties.nested).toEqual({ v: 'xy' })
    expect(rows[0].properties.arr).toEqual(['ab'])
  })

  it('清洗不改写调用方数据（深拷贝语义）', () => {
    const props = { nested: { v: 'x\0y' } }
    const original = JSON.parse(JSON.stringify(props))
    prepareNodeRows([{ id: '1', knowledgeBaseId: 'kb', name: 'A', type: 'T', properties: props }])
    expect(props).toEqual(original)
  })
})

describe('移植: prepareEdgeRows', () => {
  it('同三元组去重保最后、按身份排序', () => {
    const rows = prepareEdgeRows([
      { sourceId: 'z', targetId: 'a', relationshipName: 'KNOWS', knowledgeBaseId: 'kb' },
      { sourceId: 'a', targetId: 'z', relationshipName: 'KNOWS', knowledgeBaseId: 'kb' },
      { sourceId: 'z', targetId: 'a', relationshipName: 'KNOWS', knowledgeBaseId: 'kb', properties: { last: true } },
    ])
    expect(rows).toHaveLength(2)
    // 排序按 source|target|rel 字典序
    expect(rows[0].sourceId).toBe('a')
    expect(rows[1].sourceId).toBe('z')
    expect(rows[1].properties).toEqual({ last: true }) // 最后值获胜
  })

  it('身份列净化 + properties 缺省/None 归一为 {}', () => {
    const rows = prepareEdgeRows([
      { sourceId: 's\0', targetId: 't', relationshipName: 'KNOWS\0', knowledgeBaseId: 'kb', properties: null },
      { sourceId: 's2', targetId: 't2', relationshipName: 'R', knowledgeBaseId: 'kb' },
    ])
    expect(rows[0].sourceId).toBe('s')
    expect(rows[0].relationshipName).toBe('KNOWS')
    expect(rows[0].properties).toEqual({})
    expect(rows[1].properties).toEqual({})
  })

  it('weight 缺省为 1', () => {
    const rows = prepareEdgeRows([
      { sourceId: 's', targetId: 't', relationshipName: 'R', knowledgeBaseId: 'kb' },
    ])
    expect(rows[0].weight).toBe(1)
  })
})

describe('移植: stripNulBytesDeep', () => {
  it('字符串/数组/嵌套对象递归净化', () => {
    expect(stripNulBytesDeep('a\0b')).toBe('ab')
    expect(stripNulBytesDeep(['x\0', { y: 'z\0' }])).toEqual(['x', { y: 'z' }])
    expect(stripNulBytesDeep(42)).toBe(42)
    expect(stripNulBytesDeep(null)).toBe(null)
  })
})

describe('移植: componentSizes（无向连通分量）', () => {
  it('[3,2,1] 分量与降序', () => {
    // a-b-c 连通；d-e 连通；f 孤立
    const sizes = componentSizes(
      ['a', 'b', 'c', 'd', 'e', 'f'],
      [
        { sourceId: 'a', targetId: 'b' },
        { sourceId: 'b', targetId: 'c' },
        { sourceId: 'd', targetId: 'e' },
      ]
    )
    expect(sizes).toEqual([3, 2, 1])
  })

  it('自环不改变连通性', () => {
    const sizes = componentSizes(['a', 'b'], [{ sourceId: 'a', targetId: 'a' }])
    expect(sizes).toEqual([1, 1])
  })

  it('空输入返回空', () => {
    expect(componentSizes([], [])).toEqual([])
  })

  it('边引用未知节点时忽略（只统计已知节点）', () => {
    const sizes = componentSizes(['a'], [{ sourceId: 'a', targetId: 'ghost' }])
    expect(sizes).toEqual([1])
  })
})

describe('移植: selectNodesetNeighborIds', () => {
  const adjacency = new Map<string, string[]>([
    ['n1', ['n2', 'n3']],
    ['n2', ['n1', 'n3']],
    ['n3', ['n1']],
  ])

  it('OR：任一 primaries 的邻居并集', () => {
    const result = selectNodesetNeighborIds(adjacency, ['n1', 'n2'], 'OR')
    expect([...result].sort()).toEqual(['n1', 'n2', 'n3'])
  })

  it('AND：全部 primaries 的邻居交集', () => {
    // n2 的邻居 {n1,n3}，n3 的邻居 {n1} → 交集 {n1}
    const result = selectNodesetNeighborIds(adjacency, ['n2', 'n3'], 'AND')
    expect([...result]).toEqual(['n1'])
  })

  it('空 primaries 返回空集', () => {
    expect(selectNodesetNeighborIds(adjacency, [], 'OR').size).toBe(0)
    expect(selectNodesetNeighborIds(adjacency, [], 'AND').size).toBe(0)
  })

  it('非法操作符抛错', () => {
    expect(() => selectNodesetNeighborIds(adjacency, ['n1'], 'XOR' as any)).toThrow(
      /must be 'OR' or 'AND'/
    )
  })
})

// =============== tagSupersededEdges（对标 test_temporal_conflict_resolver.py 12 用例） ===============

function makeEdge(over: Partial<GraphEdge> & { sourceId: string; targetId: string; relationshipName: string }): GraphEdge {
  return {
    properties: {},
    weight: 1,
    knowledgeBaseId: 'kb',
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...over,
  } as GraphEdge
}

describe('移植: tagSupersededEdges', () => {
  const functional = new Set(['版本为', '状态为'])

  it('无 functional 关系时是 no-op', () => {
    const edges = [makeEdge({ sourceId: 's', targetId: 't1', relationshipName: '使用' })]
    expect(tagSupersededEdges(edges, functional)).toEqual([])
  })

  it('functional 集合为空返回空', () => {
    const edges = [makeEdge({ sourceId: 's', targetId: 't1', relationshipName: '版本为' })]
    expect(tagSupersededEdges(edges, new Set())).toEqual([])
  })

  it('空边列表返回空', () => {
    expect(tagSupersededEdges([], functional)).toEqual([])
  })

  it('同 target 重申不算矛盾', () => {
    const edges = [
      makeEdge({ sourceId: 's', targetId: 't', relationshipName: '版本为', updatedAt: new Date('2024-01-01') }),
      makeEdge({ sourceId: 's', targetId: 't', relationshipName: '版本为', updatedAt: new Date('2025-01-01') }),
    ]
    expect(tagSupersededEdges(edges, functional)).toEqual([])
  })

  it('单条 functional 边不折叠', () => {
    const edges = [makeEdge({ sourceId: 's', targetId: 't', relationshipName: '版本为' })]
    expect(tagSupersededEdges(edges, functional)).toEqual([])
  })

  it('functional 冲突保留最新（旧边被标记 superseded + supersededBy）', () => {
    const old = makeEdge({
      sourceId: 's', targetId: 'v5', relationshipName: '版本为',
      properties: { effectiveDate: '2024-01-01' },
    })
    const recent = makeEdge({
      sourceId: 's', targetId: 'v6', relationshipName: '版本为',
      properties: { effectiveDate: '2025-06-01' },
    })
    const tagged = tagSupersededEdges([old, recent], functional)

    expect(tagged).toHaveLength(1)
    expect(tagged[0].edge.targetId).toBe('v5')
    expect(tagged[0].edge.properties.superseded).toBe(true)
    expect(tagged[0].edge.properties.superseded_by).toContain('v6')
    expect(String(tagged[0].edge.properties.supersession_reason)).toContain('版本为')
  })

  it('多值关系永不折叠', () => {
    const edges = [
      makeEdge({ sourceId: 's', targetId: 't1', relationshipName: '使用' }),
      makeEdge({ sourceId: 's', targetId: 't2', relationshipName: '使用' }),
    ]
    expect(tagSupersededEdges(edges, functional)).toEqual([])
  })

  it('recency 平局按位置（后者胜）', () => {
    const sameTime = new Date('2024-06-01')
    const first = makeEdge({ sourceId: 's', targetId: 't1', relationshipName: '版本为', updatedAt: sameTime })
    const second = makeEdge({ sourceId: 's', targetId: 't2', relationshipName: '版本为', updatedAt: sameTime })
    const tagged = tagSupersededEdges([first, second], functional)

    expect(tagged).toHaveLength(1)
    expect(tagged[0].edge.targetId).toBe('t1') // 先出现的被取代
  })

  it('输入不被修改', () => {
    const old = makeEdge({
      sourceId: 's', targetId: 'v5', relationshipName: '版本为',
      properties: { effectiveDate: '2024-01-01' },
    })
    const recent = makeEdge({
      sourceId: 's', targetId: 'v6', relationshipName: '版本为',
      properties: { effectiveDate: '2025-06-01' },
    })
    const tagged = tagSupersededEdges([old, recent], functional)
    // 原对象的属性未被添加 superseded 标记（返回的是副本）
    expect(tagged).toHaveLength(1)
    expect((old.properties as any).superseded).toBeUndefined()
    expect(old.properties).toEqual({ effectiveDate: '2024-01-01' })
    expect(old.targetId).toBe('v5')
  })

  it('被取代边保留原属性', () => {
    const old = makeEdge({
      sourceId: 's', targetId: 'v5', relationshipName: '版本为',
      properties: { effectiveDate: '2024-01-01', sourceDocumentId: 'doc1', custom: 'keep-me' },
    })
    const recent = makeEdge({
      sourceId: 's', targetId: 'v6', relationshipName: '版本为',
      properties: { effectiveDate: '2025-06-01' },
    })
    const tagged = tagSupersededEdges([old, recent], functional)
    expect(tagged[0].edge.properties.sourceDocumentId).toBe('doc1')
    expect(tagged[0].edge.properties.custom).toBe('keep-me')
  })

  it('混合批次只标记 functional 冲突', () => {
    const edges = [
      makeEdge({ sourceId: 's', targetId: 'v5', relationshipName: '版本为', properties: { effectiveDate: '2024-01-01' } }),
      makeEdge({ sourceId: 's', targetId: 'v6', relationshipName: '版本为', properties: { effectiveDate: '2025-06-01' } }),
      // 多值关系冲突不标记
      makeEdge({ sourceId: 's', targetId: 't1', relationshipName: '使用' }),
      makeEdge({ sourceId: 's', targetId: 't2', relationshipName: '使用' }),
    ]
    const tagged = tagSupersededEdges(edges, functional)
    expect(tagged).toHaveLength(1)
    expect(tagged[0].edge.relationshipName).toBe('版本为')
  })

  it('多 subject 独立解析', () => {
    const edges = [
      // subject1: 旧→新
      makeEdge({ sourceId: 's1', targetId: 'a1', relationshipName: '版本为', properties: { effectiveDate: '2024-01-01' } }),
      makeEdge({ sourceId: 's1', targetId: 'a2', relationshipName: '版本为', properties: { effectiveDate: '2025-01-01' } }),
      // subject2: 旧→新
      makeEdge({ sourceId: 's2', targetId: 'b1', relationshipName: '版本为', properties: { effectiveDate: '2024-01-01' } }),
      makeEdge({ sourceId: 's2', targetId: 'b2', relationshipName: '版本为', properties: { effectiveDate: '2025-01-01' } }),
    ]
    const tagged = tagSupersededEdges(edges, functional)
    expect(tagged).toHaveLength(2)
    expect(tagged.every((t) => t.edge.targetId.endsWith('1'))).toBe(true)
  })

  it('默认 FUNCTIONAL_RELATIONS 常量非空', () => {
    expect(FUNCTIONAL_RELATIONS.length).toBeGreaterThan(0)
    expect(FUNCTIONAL_RELATIONS).toContain('版本为')
  })
})