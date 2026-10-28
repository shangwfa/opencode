import { createTool } from "../utils/create-tool.js";
import type { RuntimeContext } from "../utils/runtime-context.js";
import { z } from "zod";
import { getOrCreateTraceId, logRagTrace } from "../utils/rag-trace-logger.js";
import { createMultiKbDocumentSearchTool } from "./multi-kb-document-search-tool.js";

// 原 @mastra/core/ai-tracing 的最小本地替代：
// 仅使用 currentSpan.createChildSpan / end / error / update 能力，追踪失败不得影响检索行为。
const AISpanType = { GENERIC: "generic" } as const;

export interface TracingSpan {
  end: (options?: Record<string, unknown>) => void;
  error: (options: Record<string, unknown>) => void;
  update: (options: Record<string, unknown>) => void;
  createChildSpan?: (options: Record<string, unknown>) => TracingSpan | undefined;
}

export interface TracingContext {
  currentSpan?: TracingSpan;
}

type SearchType = "semantic" | "keyword" | "hybrid";

/**
 * 数据库混合检索依赖（原直接 import src/apis/database，知识库包不内置该模块，改为注入）。
 */
export interface RagDocumentDatabaseDeps {
  runDatabaseRowsSearch: (
    datasetId: string,
    raw: unknown,
    databaseService: unknown,
    selectFields: string[],
  ) => Promise<{ status: number; body: unknown }>;
  databaseService: unknown;
  RowsSearchRequestSchema: { parse: (data: unknown) => any };
}

export type RagDocumentSearchToolConfig = {
  knowledgeBaseIds?: string | string[];
  /**
   * Preferred name for the structured terminology dataset.
   * When present, database hybrid search is enabled.
   */
  terminologyDatasetId?: string;
  /**
   * Backward-compatible alias. If both are set, terminologyDatasetId wins.
   */
  databaseDatasetId?: string;
  databaseTopK?: number;
  databaseLimit?: number;
  instructionCandidateLimit?: number;
  databaseSearchType?: SearchType;
  databaseFilter?: Record<string, unknown>;
  /** 数据库检索依赖；配置 datasetId 时必须提供 */
  databaseDeps?: RagDocumentDatabaseDeps;
};

type DatabaseSearchResult = {
  text: string;
  score: number;
  vectorId: string;
  rowId?: string;
  chunkIndex?: number | string;
  row?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
};

/** 原 src/apis/database 的 DatabaseRowsSearchResponseBody 最小本地结构（databaseDeps 注入后仅依赖该形状） */
type DatabaseRowsSearchResponseBody = {
  results: Array<{
    id?: string;
    text?: string;
    score?: number;
    documentId?: string;
    chunkIndex?: number | string;
    vectorId?: string;
    row?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  }>;
  total?: number;
  searchType?: SearchType;
  mode?: "filter" | "query" | "combined";
  warning?: string;
};

type InstructionNameCandidate = {
  title: string;
  source: "database";
  datasetId: string;
  rowId?: string;
  score: number;
  rule: "must_use_title_exact";
};

const DEFAULT_DATABASE_TOP_K = 200;
const DEFAULT_DATABASE_LIMIT = 200;
const DEFAULT_INSTRUCTION_CANDIDATE_LIMIT = 200;
const DEFAULT_DATABASE_SEARCH_TYPE: SearchType = "hybrid";

type RetrievalBranch = "knowledge_base" | "database";
type RetrievalBranchOutput = {
  error?: string;
  [key: string]: unknown;
};

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

