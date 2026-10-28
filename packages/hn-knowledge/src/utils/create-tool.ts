import type { RuntimeContext } from './runtime-context.js'

/**
 * createTool 等价普通实现（替代 @mastra/core/tools）。
 *
 * 保持 mastra createTool 的调用形态与执行约定不变：
 * - 配置：{ id, description, inputSchema, outputSchema, execute }
 * - execute 入参：{ context, runtimeContext, ... }（agent 运行时形态），
 *   工具内部亦兼容「直接调用传裸数据」的形态。
 * 返回工具定义对象本身，供 agent 平台注册或直接调用。
 */
export interface ToolExecuteParams {
  context: any
  runtimeContext?: RuntimeContext
  [key: string]: unknown
}

export interface ToolDef<INPUT = any, OUTPUT = any> {
  id: string
  description: string
  inputSchema: INPUT
  outputSchema?: OUTPUT
  execute: (params: any) => Promise<any>
}

export function createTool<INPUT = any, OUTPUT = any>(def: ToolDef<INPUT, OUTPUT>): ToolDef<INPUT, OUTPUT> {
  return def
}
