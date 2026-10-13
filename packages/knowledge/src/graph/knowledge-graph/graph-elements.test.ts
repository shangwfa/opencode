import { describe, expect, it } from 'bun:test'
import {
  createGraphElementNode,
  createGraphElementEdge,
  isAlive,
  toJson,
} from './graph-elements.js'
import type { GraphNode } from '../types.js'

describe('GraphElements', () => {
  const nodeData: GraphNode = {
    id: '1',
    knowledgeBaseId: 'kb_1',
    name: 'TestNode',
    type: 'entity',
    properties: { key: 'value' },
    frequency: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
  }

  it('should create a graph element node', () => {
    const el = createGraphElementNode(nodeData)
    expect(el.id).toBe('1')
    expect(el.attributes.name).toBe('TestNode')
    expect(el.attributes.type).toBe('entity')
    expect(el.attributes.frequency).toBe(5)
    expect(el.attributes.key).toBe('value')
    expect(el.status).toBeInstanceOf(Float64Array)
    expect(el.status[0]).toBe(1)
  })

  it('should create a graph element edge', () => {
    const n1 = createGraphElementNode(nodeData)
    const n2 = createGraphElementNode({ ...nodeData, id: '2', name: 'TargetNode' })
    const edge = createGraphElementEdge(
      {
        sourceId: '1',
        targetId: '2',
        relationshipName: 'connects',
        properties: { weight: 0.9 },
        weight: 0.9,
        knowledgeBaseId: 'kb_1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      n1,
      n2
    )
    expect(edge.node1.id).toBe('1')
    expect(edge.node2.id).toBe('2')
    expect(edge.edgeTypeId).toBe('connects')
    expect(edge.directed).toBe(false)
    expect(edge.attributes.weight).toBe(0.9)
  })

  it('should check if element is alive', () => {
    const el = createGraphElementNode(nodeData)
    expect(isAlive(el)).toBe(true)
    el.status[0] = 0
    expect(isAlive(el)).toBe(false)
  })

  it('should convert node to json', () => {
    const el = createGraphElementNode(nodeData)
    const json = toJson(el)
    expect(json.id).toBe('1')
    expect((json.attributes as any).name).toBe('TestNode')
  })

  it('should convert edge to json', () => {
    const n1 = createGraphElementNode(nodeData)
    const n2 = createGraphElementNode({ ...nodeData, id: '2', name: 'Target' })
    const edge = createGraphElementEdge(
      {
        sourceId: '1', targetId: '2', relationshipName: 'rel',
        weight: 1, knowledgeBaseId: 'kb_1',
        createdAt: new Date(), updatedAt: new Date(),
      } as any,
      n1, n2, true
    )
    const json = toJson(edge)
    expect(json.sourceId).toBe('1')
    expect(json.targetId).toBe('2')
    expect(json.directed).toBe(true)
  })
})