async function runObservedRetrievalBranch<T>({
  branch,
  input,
  runtimeContext,
  tracingContext,
  traceId,
  operation,
  toObservedOutput,
}: {
  branch: RetrievalBranch;
  input: Record<string, unknown>;
  runtimeContext?: RuntimeContext;
  tracingContext?: TracingContext;
  traceId: string;
  operation: () => Promise<T>;
  toObservedOutput: (result: T) => RetrievalBranchOutput;
}): Promise<T> {
  const startedAt = Date.now();
  const spanName = `retrieval.${branch}`;
  const span = tracingContext?.currentSpan?.createChildSpan?.({
    type: AISpanType.GENERIC,
    name: spanName,
    input,
    runtimeContext,
    metadata: { branch },
  });

  logRagTrace({
    traceId,
    step: "retrieval_branch_start",
    input,
    runtimeContext,
    metadata: { branch, spanName },
  });

  try {
    const result = await operation();
    const observedOutput = toObservedOutput(result);
    const durationMs = Date.now() - startedAt;
    const status = observedOutput.error ? "error" : "success";

    try {
      if (observedOutput.error) {
        span?.error({
          error: new Error(observedOutput.error),
          endSpan: true,
          metadata: { branch, status, durationMs },
        });
      } else {
        span?.end({
          output: observedOutput,
          metadata: { branch, status, durationMs },
        });
      }
    } catch {
      // Tracing must never change retrieval behavior.
    }

    logRagTrace({
      traceId,
      step: "retrieval_branch_finish",
      output: observedOutput,
      runtimeContext,
      metadata: { branch, status, durationMs },
    });
    return result;
  } catch (error) {
    const normalized = normalizeError(error);
    const durationMs = Date.now() - startedAt;
    const status = normalized.name === "AbortError" ? "cancelled" : "error";
    try {
      span?.error({
        error: normalized,
        endSpan: true,
        metadata: { branch, status, durationMs },
      });
    } catch {
      // Tracing must never change retrieval behavior.
    }
    logRagTrace({
      traceId,
      step:
        status === "cancelled"
          ? "retrieval_cancelled"
          : "retrieval_branch_finish",
      output: { error: normalized.message },
      runtimeContext,
      metadata: { branch, status, durationMs },
    });
    throw error;
  }
}

