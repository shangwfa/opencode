import { createTool } from "../utils/create-tool.js";
import type { RuntimeContext } from "../utils/runtime-context.js";
import { z } from "zod";
import {
  hybridSearchService,
  knowledgeBaseService,
} from "../rag/knowledge-base/index.js";
import { reciprocalRankFusion } from "../utils/rrf-fusion.js";
import type { SearchResultItem } from "../rag/knowledge-base/index.js";
import type {
  HybridSearchDebugEvent,
  HybridSearchOptions,
} from "../rag/knowledge-base/index.js";
import { extractAllMedia } from "../utils/media-extractor.js";
import { getOrCreateTraceId, logRagTrace } from "../utils/rag-trace-logger.js";

const DEFAULT_KB_NAME = "测试知识库 - rpa_zh-CN";

const kbIdCache = new Map<string, { id: string; timestamp: number }>();
const KB_ID_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/** 判断是否为知识库 ID（如 kb_xxx），否则视为名称 */
function isKnowledgeBaseId(value: string): boolean {
  return /^kb_[\w-]+$/i.test(value.trim());
}

/**
 * 根据名称查找知识库 ID（带缓存）
 */
async function getKnowledgeBaseIdByName(kbName: string): Promise<string> {
  const now = Date.now();
  const cached = kbIdCache.get(kbName);
  if (cached && now - cached.timestamp < KB_ID_CACHE_TTL) {
    return cached.id;
  }
  const result = await knowledgeBaseService.listKnowledgeBases({
    pageSize: 100,
  });
  const kb = result.items.find((k) => k.name === kbName);
  if (!kb) {
    throw new Error(`知识库 "${kbName}" 不存在，请先运行初始化脚本创建知识库`);
  }
  kbIdCache.set(kbName, { id: kb.id, timestamp: now });
  return kb.id;
}

/**
 * 解析知识库 ID 或名称列表为 ID 列表，并返回 ID -> 名称映射（用于结果中 knowledgeBaseName）
 */
async function resolveKnowledgeBaseIds(
  namesOrIds: string[],
): Promise<{ ids: string[]; nameById: Map<string, string>; errors: string[] }> {
  const ids: string[] = [];
  const nameById = new Map<string, string>();
  const errors: string[] = [];

  const list = await knowledgeBaseService.listKnowledgeBases({ pageSize: 100 });
  const nameToId = new Map(list.items.map((k) => [k.name, k.id]));
  const idToName = new Map(list.items.map((k) => [k.id, k.name]));

  for (const item of namesOrIds) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    try {
      if (isKnowledgeBaseId(trimmed)) {
        const name = idToName.get(trimmed);
        if (name) nameById.set(trimmed, name);
        ids.push(trimmed);
      } else {
        const cached = kbIdCache.get(trimmed);
        const now = Date.now();
        if (cached && now - cached.timestamp < KB_ID_CACHE_TTL) {
          ids.push(cached.id);
          nameById.set(cached.id, trimmed);
          continue;
        }
        const id = nameToId.get(trimmed);
        if (id) {
          kbIdCache.set(trimmed, { id, timestamp: now });
          ids.push(id);
          nameById.set(id, trimmed);
        } else {
          const kb = list.items.find((k) => k.name === trimmed);
          if (kb) {
            kbIdCache.set(trimmed, { id: kb.id, timestamp: now });
            ids.push(kb.id);
            nameById.set(kb.id, trimmed);
          } else {
            errors.push(`知识库 "${trimmed}" 不存在`);
          }
        }
      }
    } catch (e: any) {
      errors.push(`${trimmed}: ${e.message}`);
    }
  }

  return { ids, nameById, errors };
}

interface QueryAnalysis {
  isExactQuery: boolean;
  isConceptualQuery: boolean;
  isComplexQuery: boolean;
  queryType: "exact" | "conceptual" | "complex" | "default";
}

