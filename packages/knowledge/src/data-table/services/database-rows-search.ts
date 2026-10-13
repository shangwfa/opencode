import { embed } from "ai";
import { openaiEmbedding } from "../../providers/llm.js";
import {
  vectorService,
  keywordSearchService,
  hybridSearchService,
  recallService,
  rerankService,
} from "../../rag/knowledge-base/index.js";
import { getHyDEService } from "../../rag/knowledge-base/index.js";
import { getMultiQueryService } from "../../rag/knowledge-base/index.js";
import type { SearchResultItem } from "../../rag/knowledge-base/index.js";
import {
  calculateRecallTopK,
  validateRecallConfig,
  filterLowScoreResults,
  checkResultQuality,
  formatVectorResults,
} from "../../utils/search-helper.js";
import {
  DEFAULT_SEARCH_TYPE,
  DEFAULT_ENABLE_MULTI_STAGE,
  DEFAULT_ENABLE_RERANK,
  SEARCH_ERROR_MESSAGES,
} from "../../config/search.constants.js";
import { getKnowledgeBaseIndexName } from "../../utils/index-name.js";
import {
  ROWS_SEARCH_DEFAULT_FILTER_LIMIT,
  ROWS_SEARCH_DEFAULT_TOP_K,
} from "../types/database.types.js";
import type { RowsSearchRequest } from "../types/database.types.js";
import type { DatabaseService } from "./database.service.js";

function mergePgVectorConfig(v: RowsSearchRequest): {
  minScore?: number;
  ef?: number;
  probes?: number;
} {
  const p = v.pgVectorConfig || {};
  return {
    ...p,
    ...(v.minScore !== undefined ? { minScore: v.minScore } : {}),
    ...(v.ef !== undefined ? { ef: v.ef } : {}),
    ...(v.probes !== undefined ? { probes: v.probes } : {}),
  };
}

function rowIdFromSearchHit(r: {
  id: string;
  metadata?: Record<string, unknown>;
}): string {
  const md = r.metadata || {};
  if (md.rowId != null && String(md.rowId).length > 0) return String(md.rowId);
  const s = String(r.id);
  const m = /^(.+)__c(\d+)$/.exec(s);
  if (m) return m[1];
  return s;
}

function intersectByAllowedIds<
  T extends { id: string; metadata?: Record<string, unknown> },
>(results: T[], allowedIds: Set<string>, cap: number): T[] {
  const out: T[] = [];
  for (const r of results) {
    if (allowedIds.has(rowIdFromSearchHit(r))) {
      out.push(r);
      if (out.length >= cap) break;
    }
  }
  return out;
}

function isRowsSearchProfileEnabled(): boolean {
  const raw = String(process.env.DB_ROWS_SEARCH_PROFILE ?? "true")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true";
}

function normalizeSelectFields(fields?: string[]): string[] | undefined {
  if (!fields?.length) return undefined;
  const normalized = Array.from(
    new Set(fields.map((f) => f.trim()).filter(Boolean)),
  );
  return normalized.length ? normalized : undefined;
}

function projectRowFields(
  row: Record<string, unknown>,
  selectFields?: string[],
): Record<string, unknown> {
  if (!selectFields?.length) return row;
  const projected: Record<string, unknown> = {};
  for (const field of selectFields) {
    if (Object.prototype.hasOwnProperty.call(row, field)) {
      projected[field] = row[field];
    }
  }
  return projected;
}

function projectSearchResultRows<T extends { row?: Record<string, unknown> }>(
  items: T[],
  selectFields?: string[],
): T[] {
  if (!selectFields?.length) return items;
  return items.map((item) => ({
    ...item,
    ...(item.row ? { row: projectRowFields(item.row, selectFields) } : {}),
  }));
}

export interface DatabaseRowsSearchResponseBody {
  results: Array<
    SearchResultItem & { row?: Record<string, unknown> } & { vectorId?: string }
  >;
  total?: number;
  searchType?: "semantic" | "keyword" | "hybrid";
  recallStage?: string;
  reranked?: boolean;
  sqlFilter?: boolean;
  mode?: "filter" | "query" | "combined";
  vectorSearch?: boolean;
  warning?: string;
  filteredCount?: number;
}

/**
 * POST /database/:id/rows/search 主逻辑（与 knowledge-base /search 对齐；向量侧为行文本分块后的 chunk，命中文本为块内容）
 */
