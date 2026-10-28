/**
 * hosting 责任链上下文与 handler 契约（对齐原 HandlerContext/RouteHandler）。
 * handler.handle 返回 Response 表示接管请求（短路）；返回 null 表示放行（等价原 shouldCallNext → next()）。
 */
import type { Context } from "hono"

export interface HostingContext {
  /** hono 上下文（读写请求体/构造响应） */
  c: Context
  /** domain 头或 Host（小写） */
  domain: string
  /** 请求路径（含前缀） */
  baseUrl: string
  traceId: string
  /** 请求头 version（灰度测试用，最高优先级） */
  version?: string
  enterpriseUuid: string
  uuid: string
}

export interface HostingHandler {
  readonly name: string
  canHandle(ctx: HostingContext): boolean
  /** 返回 Response = 接管；返回 null = 未处理，继续责任链 */
  handle(ctx: HostingContext): Promise<Response | null>
}