function analyzeQuery(query: string): QueryAnalysis {
  const lowerQuery = query.toLowerCase();
  const exactPatterns = [
    /错误代码|error code|err:/i,
    /"[^"]+"/,
    /'[^']+'/,
    /\b[A-Z]{2,}\b/,
    /\b\d{4,}\b/,
  ];
  const isExactQuery = exactPatterns.some((p) => p.test(lowerQuery));
  const conceptualPatterns = [
    /如何|怎么|怎样|方法/i,
    /最佳实践|优化|原理|机制/i,
    /是什么|为什么|怎么样/i,
    /如何做|怎么做|怎样做/i,
  ];
  const isConceptualQuery =
    !isExactQuery && conceptualPatterns.some((p) => p.test(lowerQuery));
  const wordCount = lowerQuery
    .split(/[\s,，。]+/)
    .filter((w) => w.length > 0).length;
  const isComplexQuery = wordCount > 5 && !isExactQuery;

  let queryType: QueryAnalysis["queryType"] = "default";
  if (isExactQuery) queryType = "exact";
  else if (isConceptualQuery) queryType = "conceptual";
  else if (isComplexQuery) queryType = "complex";

  return { isExactQuery, isConceptualQuery, isComplexQuery, queryType };
}

function optimizeSearchConfig(query: string, topK: number) {
  const analysis = analyzeQuery(query);
  let semanticWeight = 0.7;
  let keywordWeight = 0.3;
  let enableHyDE = false;
  let enableRerank = false;

  switch (analysis.queryType) {
    case "exact":
      semanticWeight = 0.3;
      keywordWeight = 0.7;
      break;
    case "conceptual":
    case "complex":
    case "default":
    default:
      break;
  }

  return {
    semanticWeight,
    keywordWeight,
    topK,
    fusionMethod: "rrf" as const,
    rrfK: 60,
    rerankConfig: enableRerank
      ? {
          enableRerank: true,
          rerankTopK: Math.max(20, topK * 2),
          rerankModel: "simple" as const,
        }
      : undefined,
    hydeConfig: enableHyDE
      ? { enableHyDE: true, llmModel: "gpt-4o-mini" }
      : undefined,
  };
}

const SEARCH_TIMEOUT_MS = 20000;
const MAX_METADATA_QUERIES = 5;
const METADATA_QUERY_TIMEOUT_MS = 2000;
const MAX_SERIALIZED_BYTES = 1000000;
const MAX_RETRIEVAL_DEBUG_RESULTS_PER_STAGE = 50;

type RetrievalDebugResult = {
  rank: number;
  score: number;
  documentId: string;
  chunkIndex?: number;
  docName?: string;
  docPath?: string;
  docUrl?: string;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  textPreview?: string;
};

type RetrievalDebugStage = {
  stage: string;
  query: string;
  topK: number;
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  error?: string;
  resultCount: number;
  results: RetrievalDebugResult[];
};

type FormattedResultMetadata = {
  knowledgeBaseId: string;
  knowledgeBaseName?: string;
  docName?: string;
  docPath?: string;
  parentPath?: string;
  docUrl?: string;
  brandCode?: string;
  languageCode?: string;
  syncedAt?: string;
};

/**
 * 单次检索（带超时），失败返回 []，不抛错
 */
async function searchWithTimeout(
  kbId: string,
  query: string,
  config: ReturnType<typeof optimizeSearchConfig> &
    Pick<HybridSearchOptions, "debugCollector"> & {
      onFailure?: (error: Error) => void;
    },
): Promise<SearchResultItem[]> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<SearchResultItem[]>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error("搜索超时（20秒）")),
      SEARCH_TIMEOUT_MS,
    );
  });
  try {
    const results = await Promise.race([
      hybridSearchService.search(kbId, query, config),
      timeoutPromise,
    ]);
    if (timeoutId) clearTimeout(timeoutId);
    return results;
  } catch (e) {
    if (timeoutId) clearTimeout(timeoutId);
    const error = e instanceof Error ? e : new Error(String(e));
    console.warn(
      `[MultiKbDocumentSearchTool] 知识库 ${kbId} 搜索失败:`,
      error.message,
    );
    config.onFailure?.(error);
    return [];
  }
}

