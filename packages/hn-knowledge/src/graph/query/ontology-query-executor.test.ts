import { describe, expect, it } from 'bun:test'
import { InMemoryRdfQuadStore } from '../rdf/quad-store.js'
import { OntologyQueryExecutor } from './ontology-query-executor.js'
import type { RdfQuad } from '../rdf/quad-store.js'

const iri = (value: string) => ({ value, kind: 'iri' as const })

describe('OntologyQueryExecutor', () => {
  it('执行多跳 triple pattern 并返回 statement provenance', async () => {
    const store = new InMemoryRdfQuadStore()
    const facts: RdfQuad[] = [
      { id: 's1', graph: 'urn:graph:knowledge:kb', subject: iri('urn:sensor'), predicate: iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: iri('urn:Sensor'), sourceChunkId: 'doc#0', sourceRunId: 'run-1' },
      { id: 's2', graph: 'urn:graph:knowledge:kb', subject: iri('urn:sensor'), predicate: iri('urn:observes'), object: iri('urn:room'), sourceChunkId: 'doc#0', sourceRunId: 'run-1' },
    ]
    await store.add(facts)
    const executor = new OntologyQueryExecutor(store, { name: 'test', nodes: [], edges: [{ name: 'observes', uri: 'urn:observes', sourceTypes: [], targetTypes: [] }] })
    const result = await executor.execute({
      variables: ['sensor', 'room'],
      patterns: [
        { subject: { variable: 'sensor' }, predicate: { value: 'a' }, object: { value: 'urn:Sensor' } },
        { subject: { variable: 'sensor' }, predicate: { value: 'urn:observes' }, object: { variable: 'room' } },
      ],
    })
    expect(result.bindings).toHaveLength(1)
    expect(result.bindings[0].values.room.value).toBe('urn:room')
    expect(result.bindings[0].statementIds).toEqual(['s1', 's2'])
    expect(result.bindings[0].sourceChunkIds).toEqual(['doc#0'])
  })

  it('支持 inferred graph、literal、FILTER、LIMIT 和变量约束', async () => {
    const store = new InMemoryRdfQuadStore()
    await store.add([
      { id: 'i1', graph: 'urn:graph:inferred:kb', subject: iri('urn:x'), predicate: iri('urn:score'), object: { value: '10', kind: 'literal', datatype: 'xsd:integer' }, sourceChunkId: 'c1', sourceRunId: 'r1' },
      { id: 'i2', graph: 'urn:graph:inferred:kb', subject: iri('urn:y'), predicate: iri('urn:score'), object: { value: '2', kind: 'literal' } },
    ])
    const result = await new OntologyQueryExecutor(store).execute({
      variables: ['x', 'score'], graph: 'urn:graph:knowledge:kb', inferred: true, limit: 1,
      patterns: [{ subject: { variable: 'x' }, predicate: { value: 'urn:score' }, object: { variable: 'score' } }],
      filters: [{ variable: 'score', operator: '>', value: 5 }],
    })
    expect(result.bindings).toHaveLength(1)
    expect(result.bindings[0].values.score.kind).toBe('literal')
    expect(result.bindings[0].sourceRunIds).toEqual(['r1'])
  })

  it('无效 ontology property 和未绑定 FILTER 会拒绝执行', async () => {
    const executor = new OntologyQueryExecutor(new InMemoryRdfQuadStore(), { name: 'test', nodes: [], edges: [{ name: 'known', uri: 'urn:known', sourceTypes: [], targetTypes: [] }] })
    await expect(executor.execute({ variables: ['x'], patterns: [{ subject: { variable: 'x' }, predicate: { value: 'urn:unknown' }, object: { value: 'urn:o' } }] })).rejects.toThrow('未知 ontology property')
    await expect(executor.execute({ variables: ['x'], patterns: [{ subject: { variable: 'x' }, predicate: { value: 'urn:known' }, object: { value: 'urn:o' } }], filters: [{ variable: 'missing', operator: '=', value: 'x' }] })).rejects.toThrow('FILTER')
  })
})
