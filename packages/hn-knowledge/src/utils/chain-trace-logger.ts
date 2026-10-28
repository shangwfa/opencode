import { randomUUID } from "node:crypto";

import { getChainTraceContext } from "./chain-trace-context.js";

// 等价普通实现：替代原 @xybot/observability 的 createLogger（mastra 平台日志器），
// 统一走结构化 JSON 控制台输出，保持 logChainTrace 的调用形态不变。
const logger: Record<ChainTraceLevel, (payload: object) => void> = {
  debug: (payload) => console.debug(JSON.stringify(payload)),
  info: (payload) => console.info(JSON.stringify(payload)),
  warn: (payload) => console.warn(JSON.stringify(payload)),
  error: (payload) => console.error(JSON.stringify(payload)),
};

export type ChainTraceType =
  | "agent_trace"
  | "rag_trace"
  | "request_trace"
  | "llm_proxy_trace";

export type ChainTraceLevel = "debug" | "info" | "warn" | "error";

export type ChainTraceLogOptions = Record<string, unknown> & {
  type: ChainTraceType;
  event: string;
  level?: ChainTraceLevel;
  traceId?: string;
  sessionId?: string;
  requestId?: string;
  proxyCallId?: string;
  err?: unknown;
};

/**
 * Temporary pass-through kept for API compatibility with existing trace
 * callers. Returning the original object also preserves custom toJSON()
 * behavior such as Mastra RuntimeContext serialization.
 */
export function sanitizeForLog(value: unknown): unknown {
  return value;
}

export function logChainTrace(options: ChainTraceLogOptions): void {
  try {
    const context = getChainTraceContext();
    const {
      level = "info",
      traceId = context?.traceId ?? randomUUID(),
      sessionId = context?.sessionId,
      requestId = context?.requestId,
      err,
      ...data
    } = options;
    const sanitized = sanitizeForLog(data) as Record<string, unknown>;
    const logMethod = logger[level] as ((payload: object) => void) | undefined;
    if (typeof logMethod !== "function") return;

    logMethod.call(logger, {
      ...sanitized,
      traceId,
      ...(sessionId ? { sessionId } : {}),
      ...(requestId ? { requestId } : {}),
      ...(err !== undefined ? { err: sanitizeForLog(err) } : {}),
    });
  } catch {
    // Observability must never change request behavior.
  }
}
