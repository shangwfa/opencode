import { describe, expect, it } from 'bun:test'
import { InMemoryRdfQuadStore } from '../rdf/quad-store.js'
import { OntologyQueryService } from './ontology-query-service.js'

describe('OntologyQueryService', () => {
  it('同时提供查询计划解释和执行入口', async () => {
    const service = new OntologyQueryService(new InMemoryRdfQuadStore(), {
      name: 'test', nodes: [], edges: [{ name: 'knows', uri: 'urn:knows', sourceTypes: [], targetTypes: [] }],
    })
    const plan = { variables: ['x'], patterns: [{ subject: { variable: 'x' }, predicate: { value: 'urn:knows' }, object: { value: 'urn:y' } }] }
    expect(service.explain(plan).errors).toEqual([])
    expect(service.explain(plan).sparql).toContain('<urn:knows>')
    expect((await service.query(plan)).bindings).toEqual([])
  })
})
