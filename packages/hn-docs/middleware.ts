import { verifyUrl } from "@/utils/verifyUrl";
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

  // 获取请求的 IP 地址
  const ip = req.headers.get("x-forwarded-for") || req.ip || "unknown";

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

  console.log("pathname--->>>", url.pathname, "ip--->>>", ip);
  const redirectPath = await verifyUrl(url.pathname);
  console.log("redirectPath--->>>", redirectPath);
  if (redirectPath) {
    // 保存当前的查询参数
    const searchParams = url.searchParams.toString();
    url.pathname = redirectPath;
    // 确保查询参数被保留
    if (searchParams) {
      url.search = searchParams;
    }

    return NextResponse.redirect(url);
  }

  // 如果不需要重定向，继续正常处理
  return NextResponse.next();
}
