/**
 * referer 统计日志（原 analytics.util.refererStatLog：跨站 referer 打点，UA 解析）。
 */
import { logger } from "../../logger.js"

/** 极简 UA 解析（browser name/major + os name），避免引 ua-parser-js 重依赖 */
function parseUserAgent(ua: string): { browserName: string; browserMajor: string; osName: string } {
  const browser =
    /Edg\/(\d+)/.exec(ua) ??
    /Chrome\/(\d+)/.exec(ua) ??
    /Firefox\/(\d+)/.exec(ua) ??
    /Version\/(\d+)[\d.]* .*Safari/.exec(ua) ??
    /MSIE (\d+)/.exec(ua) ??
    /rv:(\d+)[\d.]*\)? Gecko/.exec(ua)
  const os =
    /Windows NT 10/.test(ua)
      ? "Windows"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X/.test(ua)
          ? "Mac OS"
          : /Android/.test(ua)
            ? "Android"
            : /iPhone|iPad|iOS/.test(ua)
              ? "iOS"
              : /Linux/.test(ua)
                ? "Linux"
                : ""
  return {
    browserName: browser ? (/Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Firefox/.test(ua) ? "Firefox" : /Safari/.test(ua) ? "Safari" : /MSIE|rv:/.test(ua) ? "IE" : "") : "",
    browserMajor: browser?.[1] ?? "",
    osName: os,
  }
}

export function refererStatLog(domain: string, req: Request): void {
  const referer = req.headers.get("referer") || ""
  let refDomain = ""
  try {
    refDomain = referer ? new URL(referer).hostname : ""
  } catch {
    return
  }
  if (!referer || domain === refDomain) return

  const ua = parseUserAgent(req.headers.get("user-agent") || "")
  logger.info({
    span: "referer",
    msg: "refererStatLog",
    domain,
    referer,
    ref_domain: refDomain,
    browserName: ua.browserName,
    browserVersion: ua.browserMajor,
    osName: ua.osName,
    href: req.headers.get("href") || "",
    path: new URL(req.url).pathname,
    secFetchSite: req.headers.get("sec-fetch-site") || "",
  })
}
