import { describe, expect, it } from 'bun:test'
import { OntologyRegistry } from './registry.js'

describe('OntologyRegistry', () => {
  it('创建不可变快照并发布时废弃旧版本', () => {
    const registry = new OntologyRegistry()
    const v1 = registry.create('support', { name: 'v1', nodes: [], edges: [] })
    const v2 = registry.create('support', { name: 'v2', nodes: [{ type: 'Product' }], edges: [] })
    registry.publish('support', v1.version)
    registry.publish('support', v2.version)

    expect(registry.getActive('support')?.version).toBe(2)
    expect(registry.get('support', 1)?.status).toBe('deprecated')
    expect(v1.contentHash).not.toBe(v2.contentHash)
    const snapshot = registry.get('support', 2)!
    snapshot.config.name = 'mutated'
    expect(registry.get('support', 2)?.config.name).toBe('v2')
  })

  it('缺失 ontology 或版本时抛错，未发布版本不算 active', () => {
    const registry = new OntologyRegistry()
    expect(registry.getActive('missing')).toBeNull()
    expect(registry.list('missing')).toEqual([])
    expect(() => registry.publish('missing', 1)).toThrow('ontology 不存在')
    registry.create('support', { name: 'draft', nodes: [], edges: [] })
    expect(registry.getActive('support')).toBeNull()
    expect(() => registry.publish('support', 2)).toThrow('版本不存在')
  })
})
