import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

export const config = {
  matcher: [
    /*
     * 匹配所有路径，包括带 basePath 前缀的静态资源请求
     * 需要处理：/yddoc/_next/static/*, /yddoc/_next/image/*, /yddoc/favicon.ico 等
     */
    "/(.*)",
  ],
};

export async function middleware(req: NextRequest) {
  const url = req.nextUrl.clone();

  // 跳过不需要处理的路径
  if (
    url.pathname.startsWith("/_next/") ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/kb") || // 知识库产品路由:不经品牌别名解析
    url.pathname === "/favicon.ico" ||
    url.pathname === "/logo.svg" ||
    url.pathname.startsWith("/.well-known/")
  ) {
    return NextResponse.next();
  }

  // 过滤掉不需要的 query 参数
  if (!url.pathname.includes("/api/")) {
    const allowedKeys = [
      "productCode",
      "id",
      "from",
      "access_token",
      "keywords",
      "source",
      "link_source",
      "menuId",
      "referrer-source",
      "theme",
      "uiDesign",
    ];

    const filtered = new URLSearchParams();
    for (const [key, value] of url.searchParams) {
      if (allowedKeys.includes(key)) {
        filtered.set(key, value);
      }
    }
    url.search = filtered.toString();
  }

  // v2(多租户知识库):品牌别名解析已随旧品牌站下线,中间件仅保留
  // query 白名单与系统路径跳过;/kb/** 在上方提前返回
  return NextResponse.next();
}
