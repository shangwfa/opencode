import { randomUUID } from "node:crypto";
import type { RuntimeContext } from "./runtime-context.js";
import {
  logChainTrace,
  sanitizeForLog,
} from "./chain-trace-logger.js";

export { sanitizeForLog } from "./chain-trace-logger.js";

export type RagTraceStep =
  | "agent_start"
  | "agent_finish"
  | "retrieval_start"
  | "retrieval_semantic"
  | "retrieval_keyword"
  | "retrieval_fused"
  | "retrieval_reranked"
  | "retrieval_returned"
  | "retrieval_cross_kb_fused"
  | "retrieval_final_returned"
  | "retrieval_kb_search_failed"
  | "retrieval_finish"
  | "retrieval_failed"
  | "retrieval_branch_start"
  | "retrieval_branch_finish"
  | "retrieval_tool_finish"
  | "retrieval_cancelled";

const RAG_TRACE_STEP_NAMES: Record<RagTraceStep, string> = {
  agent_start: "Agent 开始处理",
  agent_finish: "Agent 完成回答",
  retrieval_start: "检索开始",
  retrieval_semantic: "语义召回",
  retrieval_keyword: "关键词召回",
  retrieval_fused: "单知识库内融合",
  retrieval_reranked: "重排序",
  retrieval_returned: "单知识库返回",
  retrieval_cross_kb_fused: "跨知识库融合",
  retrieval_final_returned: "最终返回给 Agent",
  retrieval_kb_search_failed: "知识库检索失败",
  retrieval_finish: "检索完成",
  retrieval_failed: "检索整体失败",
  retrieval_branch_start: "检索分支开始",
  retrieval_branch_finish: "检索分支完成",
  retrieval_tool_finish: "检索工具完成",
  retrieval_cancelled: "检索已取消",
};

export type RagTraceLogOptions = {
  traceId: string;
  step: RagTraceStep | string;
  input?: unknown;
  output?: unknown;
  runtimeContext?: RuntimeContext;
  metadata?: Record<string, unknown>;
};

function hasRuntimeKey(runtimeContext: RuntimeContext, key: string): boolean {
  try {
    return runtimeContext.has(key);
  } catch {
    return false;
  }
}

function getRuntimeValue(runtimeContext: RuntimeContext, key: string): unknown {
  try {
    return runtimeContext.get(key);
  } catch {
    return undefined;
  }
}

function setRuntimeValue(
  runtimeContext: RuntimeContext,
  key: string,
  value: unknown,
): void {
  try {
    (
      runtimeContext as RuntimeContext & {
        set?: (key: string, value: unknown) => void;
      }
    ).set?.(key, value);
  } catch {
    // RuntimeContext implementations may be read-only in some execution paths.
  }
}

export function appendRetrievalTraceId(
  runtimeContext: RuntimeContext | undefined,
  traceId: string,
): void {
  if (!runtimeContext || !traceId) return;
  const current = getRuntimeValue(runtimeContext, "retrievalTraceIds");
  const ids = Array.isArray(current) ? current.filter((id): id is string => typeof id === "string") : [];
  if (!ids.includes(traceId)) setRuntimeValue(runtimeContext, "retrievalTraceIds", [...ids, traceId]);
}

export function getRetrievalTraceIds(runtimeContext: RuntimeContext | undefined): string[] {
  const value = runtimeContext ? getRuntimeValue(runtimeContext, "retrievalTraceIds") : undefined;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function getOrCreateTraceId(runtimeContext?: RuntimeContext): string {
  if (runtimeContext && hasRuntimeKey(runtimeContext, "traceId")) {
    const traceId = getRuntimeValue(runtimeContext, "traceId");
    if (traceId !== undefined && traceId !== null && String(traceId).trim()) {
      return String(traceId);
    }
  }

  const traceId = randomUUID();
  if (runtimeContext) {
    setRuntimeValue(runtimeContext, "traceId", traceId);
  }
  return traceId;
}

function getStepName(step: RagTraceStep | string): string {
  return RAG_TRACE_STEP_NAMES[step as RagTraceStep] ?? step;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function pickLatestItem(value: unknown[]): unknown {
  return value.length > 0 ? value[value.length - 1] : undefined;
}

function pickLatestUserMessage(value: unknown[]): unknown {
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    if (isRecord(item) && item.role === "user") {
      return item;
    }
  }

  return undefined;
}

function extractTextValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  }

  if (Array.isArray(value)) {
    return extractTextValue(pickLatestItem(value));
  }

  if (!isRecord(value)) {
    return undefined;
  }

  for (const key of ["contents", "messages"]) {
    const nested = value[key];
    if (Array.isArray(nested)) {
      const latestUserMessage = pickLatestUserMessage(nested);
      const text = extractTextValue(
        latestUserMessage ?? pickLatestItem(nested),
      );
      if (text) return text;
    }
  }

  for (const key of ["text", "query", "prompt", "question", "content"]) {
    const text = extractTextValue(value[key]);
    if (text) return text;
  }

  const parts = value.parts;
  if (Array.isArray(parts)) {
    const partTexts = parts
      .map((part) => extractTextValue(part))
      .filter((text): text is string => !!text);
    if (partTexts.length > 0) return partTexts.join("\n");
  }

  return undefined;
}

function pickQueryAndTopK(input: unknown): { query?: string; topK?: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }

  const inputRecord = input as Record<string, unknown>;
  const query =
    typeof inputRecord.query === "string" ? inputRecord.query : undefined;
  const topK =
    typeof inputRecord.topK === "number" ? inputRecord.topK : undefined;

  return {
    ...(query !== undefined && { query }),
    ...(topK !== undefined && { topK }),
  };
}

function pickAgent(
  runtimeContext: RuntimeContext | undefined,
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  const metadataAgent = metadata?.agentId;
  if (metadataAgent !== undefined && metadataAgent !== null) {
    const value = String(metadataAgent).trim();
    if (value) return value;
  }

  if (runtimeContext && hasRuntimeKey(runtimeContext, "agentId")) {
    const runtimeAgent = getRuntimeValue(runtimeContext, "agentId");
    if (runtimeAgent !== undefined && runtimeAgent !== null) {
      const value = String(runtimeAgent).trim();
      if (value) return value;
    }
  }

  return undefined;
}

export function logRagTrace(options: RagTraceLogOptions): void {
  const { query, topK } = pickQueryAndTopK(options.input);
  const input = extractTextValue(options.input) ?? options.input;
  const agent = pickAgent(options.runtimeContext, options.metadata);
  logChainTrace({
    type: "rag_trace",
    event: options.step,
    traceId: options.traceId,
    ...(agent !== undefined && { agent, agentId: agent }),
    step: options.step,
    stepName: getStepName(options.step),
    ...(query !== undefined && { query: sanitizeForLog(query) }),
    ...(topK !== undefined && { topK }),
    base_info: options.runtimeContext,
    question: sanitizeForLog(input),
    output: sanitizeForLog(options.output),
    metadata: sanitizeForLog(options.metadata),
    timestamp: new Date().toISOString(),
  });
}
