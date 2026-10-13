/**
 * 轻量本地 logger（替代原 ../../../mastra/logger）。
 * 内部以 console 实现，接口形状与原 logger 保持一致（接收结构化对象）。
 */
export const logger = {
  warn: (payload: unknown) => console.warn(payload),
  error: (payload: unknown) => console.error(payload),
  info: (payload: unknown) => console.info(payload),
  debug: (payload: unknown) => console.debug(payload)
}