function toDebugResult(
  result: SearchResultItem,
  rank: number,
  fallbackKnowledgeBaseId?: string,
  fallbackKnowledgeBaseName?: string,
): RetrievalDebugResult {
  const metadata = result.metadata || {};
  const text = result.text || metadata.text || "";
  return {
    rank,
    score: result.score,
    documentId: result.documentId,
    ...(result.chunkIndex !== undefined && { chunkIndex: result.chunkIndex }),
    ...(metadata.docName && { docName: String(metadata.docName) }),
    ...(metadata.docPath && { docPath: String(metadata.docPath) }),
    ...(metadata.docUrl && { docUrl: String(metadata.docUrl) }),
    knowledgeBaseId:
      (metadata.knowledgeBaseId as string | undefined) ||
      fallbackKnowledgeBaseId,
    knowledgeBaseName:
      (metadata.knowledgeBaseName as string | undefined) ||
      fallbackKnowledgeBaseName,
    ...(text && { textPreview: String(text).slice(0, 300) }),
  };
}

function pushRetrievalDebugStage(
  stages: RetrievalDebugStage[],
  stage: Omit<RetrievalDebugStage, "resultCount" | "results"> & {
    results: SearchResultItem[];
  },
): void {
  stages.push({
    stage: stage.stage,
    query: stage.query,
    topK: stage.topK,
    ...(stage.knowledgeBaseId && { knowledgeBaseId: stage.knowledgeBaseId }),
    ...(stage.knowledgeBaseName && {
      knowledgeBaseName: stage.knowledgeBaseName,
    }),
    ...(stage.error && { error: stage.error }),
    resultCount: stage.results.length,
    results: stage.results
      .slice(0, MAX_RETRIEVAL_DEBUG_RESULTS_PER_STAGE)
      .map((result, index) =>
        toDebugResult(
          result,
          index + 1,
          stage.knowledgeBaseId,
          stage.knowledgeBaseName,
        ),
      ),
  });
}

function pushRetrievalDebugFailureStage(
  stages: RetrievalDebugStage[],
  options: {
    query: string;
    topK: number;
    knowledgeBaseId: string;
    knowledgeBaseName?: string;
    error: Error;
  },
): void {
  stages.push({
    stage: "kb_search_failed",
    query: options.query,
    topK: options.topK,
    knowledgeBaseId: options.knowledgeBaseId,
    ...(options.knowledgeBaseName && {
      knowledgeBaseName: options.knowledgeBaseName,
    }),
    error: options.error.message,
    resultCount: 0,
    results: [],
  });
}

function createRetrievalDebugCollector(
  stages: RetrievalDebugStage[],
  knowledgeBaseId: string,
  knowledgeBaseName: string | undefined,
): (event: HybridSearchDebugEvent) => void {
  return (event) => {
    pushRetrievalDebugStage(stages, {
      stage: event.stage,
      query: event.query,
      topK: event.topK,
      knowledgeBaseId,
      ...(knowledgeBaseName && { knowledgeBaseName }),
      results: event.results,
    });
  };
}

function toRetrievalTraceStep(stage: string): string {
  return `retrieval_${stage}`;
}

function logRetrievalDebugStages(options: {
  traceId: string;
  runtimeContext?: RuntimeContext;
  stages: RetrievalDebugStage[];
  metadata?: Record<string, unknown>;
}): void {
  for (const stage of options.stages) {
    logRagTrace({
      traceId: options.traceId,
      step: toRetrievalTraceStep(stage.stage),
      input: {
        query: stage.query,
        topK: stage.topK,
        knowledgeBaseId: stage.knowledgeBaseId,
        knowledgeBaseName: stage.knowledgeBaseName,
      },
      output: {
        resultCount: stage.resultCount,
        error: stage.error,
        results: stage.results,
      },
      runtimeContext: options.runtimeContext,
      metadata: options.metadata,
    });
  }
}

