import { describe, expect, it } from 'bun:test'
import { OntologyQueryPlanner, parseSparql } from './ontology-query-plan.js'

describe('OntologyQueryPlanner', () => {
  it('校验 property 并生成 SPARQL', () => {
    const planner = new OntologyQueryPlanner({ name: 'test', nodes: [], edges: [{ name: 'observes', uri: 'urn:observes', sourceTypes: [], targetTypes: [] }] })
    const query = planner.toSparql({
      variables: ['sensor', 'room'],
      patterns: [
        { subject: { variable: 'sensor' }, predicate: { value: 'a' }, object: { value: 'urn:Sensor' } },
        { subject: { variable: 'sensor' }, predicate: { value: 'urn:observes' }, object: { variable: 'room' } },
      ],
      limit: 10,
    })
    expect(query).toContain('SELECT ?sensor ?room')
    expect(query).toContain('<urn:observes>')
    expect(query).toContain('LIMIT 10')
  })

  it('解析生成的 SPARQL 子集', () => {
    const plan = parseSparql('SELECT ?x WHERE { ?x <urn:knows> <urn:y> . FILTER (?x != "urn:z") } LIMIT 2')
    expect(plan.variables).toEqual(['x'])
    expect(plan.patterns[0].predicate).toEqual({ value: 'urn:knows' })
    expect(plan.limit).toBe(2)
    expect(plan.filters?.[0].operator).toBe('!=')
  })

  it('解析 GRAPH、a、多个 pattern 和转义字面量', () => {
    const plan = parseSparql('SELECT ?x ?y WHERE { GRAPH <urn:g> { ?x a <urn:Thing> . ?x <urn:name> "A\\\"B" . } } LIMIT 3')
    expect(plan.graph).toBe('urn:g')
    expect(plan.limit).toBe(3)
    expect(plan.patterns).toHaveLength(2)
    expect(plan.patterns[0].predicate).toEqual({ value: 'a' })
    expect(plan.patterns[1].object).toEqual({ value: 'A\\\"B' })
  })

  it('拒绝不完整或不支持的 SPARQL', () => {
    expect(() => parseSparql('ASK WHERE { ?x <urn:p> <urn:o> . }')).toThrow()
    expect(() => parseSparql('SELECT ?x WHERE { ?x <urn:p> }')).toThrow('不完整')
    expect(() => parseSparql('SELECT ?x WHERE { ?x <urn:p> <urn:o> }')).toThrow('不完整')
    expect(() => parseSparql('SELECT ?x WHERE { FILTER (?x = 1) }')).toThrow()
  })

  it('FILTER 支持数字和布尔值的计划生成', () => {
    const planner = new OntologyQueryPlanner()
    const query = planner.toSparql({
      variables: ['x'],
      patterns: [{ subject: { variable: 'x' }, predicate: { value: 'urn:p' }, object: { value: 'urn:o' } }],
      filters: [{ variable: 'x', operator: '>', value: 3 }, { variable: 'x', operator: '=', value: true }],
    })
    expect(query).toContain('> 3')
    expect(query).toContain('= true')
  })
})