export async function runDatabaseRowsSearch(
  datasetId: string,
  validated: RowsSearchRequest,
  databaseService: DatabaseService,
  selectFieldsOverride?: string[],
): Promise<{
  status: 200 | 400 | 404;
  body: DatabaseRowsSearchResponseBody | { message: string };
}> {
  const profileEnabled = isRowsSearchProfileEnabled();
  const startedAt = Date.now();
  let stageStartedAt = startedAt;
  const stageCosts: Record<string, number> = {};
  const markStage = (stage: string): void => {
    if (!profileEnabled) return;
    const now = Date.now();
    stageCosts[stage] = now - stageStartedAt;
    stageStartedAt = now;
  };
  const selectFields = normalizeSelectFields(
    selectFieldsOverride ?? validated.selectFields,
  );
  const effectiveTopK = validated.topK ?? ROWS_SEARCH_DEFAULT_TOP_K;
  const effectiveFilterLimit =
    validated.limit ?? ROWS_SEARCH_DEFAULT_FILTER_LIMIT;
  const flushProfile = (
    status: number,
    extra: Record<string, unknown> = {},
  ): void => {
    if (!profileEnabled) return;
    console.info(
      "[database.rows.search.profile]",
      JSON.stringify({
        datasetId,
        status,
        totalMs: Date.now() - startedAt,
        stages: stageCosts,
        searchType: validated.searchType || DEFAULT_SEARCH_TYPE,
        topK: effectiveTopK,
        filterLimit: effectiveFilterLimit,
        hasFilter:
          !!validated.filter && Object.keys(validated.filter).length > 0,
        hasQuery:
          !!validated.query && String(validated.query).trim().length > 0,
        selectFields,
        ...extra,
      }),
    );
  };

  const ds = await databaseService.getDatabase(datasetId);
  markStage("load_dataset");
  if (!ds) {
    flushProfile(404, { reason: "dataset_not_found" });
    return { status: 404, body: { message: "Dataset not found" } };
  }

  const physicalIndexName =
    ds.indexName || getKnowledgeBaseIndexName(datasetId);
  vectorService.primeIndexNameCache(datasetId, physicalIndexName);
  keywordSearchService.primeIndexNameCache(datasetId, physicalIndexName);
  markStage("prime_index_cache");

  const embeddingModelName =
    ds.embeddingModel || "openai/text-embedding-3-small";
  const pgVectorMerged = mergePgVectorConfig(validated);

  const hasQuery =
    validated.query != null && String(validated.query).trim().length > 0;
  const hasFilter =
    validated.filter != null &&
    Object.keys(validated.filter as Record<string, unknown>).length > 0;

  // 仅列过滤（无 query）：SQL 过滤列表
  if (!hasQuery && hasFilter) {
    const items = await databaseService.searchRowsByFilter(
      datasetId,
      validated.filter as Record<string, unknown>,
      effectiveFilterLimit,
    );
    markStage("sql_filter_only");
    const mapped = items.map((row) => {
      const id = String(row.id ?? "");
      return {
        id,
        vectorId: id,
        text: "",
        score: 1,
        metadata: {},
        documentId: id,
        row: projectRowFields(row, selectFields),
      };
    });
    flushProfile(200, { mode: "filter", resultCount: mapped.length });
    return {
      status: 200,
      body: {
        results: mapped,
        total: mapped.length,
        searchType: "semantic",
        reranked: false,
        sqlFilter: true,
        mode: "filter",
        vectorSearch: false,
      },
    };
  }

  const queryText = validated.query!.trim();
  const searchType = validated.searchType || DEFAULT_SEARCH_TYPE;
  const enableRerank =
    validated.rerankConfig?.enableRerank ?? DEFAULT_ENABLE_RERANK;
  const enableMultiStage =
    validated.recallConfig?.enableMultiStage ?? DEFAULT_ENABLE_MULTI_STAGE;
  const enableMultiStageExplicitlySet =
    validated.recallConfig?.enableMultiStage !== undefined;
  const enableQueryExpansion =
    validated.recallConfig?.enableQueryExpansion ?? false;
  const recallTopK = validated.recallConfig?.recallTopK;

  validateRecallConfig(effectiveTopK, recallTopK);

  if (enableMultiStage && searchType === "keyword") {
    flushProfile(400, { reason: "multi_stage_semantic_only" });
    return {
      status: 400,
      body: { message: SEARCH_ERROR_MESSAGES.MULTI_STAGE_SEMANTIC_ONLY },
    };
  }

  let recallCount = calculateRecallTopK(effectiveTopK, enableRerank);
  if (hasFilter) {
    recallCount = Math.min(500, Math.max(recallCount * 3, 80));
  }

  let allowedIds: Set<string> | null = null;
  let adaptiveRecallCap: number | undefined;
  let effectiveEnableMultiStage = enableMultiStage;
  let multiStageAutoDisabledReason: string | undefined;
  if (hasFilter) {
    const filteredRows = await databaseService.searchRowsByFilter(
      datasetId,
      validated.filter as Record<string, unknown>,
      effectiveFilterLimit,
      { idOnly: true },
    );
    markStage("sql_filter_prefetch");
    allowedIds = new Set(
      filteredRows.map((r) => String(r.id ?? "")).filter(Boolean),
    );
    const minRecallForTopK = Math.max(effectiveTopK * 2, 20);
    adaptiveRecallCap = Math.min(
      recallCount,
      Math.max(minRecallForTopK, allowedIds.size * 2),
    );
    recallCount = Math.min(recallCount, adaptiveRecallCap);
    if (!enableMultiStageExplicitlySet && allowedIds.size <= 120) {
      // Combined mode with a small SQL candidate set usually does not benefit from multi-stage recall.
      effectiveEnableMultiStage = false;
      multiStageAutoDisabledReason = "small_sql_candidate_set";
    }
    if (allowedIds.size === 0) {
      const empty: DatabaseRowsSearchResponseBody = {
        results: [],
        total: 0,
        searchType,
        reranked: false,
        sqlFilter: true,
        mode: "combined",
        vectorSearch: true,
        warning: SEARCH_ERROR_MESSAGES.NO_RESULTS_FOUND,
      };
      flushProfile(200, { allowedIds: 0, resultCount: 0 });
      return { status: 200, body: empty };
    }
  }

  let results: SearchResultItem[] = [];
  let recallStage: string | undefined;
  let reranked = false;

  const enableHyDE = validated.hydeConfig?.enableHyDE ?? false;
  const enableMultiQuery =
    validated.multiQueryConfig?.enableMultiQuery ?? false;
  if (
    !enableMultiStageExplicitlySet &&
    !hasFilter &&
    searchType === "semantic" &&
    !enableQueryExpansion &&
    !enableHyDE &&
    !enableMultiQuery &&
    effectiveTopK <= 20
  ) {
    // For small topK semantic searches without advanced recall features,
    // multi-stage adds latency but often little quality gain.
    effectiveEnableMultiStage = false;
    multiStageAutoDisabledReason = "small_topk_plain_semantic";
  }

  const applySqlFilter = (list: SearchResultItem[]): SearchResultItem[] => {
    if (!allowedIds) return list;
    return intersectByAllowedIds(list, allowedIds, recallCount * 2);
  };

  // HyDE + 多查询（仅语义）
  if (enableHyDE && enableMultiQuery && searchType === "semantic") {
    const hydeService = getHyDEService(
      validated.hydeConfig?.llmModel || "gpt-4o-mini",
      validated.hydeConfig?.embeddingModel || embeddingModelName,
      true,
    );
    const multiQueryService = getMultiQueryService(
      validated.multiQueryConfig?.llmModel || "gpt-4o-mini",
      embeddingModelName,
      true,
      validated.multiQueryConfig?.numVariations || 3,
    );
    const hypotheticalDoc =
      await hydeService.generateHypotheticalDocument(queryText);
    const variations = await multiQueryService.generateQueryVariations(
      queryText,
      validated.multiQueryConfig?.numVariations || 3,
    );
    const allQueries = [queryText, ...variations, hypotheticalDoc];
    const allResults = await Promise.all(
      allQueries.map(async (q) => {
        const { embedding } = await embed({
          value: q,
          model: openaiEmbedding(embeddingModelName.replace("openai/", "")),
        });
        const vectorResults = await vectorService.query(
          datasetId,
          embedding,
          recallCount,
          undefined,
          Object.keys(pgVectorMerged).length ? pgVectorMerged : undefined,
        );
        return formatVectorResults(vectorResults);
      }),
    );
    const { reciprocalRankFusion } =
      await import("../../utils/rrf-fusion.js");
    results = reciprocalRankFusion(allResults, validated.rrfK ?? 60);
    results = applySqlFilter(results);
    recallStage = "hyde+multi-query";
  } else if (enableHyDE && searchType === "semantic") {
    const hydeService = getHyDEService(
      validated.hydeConfig?.llmModel || "gpt-4o-mini",
      validated.hydeConfig?.embeddingModel || embeddingModelName,
      true,
    );
    results = await hydeService.searchWithHyDE(
      datasetId,
      queryText,
      recallCount,
      vectorService,
      Object.keys(pgVectorMerged).length ? pgVectorMerged : undefined,
    );
    results = applySqlFilter(results);
    recallStage = "hyde";
  } else if (enableMultiQuery && searchType === "semantic") {
    const multiQueryService = getMultiQueryService(
      validated.multiQueryConfig?.llmModel || "gpt-4o-mini",
      embeddingModelName,
      true,
      validated.multiQueryConfig?.numVariations || 3,
    );
    results = await multiQueryService.searchWithMultiQuery(
      datasetId,
      queryText,
      recallCount,
      vectorService,
      Object.keys(pgVectorMerged).length ? pgVectorMerged : undefined,
      validated.multiQueryConfig?.numVariations || 3,
    );
    results = applySqlFilter(results);
    recallStage = "multi-query";
  } else if (effectiveEnableMultiStage || enableQueryExpansion) {
    results = await recallService.recall(datasetId, queryText, {
      enableMultiStage: effectiveEnableMultiStage,
      enableQueryExpansion,
      coarseTopK: recallTopK ?? recallCount,
      fineTopK: recallCount,
      pgVectorConfig: Object.keys(pgVectorMerged).length
        ? pgVectorMerged
        : undefined,
      embeddingModel: embeddingModelName,
    });
    results = applySqlFilter(results);
    recallStage = effectiveEnableMultiStage ? "multi-stage" : "single-stage";
  } else {
    switch (searchType) {
      case "semantic": {
        const { embedding } = await embed({
          value: queryText,
          model: openaiEmbedding(embeddingModelName.replace("openai/", "")),
        });
        const vectorResults = await vectorService.query(
          datasetId,
          embedding,
          recallCount,
          undefined,
          Object.keys(pgVectorMerged).length ? pgVectorMerged : undefined,
        );
        results = formatVectorResults(vectorResults);
        results = applySqlFilter(results);
        break;
      }
      case "keyword": {
        results = await keywordSearchService.search(
          datasetId,
          queryText,
          recallCount,
          undefined,
        );
        results = applySqlFilter(results);
        break;
      }
      case "hybrid": {
        results = await hybridSearchService.search(datasetId, queryText, {
          semanticWeight: validated.hybridWeight?.semantic || 0.7,
          keywordWeight: validated.hybridWeight?.keyword || 0.3,
          topK: recallCount,
          pgVectorConfig: Object.keys(pgVectorMerged).length
            ? pgVectorMerged
            : undefined,
          embeddingModel: embeddingModelName,
          fusionMethod: validated.fusionMethod,
          rrfK: validated.rrfK,
        });
        results = applySqlFilter(results);
        break;
      }
    }
  }
  markStage("recall");

  if (enableRerank && results.length > 0) {
    results = await rerankService.rerank(queryText, results, {
      model: validated.rerankConfig?.rerankModel || "simple",
      topK: validated.rerankConfig?.rerankTopK ?? results.length,
    });
    reranked = true;
  }
  markStage("rerank");

  markStage("score_filter");

  const limitedResults = results.slice(0, effectiveTopK);
  const qualityCheck = checkResultQuality(
    limitedResults,
    effectiveTopK,
    searchType,
  );
  const hydrated = await databaseService.hydrateSearchResults(
    datasetId,
    limitedResults,
  );
  markStage("hydrate");
  const withVectorId = projectSearchResultRows(
    hydrated.map((r) => ({
      ...r,
      vectorId: r.id,
    })),
    selectFields,
  );

  const response: DatabaseRowsSearchResponseBody = selectFieldsOverride
    ? {
        results: withVectorId,
      }
    : {
        results: withVectorId,
        total: withVectorId.length,
        searchType,
        recallStage,
        reranked,
        sqlFilter: !!hasFilter,
        mode: hasFilter ? "combined" : "query",
        vectorSearch: true,
      };

  if (!qualityCheck.isHighQuality && qualityCheck.message) {
    response.warning = qualityCheck.message;
    response.filteredCount = qualityCheck.filteredCount;
  }
  if (withVectorId.length === 0) {
    response.warning = SEARCH_ERROR_MESSAGES.NO_RESULTS_FOUND;
  }

  flushProfile(200, {
    recallCount,
    adaptiveRecallCap,
    effectiveEnableMultiStage,
    multiStageAutoDisabledReason,
    reranked,
    resultCountBeforeLimit: results.length,
    resultCount: withVectorId.length,
  });
  return { status: 200, body: response };
}