/**
 * 格式化单条结果为工具输出格式，并附加 knowledgeBaseId / knowledgeBaseName
 */
function formatResult(
  result: SearchResultItem,
  documentMetadataMap: Map<string, Record<string, any>>,
  knowledgeBaseId: string,
  knowledgeBaseName: string | undefined,
): {
  text: string;
  score: number;
  documentId: string;
  chunkIndex?: number;
  metadata: FormattedResultMetadata;
  media: { images: string[]; videos: string[] };
} {
  const text = result.text || result.metadata?.text || "";
  const finalText = text || (result.metadata?.content as string) || "";
  const syncedAt = result.metadata?.syncedAt;
  const syncedAtStr =
    syncedAt instanceof Date
      ? syncedAt.toISOString()
      : typeof syncedAt === "string"
        ? syncedAt
        : undefined;

  const sourceMetadata =
    result.metadata && Object.keys(result.metadata).length > 0
      ? result.metadata
      : documentMetadataMap.get(result.documentId) || {};
  const combinedMetadata = { ...result.metadata, ...sourceMetadata };
  const media = extractAllMedia(finalText, combinedMetadata);

  const formattedMetadata: FormattedResultMetadata = {
    knowledgeBaseId,
    ...(knowledgeBaseName !== undefined && { knowledgeBaseName }),
  };
  if (sourceMetadata?.docName)
    formattedMetadata.docName = sourceMetadata.docName;
  if (sourceMetadata?.docPath)
    formattedMetadata.docPath = sourceMetadata.docPath;
  if (sourceMetadata?.parentPath)
    formattedMetadata.parentPath = sourceMetadata.parentPath;
  if (sourceMetadata?.brandCode)
    formattedMetadata.brandCode = sourceMetadata.brandCode;
  if (sourceMetadata?.languageCode)
    formattedMetadata.languageCode = sourceMetadata.languageCode;
  if (sourceMetadata?.docUrl) {
    formattedMetadata.docUrl = sourceMetadata.docUrl;
  } else if (
    sourceMetadata?.brandCode &&
    sourceMetadata?.languageCode &&
    result.documentId
  ) {
    formattedMetadata.docUrl = `https://www.yingdao.com/yddoc/${sourceMetadata.brandCode}/${sourceMetadata.languageCode}/${result.documentId}`;
  }
  if (sourceMetadata?.syncedAt) {
    const s = sourceMetadata.syncedAt;
    formattedMetadata.syncedAt =
      s instanceof Date
        ? s.toISOString()
        : typeof s === "string"
          ? s
          : syncedAtStr;
  } else if (syncedAtStr) {
    formattedMetadata.syncedAt = syncedAtStr;
  }

  return {
    text: finalText || "",
    score: result.score ?? 0,
    documentId: result.documentId || "",
    chunkIndex: result.chunkIndex ?? undefined,
    metadata: formattedMetadata,
    media: { images: media.images || [], videos: media.videos || [] },
  };
}

/**
 * 收集需要补全 metadata 的 documentId，并批量查询
 */
