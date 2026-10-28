import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Pool } from 'pg'
import { GraphCompletionRetriever } from './retrieval/graph-completion-retriever.js'
import { CogneeGraph } from './knowledge-graph/cognee-graph.js'
import { DocumentIngestPipeline } from './pipeline/document-pipeline.js'
import { EntityExtractor } from './extraction/entity-extractor.js'
import { PgGraphAdapter } from './pg-adapter/adapter.js'
import { PgRdfQuadStore } from './rdf/pg-quad-store.js'
import { writeExtractionFacts } from './rdf/fact-writer.js'
import { InMemoryRdfQuadStore } from './rdf/quad-store.js'
import { OntologyQueryService } from './query/ontology-query-service.js'
import { PgEntityChunkTracker } from './extraction/entity-chunk-tracker.js'

function node(id: string, kb = 'a', embedding = [1,0]) {
  return {id, knowledgeBaseId:kb,name:id,type:'product',properties:{},embedding,frequency:1,createdAt:new Date(),updatedAt:new Date()}
}
function edge(s: string,t: string,kb='a',relation='uses',props={}) {
  return {sourceId:s,targetId:t,relationshipName:relation,knowledgeBaseId:kb,properties:props,weight:1,createdAt:new Date(),updatedAt:new Date()}
}
function memory(nodes:any[],edges:any[]) {
  return {
    async getGraphData(kb?:string) { return {nodes:nodes.filter(n=>!kb||n.knowledgeBaseId===kb),edges:edges.filter(e=>!kb||e.knowledgeBaseId===kb)} },
    async getNodes(ids:string[]) { return nodes.filter(n=>ids.includes(n.id)) },
    async getEdges(id:string) {return edges.filter(e=>e.sourceId===id||e.targetId===id)},
    async getNeighborhood({seedIds,maxDepth,knowledgeBaseId}:any) {
      const found=new Set(seedIds)
      for(let d=0;d<maxDepth;d++) {
        const current=[...found]
        for(const e of edges) if(current.includes(e.sourceId)||current.includes(e.targetId)) {
          for(const id of [e.sourceId,e.targetId]) if(!knowledgeBaseId||nodes.find(n=>n.id===id)?.knowledgeBaseId===knowledgeBaseId) found.add(id)
        }
      }
      return {nodes:nodes.filter(n=>found.has(n.id)),edges:edges.filter(e=>found.has(e.sourceId)&&found.has(e.targetId))}
    },
  } as any
}

