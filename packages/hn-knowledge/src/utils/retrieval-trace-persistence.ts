import type { RuntimeContext } from "./runtime-context.js";
import { getGraphAdapter } from "../graph/pg-adapter/index.js";
import { persistRetrievalTrace } from "../graph/retrieval/trace-persister.js";
import { appendRetrievalTraceId } from "./rag-trace-logger.js";
import type { RetrievalEvidence } from "../graph/retrieval/evidence.js";

const graphInitPromises = new Map<string, Promise<void>>();

async function ensureGraphInitialized(schema: string): Promise<void> {
  let promise = graphInitPromises.get(schema);
  if (!promise) {
    const graph = getGraphAdapter(schema) as any;
    promise = Promise.resolve(graph.init?.());
    graphInitPromises.set(schema, promise);
  }
  await promise;
}

/**
 * 将应用层 Document RAG 的检索阶段写入统一 retrieval trace。
 * 持久化失败只影响审计，不影响检索结果返回。
 */
export async function persistDocumentRetrievalTrace(input: {
  query: string;
  knowledgeBaseId: string;
  stages: unknown;
  runtimeContext?: RuntimeContext;
}): Promise<string | undefined> {
  try {
    const schema = process.env.DATABASE_SCHEMA?.replace(/[\'"]/g, "") || "test";
    await ensureGraphInitialized(schema);
    const graph = getGraphAdapter(schema);
    const stageData = input.stages as { results?: Array<Record<string, unknown>> };
    const evidence = (stageData?.results || []).flatMap((result, index): RetrievalEvidence[] => {
      const evidenceId = typeof result.evidenceId === "string" ? result.evidenceId : undefined;
      const content = typeof result.content === "string" ? result.content : "";
      if (!evidenceId || !content) return [];
      return [{
        evidenceId,
        sourceType: "document",
        content,
        contentHash: typeof result.contentHash === "string" ? result.contentHash : "",
        documentId: typeof result.documentId === "string" ? result.documentId : undefined,
        chunkIndex: typeof result.chunkIndex === "number" ? result.chunkIndex : undefined,
        retrieval: {
          rank: typeof result.rank === "number" ? result.rank : index + 1,
          score: typeof result.score === "number" ? result.score : 0,
          method: "document-hybrid",
        },
      }];
    });
    const traceId = await persistRetrievalTrace(graph, {
      queryText: input.query,
      knowledgeBaseId: input.knowledgeBaseId,
      source: "document",
      stages: input.stages,
      evidence,
    });
    appendRetrievalTraceId(input.runtimeContext, traceId);
    return traceId;
  } catch {
    return undefined;
  }
}