async function fetchDocumentMetadata(
  results: SearchResultItem[],
): Promise<Map<string, Record<string, any>>> {
  const documentIdsToQuery = new Set<string>();
  let count = 0;
  for (const result of results) {
    if (!result.metadata?.docUrl || !result.metadata?.docName) {
      if (result.documentId && !documentIdsToQuery.has(result.documentId)) {
        documentIdsToQuery.add(result.documentId);
        count++;
        if (count >= MAX_METADATA_QUERIES) break;
      }
    }
  }
  const documentMetadataMap = new Map<string, Record<string, any>>();
  if (documentIdsToQuery.size === 0) return documentMetadataMap;

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new Error("metadata 查询超时")),
      METADATA_QUERY_TIMEOUT_MS,
    ),
  );
  const documentPromises = Array.from(documentIdsToQuery).map(async (docId) => {
    try {
      const doc = await knowledgeBaseService.getDocument(docId);
      return { docId, metadata: doc?.metadata || {} };
    } catch {
      return { docId, metadata: {} };
    }
  });

  try {
    const documentResults = (await Promise.race([
      Promise.all(documentPromises),
      timeoutPromise,
    ])) as Array<{
      docId: string;
      metadata: Record<string, any>;
    }>;
    documentResults.forEach(({ docId, metadata }) => {
      if (metadata && Object.keys(metadata).length > 0) {
        documentMetadataMap.set(docId, metadata);
      }
    });
  } catch (e: any) {
    if (e.message?.includes("超时")) {
      console.warn(
        `[MultiKbDocumentSearchTool] metadata 查询超时（${documentIdsToQuery.size} 个文档）`,
      );
    }
  }
  return documentMetadataMap;
}

/**
 * 创建支持多知识库的文档搜索工具
 * @param defaultKbIds 默认搜索的知识库 ID 或名称（单个或数组）；不传则使用默认知识库名称
 */
