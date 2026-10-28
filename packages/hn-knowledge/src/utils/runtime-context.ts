/**
 * RuntimeContext 等价普通实现（替代 @mastra/core/runtime-context）。
 *
 * graph 模块只用到 has/get/set 三个键值存取能力（见 utils/rag-trace-logger.ts），
 * 与 mastra RuntimeContext 的 Map 语义保持兼容：agent 平台侧可直接传入同形态对象。
 */
export interface RuntimeContext {
  has(key: string): boolean
  get(key: string): unknown
  set?(key: string, value: unknown): void
}

/** 简单内存实现，供直接调用工具/检索链路时构造 trace 上下文 */
export class SimpleRuntimeContext implements RuntimeContext {
  private store = new Map<string, unknown>()

  has(key: string): boolean {
    return this.store.has(key)
  }

  get(key: string): unknown {
    return this.store.get(key)
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value)
  }
}
