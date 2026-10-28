import { ApiSpecIngestPipeline, getGraphAdapter } from '../graph/index.js'
import type { ApiSpecIngestOptions, ApiSpecIngestResult } from '../graph/index.js'

export class BaseKnowledgeApiSpecService {
  async ingest(
    knowledgeBaseId: string,
    documentId: string,
    spec: Record<string, any>,
    options: Omit<ApiSpecIngestOptions, 'knowledgeBaseId' | 'tracker' | 'documentId'> = {}
  ): Promise<ApiSpecIngestResult> {
    const adapter = await getGraphAdapter().init().then(() => getGraphAdapter())
    const pipeline = new ApiSpecIngestPipeline(adapter, { tracker: adapter.chunkTracker })
    return pipeline.ingest(spec, { ...options, knowledgeBaseId, documentId, tracker: adapter.chunkTracker })
  }
}

export const baseKnowledgeApiSpecService = new BaseKnowledgeApiSpecService()