export function createMultiKbDocumentSearchTool(
  defaultKbIds?: string | string[],
) {
  const defaultList: string[] =
    defaultKbIds === undefined
      ? [DEFAULT_KB_NAME]
      : Array.isArray(defaultKbIds)
        ? defaultKbIds.length > 0
          ? defaultKbIds
          : [DEFAULT_KB_NAME]
        : [defaultKbIds];

  return createTool({
    id: "multi-kb-document-search",
    description:
      "在多个影刀文档知识库中并行搜索相关信息。可指定知识库 ID 或名称列表；不指定时使用工具默认列表。使用此工具查找与用户问题相关的文档内容。搜索结果包含文本内容、文档元数据、来源知识库及媒体资源（图片和视频）。",
    inputSchema: z.object({
      query: z
        .string()
        .describe("搜索查询字符串，应该是用户问题的关键词或完整问题"),
      topK: z
        .number()
        .int()
        .positive()
        .optional()
        .default(10)
        .describe("返回的结果数量，默认 10"),
      knowledgeBaseIds: z
        .array(z.string())
        .optional()
        .describe("本次搜索的知识库 ID 列表；若提供则覆盖工具默认列表"),
      knowledgeBaseNames: z
        .array(z.string())
        .optional()
        .describe(
          "本次搜索的知识库名称列表；若提供则覆盖工具默认列表，内部会解析为 ID",
        ),
    }),
    outputSchema: z.object({
      results: z
        .array(
          z.object({
            text: z.string().describe("搜索结果文本内容"),
            score: z.number().describe("相关性分数 (0-1)"),
            documentId: z.string().describe("文档 ID"),
            chunkIndex: z.number().optional().describe("块索引"),
            metadata: z
              .object({
                knowledgeBaseId: z.string().describe("来源知识库 ID"),
                knowledgeBaseName: z
                  .string()
                  .optional()
                  .describe("来源知识库名称"),
                docName: z
                  .string()
                  .optional()
                  .describe("文档名称；展示来源链接时可作为链接文本"),
                docPath: z
                  .string()
                  .optional()
                  .describe(
                    "文档完整路径；当 docUrl 不存在时，可作为文档来源展示",
                  ),
                parentPath: z.string().optional().describe("父级路径"),
                docUrl: z
                  .string()
                  .optional()
                  .describe("文档完整 URL；展示来源链接时优先使用该字段"),
                brandCode: z.string().optional().describe("品牌代码"),
                languageCode: z.string().optional().describe("语言代码"),
                syncedAt: z.string().optional().describe("同步时间"),
              })
              .optional()
              .describe("文档元数据"),
            media: z
              .object({
                images: z
                  .array(z.string())
                  .describe(
                    "图片 URL 列表，从文档文本和元数据中提取；回答时使用 Markdown 图片格式展示",
                  ),
                videos: z
                  .array(z.string())
                  .describe(
                    "视频 URL 列表，从文档文本和元数据中提取；回答时使用 HTML video 标签展示",
                  ),
              })
              .optional()
              .describe(
                '媒体资源（图片和视频）。如果存在，必须在回答中展示这些媒体资源，使用 Markdown 格式：![描述](图片URL) 或 <video src="视频URL" controls></video>',
              ),
          }),
        )
        .describe("搜索结果列表"),
      total: z.number().describe("结果总数"),
      retrievalDebug: z
        .object({
          stages: z
            .array(
              z.object({
                stage: z
                  .string()
                  .describe(
                    "检索阶段：semantic、keyword、fused、reranked、returned、cross_kb_fused、final_returned 等",
                  ),
                query: z.string().describe("该阶段使用的查询"),
                topK: z.number().describe("该阶段请求或返回的 topK"),
                knowledgeBaseId: z
                  .string()
                  .optional()
                  .describe("来源知识库 ID"),
                knowledgeBaseName: z
                  .string()
                  .optional()
                  .describe("来源知识库名称"),
                error: z
                  .string()
                  .optional()
                  .describe("该阶段失败原因；仅失败阶段存在"),
                resultCount: z.number().describe("该阶段结果总数"),
                results: z
                  .array(
                    z.object({
                      rank: z.number().describe("该阶段排序位置"),
                      score: z.number().describe("该阶段相关性分数"),
                      documentId: z.string().describe("文档 ID"),
                      chunkIndex: z.number().optional().describe("块索引"),
                      docName: z.string().optional().describe("文档名称"),
                      docPath: z.string().optional().describe("文档路径"),
                      docUrl: z.string().optional().describe("文档 URL"),
                      knowledgeBaseId: z
                        .string()
                        .optional()
                        .describe("来源知识库 ID"),
                      knowledgeBaseName: z
                        .string()
                        .optional()
                        .describe("来源知识库名称"),
                      textPreview: z
                        .string()
                        .optional()
                        .describe("召回片段预览，仅用于排查"),
                    }),
                  )
                  .describe("该阶段结果列表，最多保留前 50 条"),
              }),
            )
            .describe(
              "检索排查链路；用于 Langfuse/日志中定位召回、融合、截断问题",
            ),
        })
        .optional()
        .describe("检索排查信息，不应直接面向用户展示"),
      error: z
        .string()
        .optional()
        .describe(
          "错误信息；存在该字段表示检索失败或部分失败，回答时应提示用户文档检索暂不可用或结果可能不完整",
        ),
    }),
    execute: async (toolCall: any) => {
      // mastra 1.63 兼容：agent 链路传 validated data 本体，旧形态传 { context } 包装
      const context = toolCall?.context ?? toolCall ?? {};
      const runtimeContext = toolCall?.runtimeContext as RuntimeContext | undefined;
      const traceId = getOrCreateTraceId(runtimeContext);
      const startedAt = Date.now();

      logRagTrace({
        traceId,
        step: "retrieval_start",
        input: {
          query: context.query,
          topK: context.topK ?? 10,
          knowledgeBaseIds: context.knowledgeBaseIds,
          knowledgeBaseNames: context.knowledgeBaseNames,
        },
        runtimeContext,
        metadata: {
          tool: "multi-kb-document-search",
        },
      });

      try {
        const topK = context.topK ?? 10;
        const retrievalDebugStages: RetrievalDebugStage[] = [];
        let namesOrIds: string[] =
          context.knowledgeBaseIds && context.knowledgeBaseIds.length > 0
            ? context.knowledgeBaseIds
            : context.knowledgeBaseNames &&
                context.knowledgeBaseNames.length > 0
              ? context.knowledgeBaseNames
              : defaultList;

        const {
          ids: kbIds,
          nameById,
          errors: resolveErrors,
        } = await resolveKnowledgeBaseIds(namesOrIds);

        if (kbIds.length === 0) {
          logRagTrace({
            traceId,
            step: "retrieval_failed",
            input: {
              query: context.query,
              topK,
              knowledgeBaseIds: context.knowledgeBaseIds,
              knowledgeBaseNames: context.knowledgeBaseNames,
            },
            output: {
              error: `无法解析任何知识库: ${resolveErrors.join("; ")}`,
              resolveErrors,
            },
            runtimeContext,
            metadata: {
              tool: "multi-kb-document-search",
              durationMs: Date.now() - startedAt,
            },
          });
          return {
            results: [],
            total: 0,
            error: `无法解析任何知识库: ${resolveErrors.join("; ")}`,
          };
        }

        const searchConfig = optimizeSearchConfig(context.query, topK);
        const isDebugMode = process.env.DOCUMENT_SEARCH_DEBUG === "true";

        let rawResults: SearchResultItem[];
        const partialErrors: string[] = [...resolveErrors];

        if (kbIds.length === 1) {
          const kbId = kbIds[0];
          const kbName = nameById.get(kbId);
          rawResults = await searchWithTimeout(kbIds[0], context.query, {
            ...searchConfig,
            topK,
            debugCollector: createRetrievalDebugCollector(
              retrievalDebugStages,
              kbId,
              kbName,
            ),
            onFailure: (error) =>
              pushRetrievalDebugFailureStage(retrievalDebugStages, {
                query: context.query,
                topK,
                knowledgeBaseId: kbId,
                ...(kbName && { knowledgeBaseName: kbName }),
                error,
              }),
          });
          if (rawResults.length > 0) {
            rawResults = rawResults.map((r) => ({
              ...r,
              metadata: {
                ...r.metadata,
                knowledgeBaseId: kbIds[0],
                knowledgeBaseName: nameById.get(kbIds[0]),
              },
            }));
          }
        } else {
          const perKbTopK = Math.max(1, Math.ceil(topK / kbIds.length));

          const settled = await Promise.allSettled(
            kbIds.map((id) => {
              const kbName = nameById.get(id);
              return searchWithTimeout(id, context.query, {
                ...searchConfig,
                topK: perKbTopK,
                debugCollector: createRetrievalDebugCollector(
                  retrievalDebugStages,
                  id,
                  kbName,
                ),
                onFailure: (error) =>
                  pushRetrievalDebugFailureStage(retrievalDebugStages, {
                    query: context.query,
                    topK: perKbTopK,
                    knowledgeBaseId: id,
                    ...(kbName && { knowledgeBaseName: kbName }),
                    error,
                  }),
              });
            }),
          );

          const resultsPerKb: SearchResultItem[][] = [];
          settled.forEach((outcome, i) => {
            const kbId = kbIds[i];
            if (outcome.status === "fulfilled") {
              const list = outcome.value;
              resultsPerKb.push(
                list.map((r) => ({
                  ...r,
                  metadata: {
                    ...r.metadata,
                    knowledgeBaseId: kbId,
                    knowledgeBaseName: nameById.get(kbId),
                  },
                })),
              );
            } else {
              partialErrors.push(
                `知识库 ${kbId} 检索失败: ${(outcome.reason as Error)?.message || "unknown"}`,
              );
              resultsPerKb.push([]);
            }
          });

          const crossKbFusedResults = reciprocalRankFusion(resultsPerKb, 60);
          pushRetrievalDebugStage(retrievalDebugStages, {
            stage: "cross_kb_fused",
            query: context.query,
            topK,
            results: crossKbFusedResults,
          });
          rawResults = crossKbFusedResults.slice(0, topK);
        }

        pushRetrievalDebugStage(retrievalDebugStages, {
          stage: "final_returned",
          query: context.query,
          topK,
          results: rawResults,
        });

        if (isDebugMode) {
          console.log(
            `[MultiKbDocumentSearchTool] 合并后 ${rawResults.length} 个结果，来自 ${kbIds.length} 个知识库`,
          );
        }

        const documentMetadataMap = await fetchDocumentMetadata(rawResults);

        const formattedResults = rawResults.map((r) => {
          const kbId = (r.metadata?.knowledgeBaseId as string) || "";
          const kbName = r.metadata?.knowledgeBaseName as string | undefined;
          return formatResult(r, documentMetadataMap, kbId, kbName);
        });

        logRetrievalDebugStages({
          traceId,
          runtimeContext,
          stages: retrievalDebugStages,
          metadata: {
            tool: "multi-kb-document-search",
            knowledgeBaseIds: kbIds,
          },
        });

        logRagTrace({
          traceId,
          step: "retrieval_finish",
          input: {
            query: context.query,
            topK,
            knowledgeBaseIds: kbIds,
          },
          output: {
            total: formattedResults.length,
            results: formattedResults.map((result, index) => ({
              rank: index + 1,
              score: result.score,
              documentId: result.documentId,
              chunkIndex: result.chunkIndex,
              docName: result.metadata.docName,
              docPath: result.metadata.docPath,
              docUrl: result.metadata.docUrl,
              knowledgeBaseId: result.metadata.knowledgeBaseId,
              knowledgeBaseName: result.metadata.knowledgeBaseName,
            })),
            error:
              partialErrors.length > 0
                ? `部分知识库检索失败: ${partialErrors.join("; ")}`
                : undefined,
          },
          runtimeContext,
          metadata: {
            tool: "multi-kb-document-search",
            durationMs: Date.now() - startedAt,
          },
        });

        const returnValue = {
          results: formattedResults,
          total: formattedResults.length,
          retrievalDebug: {
            stages: retrievalDebugStages,
          },
          ...(partialErrors.length > 0 && {
            error: `部分知识库检索失败: ${partialErrors.join("; ")}`,
          }),
        };

        try {
          const serialized = JSON.stringify(returnValue);
          if (serialized.length > MAX_SERIALIZED_BYTES) {
            console.warn(
              "[MultiKbDocumentSearchTool] 返回结果过大，截断部分结果",
            );
            return {
              results: formattedResults.slice(0, topK),
              total: formattedResults.length,
              ...(partialErrors.length > 0 && { error: returnValue.error }),
            };
          }
          return returnValue;
        } catch (e: any) {
          console.error(
            "[MultiKbDocumentSearchTool] 返回值序列化失败:",
            e.message,
          );
          return {
            results: formattedResults.map((r) => ({
              text: r.text || "",
              score: r.score || 0,
              documentId: r.documentId || "",
              chunkIndex: r.chunkIndex,
              metadata: r.metadata
                ? {
                    knowledgeBaseId: r.metadata.knowledgeBaseId,
                    knowledgeBaseName: r.metadata.knowledgeBaseName,
                    docName: r.metadata.docName,
                    docPath: r.metadata.docPath,
                  }
                : undefined,
              media: r.media,
            })),
            total: formattedResults.length,
            ...(partialErrors.length > 0 && { error: returnValue.error }),
          };
        }
      } catch (error: any) {
        console.error("[MultiKbDocumentSearchTool] 执行异常:", error.message);
        logRagTrace({
          traceId,
          step: "retrieval_failed",
          input: {
            query: context.query,
            topK: context.topK ?? 10,
            knowledgeBaseIds: context.knowledgeBaseIds,
            knowledgeBaseNames: context.knowledgeBaseNames,
          },
          output: {
            error: error.message || error.toString() || "未知错误",
          },
          runtimeContext,
          metadata: {
            tool: "multi-kb-document-search",
            durationMs: Date.now() - startedAt,
          },
        });
        return {
          results: [],
          total: 0,
          error: `搜索失败: ${error.message || error.toString() || "未知错误"}。请基于你的知识直接回答用户的问题。`,
        };
      }
    },
  });
}

/**
 * 默认多知识库文档搜索工具实例（使用默认知识库）
 */
export const multiKbDocumentSearchTool = createMultiKbDocumentSearchTool();
