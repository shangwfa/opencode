import { describe, expect, it } from 'bun:test'
import { parseTurtleOntology } from './turtle.js'

describe('parseTurtleOntology', () => {
  it('解析 class、object/datatype property 及约束', () => {
    const ontology = parseTurtleOntology(`
      @prefix ex: <https://example.test/> .
      @prefix owl: <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      ex:Sensor a owl:Class ; rdfs:label "Sensor" ; rdfs:comment "A device" .
      ex:Observation a owl:Class ; rdfs:subClassOf ex:Sensor .
      ex:observes a owl:ObjectProperty ; rdfs:domain ex:Sensor ; rdfs:range ex:Observation ; rdfs:label "observes" .
      ex:name a owl:DatatypeProperty ; rdfs:domain ex:Sensor ; rdfs:range <http://www.w3.org/2001/XMLSchema#string> .
    `, 'ssn')

    expect(ontology.name).toBe('ssn')
    expect(ontology.nodes.find((node) => node.type === 'Sensor')?.description).toBe('A device')
    expect(ontology.nodes.find((node) => node.type === 'Observation')?.parentTypes).toEqual(['Sensor'])
    expect(ontology.edges.find((edge) => edge.name === 'observes')).toMatchObject({
      kind: 'object',
      sourceTypes: ['Sensor'],
      targetTypes: ['Observation'],
    })
    expect(ontology.edges.find((edge) => edge.name === 'name')).toMatchObject({
      kind: 'datatype',
      datatype: 'http://www.w3.org/2001/XMLSchema#string',
    })
  })

  it('解析等价类、互斥类、反向属性、functional 和注释', () => {
    const ontology = parseTurtleOntology(`
      # comment outside IRI
      PREFIX ex: <https://example.test/>
      PREFIX owl: <http://www.w3.org/2002/07/owl#>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      ex:User a owl:Class ; rdfs:label "User" ; owl:equivalentClass ex:Person ; owl:disjointWith ex:Bot .
      ex:Person a owl:Class .
      ex:Bot a owl:Class .
      ex:knows a owl:ObjectProperty ; owl:inverseOf ex:knownBy ; rdfs:domain ex:User ; rdfs:range ex:Person .
      ex:knownBy a owl:ObjectProperty ; rdfs:label "known by" .
      ex:id a owl:DatatypeProperty ; a owl:FunctionalProperty ; rdfs:range <http://www.w3.org/2001/XMLSchema#string> .
    `)
    expect(ontology.nodes.find((node) => node.type === 'User')).toMatchObject({ equivalentTypes: ['Person'], disjointTypes: ['Bot'] })
    expect(ontology.edges.find((edge) => edge.name === 'knows')).toMatchObject({ inverseOf: 'known by', sourceTypes: ['User'], targetTypes: ['Person'] })
    expect(ontology.edges.find((edge) => edge.name === 'id')?.functional).toBe(true)
  })
})
