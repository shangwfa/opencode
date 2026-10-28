import { AsyncLocalStorage } from "node:async_hooks";

export type ChainTraceContext = {
  traceId: string;
  requestId: string;
  sessionId?: string;
};

const chainTraceStorage = new AsyncLocalStorage<ChainTraceContext>();

export function getChainTraceContext(): ChainTraceContext | undefined {
  return chainTraceStorage.getStore();
}

export function runWithChainTraceContext<T>(
  context: ChainTraceContext,
  callback: () => T,
): T {
  return chainTraceStorage.run(context, callback);
}
