/**
 * 全局响应包装（原 ResponseFormatterInterceptor 语义）：
 * 控制器响应统一包为 {code:200, success:true, data, message:'Success'}；
 * 错误响应（>=400）统一改写为原 HttpExceptionFilter 形态
 * {statusCode, timestamp:'yyyy-MM-dd HH:mm:ss', url:'METHOD path', message:<原始响应体>}。
 * 仅用于 /gw-api、/report-api 等控制器路由；hosting 链（代理/静态/HTML）不经过此包装。
 */
import type { MiddlewareHandler } from "hono"

function localTimestamp(): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
}

export const responseFormatter: MiddlewareHandler = async (c, next) => {
  await next()
  const res = c.res
  if (!res) return

  if (res.status >= 400) {
    // 原 HttpExceptionFilter：所有异常响应统一形态
    const contentType = res.headers.get("content-type") ?? ""
    let message: unknown
    try {
      // clone 读取：不消费原始流（alreadyShaped 原样返回时流须保持可读）
      const peek = res.clone()
      message = contentType.includes("application/json") ? await peek.json() : await peek.text()
    } catch {
      message = res.statusText
    }
    // 已是 Nest 形态（如 hosting 链对 /gw-api 未知路径的 404）则不再二次包装
    const alreadyShaped =
      message !== null &&
      typeof message === "object" &&
      "statusCode" in (message as Record<string, unknown>) &&
      "timestamp" in (message as Record<string, unknown>)
    if (alreadyShaped) return
    const status = res.status
    c.res = Response.json(
      {
        statusCode: status,
        timestamp: localTimestamp(),
        url: `${c.req.method} ${new URL(c.req.url).pathname}`,
        message,
      },
      { status },
    )
    return
  }

  const contentType = res.headers.get("content-type") ?? ""
  let data: unknown
  if (contentType.includes("application/json")) {
    try {
      data = await res.json()
    } catch {
      data = await res.text()
    }
  } else {
    data = await res.text()
  }
  c.res = Response.json({ code: 200, success: true, data, message: "Success" }, { status: res.status })
}