describe('review logic probes (assert required behavior)',()=>{
  it('knowledgeBaseId must isolate relations reached through shared entity types',async()=>{
    const ns=[node('a1'),node('a2'),node('b1','b'),node('b2','b'),node('product','__entity_types__')]
    const es=[edge('a1','a2'),edge('b1','b2','b'),...ns.slice(0,4).map(n=>edge(n.id,'product','__entity_types__','is_a'))]
    const result=await new GraphCompletionRetriever(memory(ns,es)).search([1,0],{knowledgeBaseId:'a',topK:10,neighborDepth:2})
    expect(result.triplets.map(t=>t.source.knowledgeBaseId)).not.toContain('b')
  })
  it('source documents must be cached per edge, not source node',async()=>{
    const a=node('a'),b=node('b'),c=node('c')
    const retriever=new GraphCompletionRetriever(memory([a,b,c],[edge('a','b','a','uses',{sourceDocumentIds:['doc1']}),edge('a','c','a','uses',{sourceDocumentIds:['doc2']})]))
    const result=await (retriever as any).linkSourceDocuments([{source:a,target:b,relation:'uses'},{source:a,target:c,relation:'uses'}])
    expect(result.get(1)).toEqual(['doc2'])
  })
  it('minScore must keep best match and remove opposite vectors without rerank',async()=>{
    const ns=[node('near1'),node('near2'),node('far1','a',[-1,0]),node('far2','a',[-1,0])]
    const es=[edge('near1','near2'),edge('far1','far2')]
    const result=await new GraphCompletionRetriever(memory(ns,es)).search([1,0],{knowledgeBaseId:'a',topK:10,neighborDepth:1,minScore:0.95})
    expect(result.triplets.map(t=>t.source.name)).toEqual(['near1'])
  })
  it('rerank must not turn wholly unrelated embeddings into high confidence',async()=>{
    const ns=[node('far1','a',[-1,0]),node('far2','a',[-1,0]),node('far3','a',[-1,0])]
    const result=await new GraphCompletionRetriever(memory(ns,[edge('far1','far2'),edge('far1','far3')])).search([1,0],{
      knowledgeBaseId:'a',topK:10,neighborDepth:1,minScore:0.95,rerank:{mode:'embedding',embedTexts:async ts=>ts.map(()=>[-1,0])}
    })
    expect(result.triplets).toEqual([])
  })
  it('removing sole relation source must remove edge between surviving shared nodes',async()=>{
    const ns=[node('a'),node('b')],es=[edge('a','b','a','uses',{sourceDocumentIds:['doc1'],mergedFromChunks:['doc1#0']})]
    const graph=Object.assign(memory(ns,es),{
      getNodeIdsByDocument:async()=>['a','b'],getDocumentsByNodeIds:async()=>new Map([['a',['doc1','doc2']],['b',['doc1','doc2']]]),
      deleteNodes:async(ids:string[])=>{for(let i=es.length-1;i>=0;i--)if(ids.includes(es[i].sourceId)||ids.includes(es[i].targetId))es.splice(i,1)},
      deleteEdge:async(s:string,t:string,rel:string)=>{for(let i=es.length-1;i>=0;i--)if(es[i].sourceId===s&&es[i].targetId===t&&es[i].relationshipName===rel)es.splice(i,1)},
      deleteDocumentLinks:async()=>{},deleteDocumentChunks:async()=>{},chunkTracker:{removeEntityChunksByDocument:async()=>[],removeRelationChunksByDocument:async()=>[{sourceId:'a',targetId:'b',relationName:'uses'}]},
    })
    await new DocumentIngestPipeline(graph).removeDocument('doc1')
    expect((await graph.getGraphData('a')).edges).toEqual([])
  })
  it('checkpoint from previous content must not replace new extraction',async()=>{
    const extract=spyOn(EntityExtractor.prototype,'extract').mockResolvedValue({entities:[{name:'New',type:'product',description:''}],triplets:[]})
    const written:any[]=[]
    const graph:any={
      storeDocumentChunks:async()=>{},loadDocumentChunkExtractions:async()=>[{chunkIndex:0,extraction:{entities:[{name:'Old',type:'product',description:''}],triplets:[]}}],
      saveDocumentChunkExtraction:async()=>{},deleteDocumentChunkExtractions:async()=>{},addNodes:async(xs:any[])=>{written.push(...xs);return xs.map(x=>x.id)},addEdges:async()=>{},linkNodesToDocument:async()=>{},
    }
    try {
      await new DocumentIngestPipeline(graph).ingest('New changed document.',{knowledgeBaseId:'a',documentId:'same',type:'text',chunkCheckpoint:true,embedFn:async xs=>xs.map(()=>[1,0]),extractTimeoutMs:5})
      expect(written.filter(n=>n.knowledgeBaseId==='a').map(n=>n.name)).toEqual(['New'])
    }finally {extract.mockRestore()}
  })
})

