import { describe, expect, it } from 'bun:test'
import { InMemoryRdfQuadStore } from './quad-store.js'
import { writeExtractionFacts } from './fact-writer.js'

describe('writeExtractionFacts', () => {
  it('写入知识 named graph 及 statement provenance', async () => {
    const store = new InMemoryRdfQuadStore()
    await writeExtractionFacts(store, [{
      chunkId: 'doc#0', chunkIndex: 0, extraction: {
        entities: [{ name: 'SensorA', type: 'Sensor', attributes: [{ name: 'label', value: 'A' }] }, { name: 'Room1', type: 'Room' }],
        triplets: [{ source: 'SensorA', relation: 'observes', target: 'Room1', confidence: 1 }],
      },
    }], {
      knowledgeBaseId: 'kb', runId: 'run-1', ontology: {
        name: 'test', nodes: [{ type: 'Sensor', uri: 'urn:Sensor' }, { type: 'Room', uri: 'urn:Room' }],
        edges: [{ name: 'label', kind: 'datatype', uri: 'urn:label', sourceTypes: ['Sensor'], targetTypes: ['string'] }, { name: 'observes', uri: 'urn:observes', sourceTypes: ['Sensor'], targetTypes: ['Room'] }],
      },
    })
    const facts = await store.match({ graph: 'urn:graph:knowledge:kb' })
    const provenance = await store.match({ graph: 'urn:graph:provenance:run-1' })
    expect(facts.length).toBe(6)
    expect(provenance.length).toBe(12)
    expect(provenance.every((quad) => quad.subject.kind === 'iri')).toBe(true)
  })
})
