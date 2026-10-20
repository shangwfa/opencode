/**
 * 统一错误契约：{ code, message, field? }
 * 越权统一 404（不泄露资源存在性），见 docs/design/total-design.md 第十一节。
 */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503 | 504,
    readonly code: string,
    message: string,
    readonly field?: string,
  ) {
    super(message)
    this.name = "AppError"
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.field ? { field: this.field } : {}) }
  }
}

export const errors = {
  unauthorized: (message = "未登录或会话已过期") => new AppError(401, "unauthorized", message),
  invalid: (message: string, field?: string) => new AppError(400, "invalid_request", message, field),
  /** 资源不存在 或 无权访问 —— 统一 404，避免探测 */
  notFound: (resource = "resource") => new AppError(404, `${resource}_not_found`, "资源不存在或无权访问"),
  forbidden: (message = "没有权限执行该操作") => new AppError(403, "forbidden", message),
  conflict: (message: string, code = "conflict") => new AppError(409, code, message),
  internal: (message = "服务端错误") => new AppError(500, "internal_error", message),
  /** 上游（SaaS）错误：保留其语义，不伪装成我们的 500 */
  upstream: (status: 502 | 503 | 504, message: string) =>
    new AppError(status, status === 503 ? "upstream_unavailable" : "upstream_error", message),
}