describe.skipIf(!process.env.GRAPH_REVIEW_PG)('review isolated PostgreSQL probes',()=>{
 let pool:Pool,store:PgRdfQuadStore
 beforeAll(async()=>{
  pool=new Pool({host:readFileSync('/tmp/xybot-graph-review-pg-path','utf8'),port:55479,database:'postgres',user:process.env.USER})
  await pool.query('DROP SCHEMA IF EXISTS review CASCADE');store=new PgRdfQuadStore(pool,'review');await store.init()
 })
 afterAll(async()=>{await pool.end()})
 it('same document ID in different knowledge bases must not share chunks and deletion',async()=>{
  const adapter=new PgGraphAdapter(pool,'review');await adapter.init()
  const ids=['00000000-0000-4000-8000-000000000011','00000000-0000-4000-8000-000000000012']
  for(let i=0;i<2;i++) {
   await pool.query('INSERT INTO review.graph_nodes(id,knowledge_base_id,name,type) VALUES ($1,$2,$3,$4)',[ids[i],i?'kbB':'kbA',i?'B':'A','product'])
   await adapter.linkNodesToDocument({documentId:'same-doc',nodeIds:[ids[i]],chunkIndex:0})
   await adapter.storeDocumentChunks([{documentId:'same-doc',chunkIndex:0,content:i?'KB B text':'KB A text'}])
  }
  expect((await adapter.getDocumentChunks(['same-doc#0']))[0].content).toBe('KB A text')
 })
 it('removeDocument must not delete matching IDs from two knowledge bases',async()=>{
  const adapter=new PgGraphAdapter(pool,'review')
  await new DocumentIngestPipeline(adapter).removeDocument('same-doc')
  expect(await adapter.getNode('00000000-0000-4000-8000-000000000012')).not.toBeNull()
 })

 it('same node in two chunks of one document must not be treated as shared across documents',async()=>{
  const adapter=new PgGraphAdapter(pool,'review')
  const id='00000000-0000-4000-8000-000000000013'
  await pool.query('INSERT INTO review.graph_nodes(id,knowledge_base_id,name,type) VALUES ($1,$2,$3,$4)',[id,'kbA','Multi','product'])
  await adapter.linkNodesToDocument({documentId:'multi',nodeIds:[id],chunkIndex:0})
  await adapter.linkNodesToDocument({documentId:'multi',nodeIds:[id],chunkIndex:1})
  await new DocumentIngestPipeline(adapter).removeDocument('multi')
  expect(await adapter.getNode(id)).toBeNull()
 })
 it('edge upsert must retain all supporting document and chunk references',async()=>{
  const adapter=new PgGraphAdapter(pool,'review')
  const ids=['00000000-0000-4000-8000-000000000014','00000000-0000-4000-8000-000000000015']
  for(let i=0;i<2;i++)await pool.query('INSERT INTO review.graph_nodes(id,knowledge_base_id,name,type) VALUES ($1,$2,$3,$4)',[ids[i],'kbA','Edge'+i,'product'])
  for(const d of ['edgeDoc1','edgeDoc2'])await adapter.addEdges([{sourceId:ids[0],targetId:ids[1],relationshipName:'uses',knowledgeBaseId:'kbA',properties:{sourceDocumentIds:[d],mergedFromChunks:[d+'#0']}}])
  expect((await adapter.getEdges(ids[0]))[0].properties.sourceDocumentIds).toEqual(['edgeDoc1','edgeDoc2'])
 })
 it('RDF shared fact must survive deleting its first source',async()=>{
  const extraction={entities:[{name:'A',type:'product'}],triplets:[]}
  await writeExtractionFacts(store,[{extraction,chunkId:'doc1#0',chunkIndex:0}],{knowledgeBaseId:'shared',runId:'r1'})
  await writeExtractionFacts(store,[{extraction,chunkId:'doc2#0',chunkIndex:0}],{knowledgeBaseId:'shared',runId:'r2'})
  await store.deleteBySourceChunkPrefix('doc1#')
  expect((await store.match({graph:'urn:graph:knowledge:shared'})).length).toBeGreaterThan(0)
 })
 it('tracker deleting doc1 must preserve doc10 and doc1_extra',async()=>{
  const tracker=new PgEntityChunkTracker(pool,'review');await tracker.initTables()
  const id='00000000-0000-4000-8000-000000000001'
  for(const chunk of ['doc1#0','doc10#0','doc1_extra#0'])await tracker.addEntityChunk(id,chunk,'kb')
  await tracker.removeEntityChunksByDocument('doc1')
  expect(await tracker.getEntityChunks(id)).toEqual(['doc10#0','doc1_extra#0'])
 })
 it('native numeric filters must match portable query results',async()=>{
  const memoryStore=new InMemoryRdfQuadStore()
  const extraction={entities:[{name:'counted',type:'product',attributes:[{name:'count',value:10,datatype:'http://www.w3.org/2001/XMLSchema#integer'}]}],triplets:[]}
  const chunks=[{extraction,chunkId:'numeric#0',chunkIndex:0}]
  const opts={knowledgeBaseId:'numeric',runId:'nr'}
  await writeExtractionFacts(store,chunks,opts);await writeExtractionFacts(memoryStore,chunks,opts)
  const plan:any={variables:['value'],graph:'urn:graph:knowledge:numeric',patterns:[{subject:{variable:'s'},predicate:{value:'urn:property:count'},object:{variable:'value'}}],filters:[{variable:'value',operator:'>',value:2}]}
  const portable=await new OntologyQueryService(memoryStore).query(plan)
  const native=await new OntologyQueryService(store).query(plan)
  expect(native.bindings.map(b=>b.values.value.value)).toEqual(portable.bindings.map(b=>b.values.value.value))
 })
})
