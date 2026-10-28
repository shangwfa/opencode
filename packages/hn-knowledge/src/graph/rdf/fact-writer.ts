import { createHash } from 'node:crypto'
import type { OntologyConfig } from '../ontology/index.js'
import type { ChunkExtraction } from '../extraction/merge-pipeline.js'
import type { RdfQuad, RdfQuadStore, RdfTerm } from './quad-store.js'
import { quadId } from './quad-store.js'

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type'
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label'
const PROV_DERIVED = 'http://www.w3.org/ns/prov#wasDerivedFrom'
const PROV_GENERATED = 'http://www.w3.org/ns/prov#wasGeneratedBy'

export async function writeExtractionFacts(
  store: RdfQuadStore,
  chunks: ChunkExtraction[],
  options: { knowledgeBaseId: string; ontology?: OntologyConfig; ontologyVersion?: string; runId: string }
): Promise<RdfQuad[]> {
  const classes = new Map((options.ontology?.nodes || []).map((node) => [node.type, node.uri || `urn:class:${node.type}`]))
  const properties = new Map((options.ontology?.edges || []).map((edge) => [edge.name, edge.uri || `urn:property:${edge.name}`]))
  // 本体快照是 facts 的数据边界，禁止不同版本在同一 named graph 内混查。
  const knowledgeGraph = ontologyGraph('knowledge', options.knowledgeBaseId, options.ontologyVersion)
  const provenanceGraph = `urn:graph:provenance:${options.runId}`
  const quads: RdfQuad[] = []

  for (const chunk of chunks) {
    const chunkUri = `urn:chunk:${hash(chunk.chunkId)}`
    for (const entity of chunk.extraction.entities) {
      const subject = iri(entityUri(options.knowledgeBaseId, entity.name))
      const typeUri = classes.get(entity.type) || `urn:class:${entity.type}`
      add(quads, subject, RDF_TYPE, iri(typeUri), knowledgeGraph, options, chunk)
      add(quads, subject, RDFS_LABEL, literal(entity.name), knowledgeGraph, options, chunk)
      for (const attribute of entity.attributes || []) {
        add(quads, subject, properties.get(attribute.name) || `urn:property:${attribute.name}`, literal(String(attribute.value), attribute.datatype), knowledgeGraph, options, chunk)
      }
    }
    for (const triplet of chunk.extraction.triplets) {
      const subject = iri(entityUri(options.knowledgeBaseId, triplet.source))
      const object = iri(entityUri(options.knowledgeBaseId, triplet.target))
      add(quads, subject, properties.get(triplet.relation) || `urn:property:${triplet.relation}`, object, knowledgeGraph, options, chunk)
    }
    // provenance 以 statement ID 为主体，避免把来源信息覆盖到事实本身。
    for (const fact of quads.filter((quad) => quad.sourceChunkId === chunk.chunkId && quad.graph === knowledgeGraph)) {
      addRaw(quads, iri(fact.id), PROV_DERIVED, iri(chunkUri), provenanceGraph, options.runId, chunk.chunkId)
      addRaw(quads, iri(fact.id), PROV_GENERATED, iri(`urn:extraction:${options.runId}`), provenanceGraph, options.runId, chunk.chunkId)
    }
  }
  await store.add(quads)
  return quads.filter((quad) => quad.graph === knowledgeGraph)
}

function add(quads: RdfQuad[], subject: RdfTerm, predicate: string, object: RdfTerm, graph: string, options: { runId: string }, chunk: ChunkExtraction) {
  addRaw(quads, subject, predicate, object, graph, options.runId, chunk.chunkId)
}

function addRaw(quads: RdfQuad[], subject: RdfTerm, predicate: string, object: RdfTerm, graph: string, runId?: string, chunkId?: string) {
  const base = { subject, predicate: iri(predicate), object, graph, sourceRunId: runId, sourceChunkId: chunkId }
  quads.push({ ...base, id: quadId(base) })
}

function entityUri(knowledgeBaseId: string, name: string): string {
  return `urn:entity:${hash(`${knowledgeBaseId}:${name.toLocaleLowerCase().trim()}`)}`
}

export function ontologyGraph(kind: 'knowledge' | 'inferred', knowledgeBaseId: string, ontologyVersion?: string): string {
  return `urn:graph:${kind}:${knowledgeBaseId}${ontologyVersion ? `:${encodeURIComponent(ontologyVersion)}` : ''}`
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

function iri(value: string): RdfTerm { return { value, kind: 'iri' } }
function literal(value: string, datatype?: string): RdfTerm { return { value, kind: 'literal', datatype } }