function normalizeId(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function pickFirstString(
  source: Record<string, unknown> | undefined,
  fields: string[],
): string | undefined {
  if (!source) return undefined;
  for (const field of fields) {
    const value = source[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

function getDatabaseTitle(result: {
  text?: string;
  row?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): string {
  const title =
    pickFirstString(result.row, ["title"]) ||
    pickFirstString(result.metadata, ["title"]);
  return title || result.text || "";
}

function getRowId(result: {
  documentId?: string;
  row?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}): string | undefined {
  const rowId = result.metadata?.rowId ?? result.row?.id ?? result.documentId;
  return rowId == null ? undefined : String(rowId);
}

function formatDatabaseResults(
  body: DatabaseRowsSearchResponseBody,
): DatabaseSearchResult[] {
  return body.results.map((result) => {
    const metadata = (result.metadata || {}) as Record<string, unknown>;
    const title = getDatabaseTitle({
      text: result.text || "",
      row: result.row,
      metadata,
    });
    const rowId = getRowId(result);
    const chunkIndex = (result.chunkIndex ?? metadata.chunkIndex) as
      | number
      | string
      | undefined;
    const titleOnlyMetadata = {
      ...(rowId && { rowId }),
      ...(chunkIndex !== undefined && { chunkIndex }),
      ...(title && { title }),
    };
    return {
      text: title,
      score: result.score ?? 0,
      vectorId: (result as { vectorId?: string }).vectorId ?? result.id ?? "",
      rowId,
      chunkIndex,
      ...(title && { row: { title } }),
      metadata: titleOnlyMetadata,
    };
  });
}

function extractInstructionNameCandidates(
  databaseResults: DatabaseSearchResult[],
  options: {
    datasetId: string;
    limit: number;
  },
): InstructionNameCandidate[] {
  const candidates = new Map<string, InstructionNameCandidate>();
  for (const result of databaseResults) {
    const title = pickFirstString(
      {
        ...(result.metadata || {}),
        ...(result.row || {}),
      },
      ["title"],
    );
    if (!title) continue;

    const existing = candidates.get(title);
    if (existing && existing.score >= result.score) continue;

    candidates.set(title, {
      title,
      source: "database",
      datasetId: options.datasetId,
      ...(result.rowId && { rowId: result.rowId }),
      score: result.score,
      rule: "must_use_title_exact",
    });
  }
  return Array.from(candidates.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, options.limit);
}

async function searchDatabaseForInstructionNames(
  databaseDeps: RagDocumentDatabaseDeps,
  options: {
  datasetId: string;
  query: string;
  topK: number;
  limit: number;
  searchType: SearchType;
  filter?: Record<string, unknown>;
}): Promise<{
  results: DatabaseSearchResult[];
  total: number;
  searchType: SearchType;
  mode: "filter" | "query" | "combined";
  warning?: string;
  error?: string;
}> {
  const raw = databaseDeps.RowsSearchRequestSchema.parse({
    query: options.query,
    filter: options.filter,
    topK: options.topK,
    limit: options.limit,
    selectFields: ["title"],
    searchType: options.searchType,
    recallConfig: {
      enableMultiStage: options.searchType === "semantic",
    },
  });
  const outcome = await databaseDeps.runDatabaseRowsSearch(
    options.datasetId,
    raw,
    databaseDeps.databaseService,
    ["title"],
  );
  if (outcome.status !== 200) {
    return {
      results: [],
      total: 0,
      searchType: options.searchType,
      mode: raw.filter ? "combined" : "query",
      error: (outcome.body as { message?: string }).message || "数据库检索失败",
    };
  }

  const body = outcome.body as DatabaseRowsSearchResponseBody;
  console.log(
    "-----database results-----",
    formatDatabaseResults(body),
    "length",
    formatDatabaseResults(body).length,
    "----query",
    options.query,
  );
  return {
    results: formatDatabaseResults(body),
    total: body.total ?? body.results.length,
    searchType: body.searchType ?? options.searchType,
    mode: body.mode ?? (raw.filter ? "combined" : "query"),
    ...(body.warning && { warning: body.warning }),
  };
}

function createMergedEvidence(options: {
  documentResults: Array<Record<string, unknown>>;
  databaseResults: DatabaseSearchResult[];
}): Array<Record<string, unknown>> {
  const documentEvidence = options.documentResults.map((result, index) => ({
    source: "knowledge_base",
    rank: index + 1,
    score: result.score,
    text: result.text,
    documentId: result.documentId,
    chunkIndex: result.chunkIndex,
    metadata: result.metadata,
  }));
  const databaseEvidence = options.databaseResults.map((result, index) => ({
    source: "database",
    rank: index + 1,
    score: result.score,
    text: result.text,
    rowId: result.rowId,
    chunkIndex: result.chunkIndex,
    row: result.row,
    metadata: result.metadata,
  }));
  return [...documentEvidence, ...databaseEvidence];
}

/**
 * 创建统一 RAG 文档搜索工具。
 *
 * - 未配置 terminologyDatasetId/databaseDatasetId：仅执行原有 KB hybrid search。
 * - 已配置 datasetId：并行执行 KB hybrid search 与 database hybrid search，并返回指令名候选。
 */
export function createRagDocumentSearchTool(
  config: RagDocumentSearchToolConfig = {},
) {
  const terminologyDatasetId =
    normalizeId(config.terminologyDatasetId) ||
    normalizeId(config.databaseDatasetId);
  const databaseDeps = config.databaseDeps;
  const kbTool = createMultiKbDocumentSearchTool(config.knowledgeBaseIds);

  return createTool({
    id: "rag-document-search",
    description:
      "统一 RAG 检索工具：检索文档知识库，并在配置 terminologyDatasetId/databaseDatasetId 时并行检索结构化数据集，用 database title 校准指令名。",
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
        .describe("返回的文档结果数量，默认 10"),
      knowledgeBaseIds: z
        .array(z.string())
        .optional()
        .describe("本次搜索的知识库 ID 列表；若提供则覆盖工具默认列表"),
      knowledgeBaseNames: z
        .array(z.string())
        .optional()
        .describe("本次搜索的知识库名称列表；若提供则覆盖工具默认列表"),
    }),
    outputSchema: z.object({
      results: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
      instructionNameCandidates: z
        .array(
          z.object({
            title: z.string(),
          }),
        )
        .optional(),
      retrievalMode: z
        .enum(["knowledge_base", "knowledge_base_with_database"])
        .optional(),
      error: z.string().optional(),
    }),
    execute: async (toolCall: any) => {
      const toolStartedAt = Date.now();
      // mastra 1.63 兼容：agent 链路传 validated data 本体，旧形态传 { context } 包装
      const context = toolCall?.context ?? toolCall ?? {};
      const runtimeContext = toolCall?.runtimeContext as RuntimeContext | undefined;
      const tracingContext = toolCall?.tracingContext as TracingContext | undefined;
      const traceId = getOrCreateTraceId(runtimeContext);
      const topK = context.topK ?? 10;
      const kbPromise = runObservedRetrievalBranch({
        branch: "knowledge_base",
        input: { query: context.query, topK },
        runtimeContext,
        tracingContext,
        traceId,
        operation: () =>
          kbTool.execute({
            ...toolCall,
            context: {
              query: context.query,
              topK,
              knowledgeBaseIds: context.knowledgeBaseIds,
              knowledgeBaseNames: context.knowledgeBaseNames,
            },
          } as never),
        toObservedOutput: (result) => ({
          results: Array.isArray(result.results) ? result.results : [],
          total:
            typeof result.total === "number"
              ? result.total
              : Array.isArray(result.results)
                ? result.results.length
                : 0,
          ...(result.retrievalDebug
            ? { retrievalDebug: result.retrievalDebug }
            : {}),
          ...(result.error ? { error: String(result.error) } : {}),
        }),
      });

      if (!terminologyDatasetId) {
        let kbResult: Awaited<typeof kbPromise>;
        try {
          kbResult = await kbPromise;
        } catch (error) {
          const durationMs = Date.now() - toolStartedAt;
          try {
            tracingContext?.currentSpan?.update?.({
              metadata: { retrievalStatus: "error", durationMs },
            });
          } catch {
            // Tracing must never change retrieval behavior.
          }
          logRagTrace({
            traceId,
            step: "retrieval_tool_finish",
            input: { query: context.query, topK },
            output: { error: normalizeError(error).message },
            runtimeContext,
            metadata: {
              tool: "rag-document-search",
              retrievalMode: "knowledge_base",
              status: "error",
              durationMs,
            },
          });
          throw error;
        }
        const durationMs = Date.now() - toolStartedAt;
        const status = kbResult.error ? "error" : "success";
        try {
          tracingContext?.currentSpan?.update?.({
            metadata: { retrievalStatus: status, durationMs },
          });
        } catch {
          // Tracing must never change retrieval behavior.
        }
        logRagTrace({
          traceId,
          step: "retrieval_tool_finish",
          input: { query: context.query, topK },
          output: {
            resultCount: Array.isArray(kbResult.results)
              ? kbResult.results.length
              : 0,
            error: kbResult.error,
          },
          runtimeContext,
          metadata: {
            tool: "rag-document-search",
            retrievalMode: "knowledge_base",
            status,
            durationMs,
          },
        });
        return {
          results: Array.isArray(kbResult.results) ? kbResult.results : [],
          total: kbResult.total ?? 0,
          ...(kbResult.error && { error: kbResult.error }),
          retrievalMode: "knowledge_base" as const,
        };
      }

      const databaseTopK = config.databaseTopK ?? DEFAULT_DATABASE_TOP_K;
      const databaseLimit = config.databaseLimit ?? DEFAULT_DATABASE_LIMIT;
      const instructionCandidateLimit =
        config.instructionCandidateLimit ?? DEFAULT_INSTRUCTION_CANDIDATE_LIMIT;
      const databaseSearchType =
        config.databaseSearchType ?? DEFAULT_DATABASE_SEARCH_TYPE;

      const databasePromise = runObservedRetrievalBranch({
        branch: "database",
        input: {
          query: context.query,
          topK: databaseTopK,
          limit: databaseLimit,
          datasetId: terminologyDatasetId,
        },
        runtimeContext,
        tracingContext,
        traceId,
        operation: () => {
          if (!databaseDeps) {
            return Promise.resolve({
              results: [],
              total: 0,
              searchType: databaseSearchType,
              mode: "query" as const,
              error:
                "未提供 databaseDeps（runDatabaseRowsSearch/databaseService/RowsSearchRequestSchema），数据库检索不可用",
            });
          }
          return searchDatabaseForInstructionNames(databaseDeps, {
            datasetId: terminologyDatasetId,
            query: context.query,
            topK: databaseTopK,
            limit: databaseLimit,
            searchType: databaseSearchType,
            filter: config.databaseFilter,
          });
        },
        toObservedOutput: (result) => ({
          resultCount: result.results.length,
          ...(result.error ? { error: result.error } : {}),
        }),
      });

      const [kbOutcome, databaseOutcome] = await Promise.allSettled([
        kbPromise,
        databasePromise,
      ]);

      const kbResult =
        kbOutcome.status === "fulfilled"
          ? kbOutcome.value
          : {
              results: [],
              total: 0,
              error:
                (kbOutcome.reason as Error)?.message || "文档知识库检索失败",
            };

      const databaseSearch =
        databaseOutcome.status === "fulfilled"
          ? databaseOutcome.value
          : {
              results: [],
              total: 0,
              searchType: databaseSearchType,
              mode: "query" as const,
              error:
                (databaseOutcome.reason as Error)?.message || "数据库检索失败",
            };

      const recalledDatabaseResults = databaseSearch.results;
      const instructionNameCandidates = extractInstructionNameCandidates(
        recalledDatabaseResults,
        {
          datasetId: terminologyDatasetId,
          limit: instructionCandidateLimit,
        },
      );
      const candidateTitles = new Set(
        instructionNameCandidates.map((candidate) => candidate.title),
      );
      const databaseResults = recalledDatabaseResults.filter((result) => {
        const title = pickFirstString(
          {
            ...(result.metadata || {}),
            ...(result.row || {}),
          },
          ["title"],
        );
        return title ? candidateTitles.has(title) : false;
      });
      const documentResults = Array.isArray(kbResult.results)
        ? (kbResult.results as Array<Record<string, unknown>>)
        : [];
      const mergedEvidence = createMergedEvidence({
        documentResults,
        databaseResults,
      });

      const errors = [kbResult.error, databaseSearch.error]
        .filter(Boolean)
        .map(String);
      const overallStatus =
        errors.length === 0
          ? "success"
          : documentResults.length > 0 || databaseResults.length > 0
            ? "degraded"
            : "error";
      const toolDurationMs = Date.now() - toolStartedAt;
      try {
        tracingContext?.currentSpan?.update?.({
          metadata: {
            retrievalStatus: overallStatus,
            durationMs: toolDurationMs,
          },
        });
      } catch {
        // Tracing must never change retrieval behavior.
      }
      const retrievalDebugStages = [
        ...((
          kbResult.retrievalDebug as
            | { stages?: Array<Record<string, unknown>> }
            | undefined
        )?.stages || []),
        {
          stage: "database_hybrid",
          query: context.query,
          topK: databaseTopK,
          datasetId: terminologyDatasetId,
          searchType: databaseSearch.searchType,
          mode: databaseSearch.mode,
          resultCount: recalledDatabaseResults.length,
          returnedResultCount: databaseResults.length,
          instructionCandidateLimit,
          warning: databaseSearch.warning,
          error: databaseSearch.error,
          results: recalledDatabaseResults
            .slice(0, 10)
            .map((result, index) => ({
              rank: index + 1,
              score: result.score,
              rowId: result.rowId,
              vectorId: result.vectorId,
              textPreview: result.text.slice(0, 300),
            })),
        },
        {
          stage: "evidence_fused",
          query: context.query,
          topK,
          resultCount: mergedEvidence.length,
          results: mergedEvidence.slice(0, 10),
        },
      ];

      logRagTrace({
        traceId,
        step: "rag_document_search_finish",
        input: {
          query: context.query,
          topK,
          databaseTopK,
          databaseLimit,
          instructionCandidateLimit,
          datasetId: terminologyDatasetId,
        },
        output: {
          retrievalDebug: {
            stages: retrievalDebugStages,
          },
          databaseTotal: databaseSearch.total,
          returnedInstructionCandidateCount: instructionNameCandidates.length,
          error: errors.length > 0 ? errors.join("；") : undefined,
        },
        runtimeContext,
        metadata: {
          tool: "rag-document-search",
          retrievalMode: "knowledge_base_with_database",
          status: overallStatus,
          durationMs: toolDurationMs,
        },
      });

      logRagTrace({
        traceId,
        step: "retrieval_tool_finish",
        input: { query: context.query, topK },
        output: {
          knowledgeBaseResultCount: documentResults.length,
          databaseResultCount: databaseResults.length,
          instructionCandidateCount: instructionNameCandidates.length,
          error: errors.length > 0 ? errors.join("；") : undefined,
        },
        runtimeContext,
        metadata: {
          tool: "rag-document-search",
          retrievalMode: "knowledge_base_with_database",
          status: overallStatus,
          durationMs: toolDurationMs,
        },
      });

      return {
        results: documentResults,
        total: kbResult.total ?? documentResults.length,
        instructionNameCandidates: instructionNameCandidates.map(
          (candidate) => ({
            title: candidate.title,
          }),
        ),
        retrievalMode: "knowledge_base_with_database" as const,
        ...(errors.length > 0 && { error: errors.join("；") }),
      };
    },
  });
}

export const ragDocumentSearchTool = createRagDocumentSearchTool();
