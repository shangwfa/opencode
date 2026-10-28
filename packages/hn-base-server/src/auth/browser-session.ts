import { APIError, createAuthEndpoint, getAuthoritativeSessionFromCtx } from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"

/** 将现有 Bearer 会话物化为浏览器 Cookie，不新建用户或会话。 */
export const browserSession = {
  id: "browser-session",
  endpoints: {
    syncBrowserSession: createAuthEndpoint("/browser-session", { method: "POST" }, async (ctx) => {
      const session = await getAuthoritativeSessionFromCtx(ctx)
      if (!session || (session.user as { status?: string }).status === "disabled") {
        throw new APIError("UNAUTHORIZED", { message: "未登录或会话已过期" })
      }
      await setSessionCookie(ctx, session)
      ctx.setHeader("cache-control", "no-store")
      return ctx.json({ ok: true })
    }),
  },
}
