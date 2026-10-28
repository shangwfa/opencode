import { describe, expect, it } from 'bun:test'
import { inferOntologyFacts } from './reasoner.js'
import type { RdfQuad } from './quad-store.js'

const iri = (value: string) => ({ value, kind: 'iri' as const })

describe('inferOntologyFacts', () => {
  it('推断父类、domain 和 inverse，并检测 functional 冲突', () => {
    const sensor = 'urn:Sensor'
    const device = 'urn:Device'
    const observes = 'urn:observes'
    const facts: RdfQuad[] = [
      { id: '1', graph: 'urn:graph:knowledge', subject: iri('urn:s1'), predicate: iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: iri(sensor) },
      { id: '2', graph: 'urn:graph:knowledge', subject: iri('urn:s1'), predicate: iri(observes), object: iri('urn:o1') },
      { id: '3', graph: 'urn:graph:knowledge', subject: iri('urn:s1'), predicate: iri('urn:name'), object: { value: 'A', kind: 'literal' } },
      { id: '4', graph: 'urn:graph:knowledge', subject: iri('urn:s1'), predicate: iri('urn:name'), object: { value: 'B', kind: 'literal' } },
    ]
    const result = inferOntologyFacts(facts, {
      name: 'test',
      nodes: [{ type: 'Sensor', uri: sensor, parentTypes: ['Device'] }, { type: 'Device', uri: device }],
      edges: [
        { name: 'observes', uri: observes, sourceTypes: ['Sensor'], targetTypes: [], inverseOf: 'observedBy' },
        { name: 'observedBy', uri: 'urn:observedBy', sourceTypes: [], targetTypes: [] },
        { name: 'name', uri: 'urn:name', kind: 'datatype', sourceTypes: ['Device'], targetTypes: ['string'], functional: true },
      ],
    })
    expect(result.inferred.some((fact) => fact.object.value === device)).toBe(true)
    expect(result.inferred.some((fact) => fact.predicate.value === 'urn:observedBy')).toBe(true)
    expect(result.conflicts.some((conflict) => conflict.kind === 'functional_property')).toBe(true)
  })

  it('推断等价类和 range，并跳过 datatype object 的 range', () => {
    const facts: RdfQuad[] = [
      { id: 'type', graph: 'g', subject: iri('urn:x'), predicate: iri('http://www.w3.org/1999/02/22-rdf-syntax-ns#type'), object: iri('urn:A') },
      { id: 'edge', graph: 'g', subject: iri('urn:x'), predicate: iri('urn:link'), object: iri('urn:y') },
      { id: 'literal', graph: 'g', subject: iri('urn:x'), predicate: iri('urn:value'), object: { value: '1', kind: 'literal' } },
    ]
    const result = inferOntologyFacts(facts, {
      name: 'test',
      nodes: [
        { type: 'A', uri: 'urn:A', equivalentTypes: ['urn:B'] },
        { type: 'B', uri: 'urn:B' },
        { type: 'Target', uri: 'urn:Target' },
      ],
      edges: [
        { name: 'link', uri: 'urn:link', sourceTypes: [], targetTypes: ['Target'] },
        { name: 'value', uri: 'urn:value', kind: 'datatype', sourceTypes: [], targetTypes: ['string'] },
      ],
    })
    expect(result.inferred.some((fact) => fact.object.value === 'urn:B')).toBe(true)
    expect(result.inferred.some((fact) => fact.subject.value === 'urn:y' && fact.object.value === 'urn:Target')).toBe(true)
    expect(result.inferred.some((fact) => fact.subject.value === '1')).toBe(false)
  })

  it('检测 disjoint class 冲突', () => {
    const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
    const facts: RdfQuad[] = [
      { id: 'a', graph: 'g', subject: iri('urn:x'), predicate: iri(type), object: iri('urn:A') },
      { id: 'b', graph: 'g', subject: iri('urn:x'), predicate: iri(type), object: iri('urn:B') },
    ]
    const result = inferOntologyFacts(facts, { name: 'test', nodes: [{ type: 'A', uri: 'urn:A', disjointTypes: ['urn:B'] }, { type: 'B', uri: 'urn:B' }], edges: [] })
    expect(result.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'disjoint_class', subject: 'urn:x' })]))
  })
})
