/**
 * 业务接入服务（boss harness）base URL。
 *
 * 需求列表 / 项目接入 / 仪表盘的数据不在 opencode SaaS 里，而在外部业务域
 * （`/boss/api/v3/harness`），因此必须知道其地址。
 * 来源优先级与 `utils/opencode-saas-base.ts` 的项目约定一致：
 *   1. 宿主注入 `window.YD.BOSS_API_URL`（源项目由部署平台注入，保持兼容）
 *   2. 构建期 `VITE_BOSS_API_URL`（独立部署时的配置入口）
 *   3. 未配置 → 空串，调用方据此给出可读提示，而不是让请求打到本地站点解析 HTML
 */
export function requirementApiBaseUrl(): string {
  if (import.meta.env.DEV && window.YD?.REQUIREMENT_API_USE_LOCAL) return "/local-requirement"
  const boss =
    (typeof window !== "undefined" ? window.YD?.BOSS_API_URL : undefined)?.trim().replace(/\/+$/, "") ||
    (import.meta.env.VITE_BOSS_API_URL as string | undefined)?.trim().replace(/\/+$/, "")
  return boss ? `${boss}/boss/api/v3/harness` : ""
}

export const requirementApiBase = requirementApiBaseUrl();

export function bossApiBaseUrl(): string {
  const boss =
    (typeof window !== "undefined" ? window.YD?.BOSS_API_URL : undefined)?.trim().replace(/\/+$/, "") ||
    (import.meta.env.VITE_BOSS_API_URL as string | undefined)?.trim().replace(/\/+$/, "")
  return boss ? `${boss}/boss/api/v3` : ""
}

export const bossApiBase = bossApiBaseUrl();

const PARENT_APP_ACCESS_TOKEN_KEY = "ACCESS_TOKEN";
const ACCESS_TOKEN_COOKIE_NAME = "test_accessToken";
const LOGIN_PAGE_BASE = "https://test-devops.shadow-rpa.net/login";

const indepentPaths = [
  '/project-intake',
  '/requirement-chat',
  '/free-chat',
]

function buildLoginUrl(): string {
  if (typeof window === "undefined") return LOGIN_PAGE_BASE;
  const redirectPath = (
    import.meta.env.VITE_LOGIN_REDIRECT_PATH as string | undefined
  )?.trim();
  const target = indepentPaths.some(path => window.location.pathname.includes(path))  ?  window.location.href : (redirectPath || window.location.href);
  try {
    const encoded = window.btoa(target).replace(/=+$/, "");
    return `${LOGIN_PAGE_BASE}?redirectPath=${encodeURIComponent(encoded)}`;
  } catch {
    return LOGIN_PAGE_BASE;
  }
}

function isConversationRoute(): boolean {
  if (typeof window === "undefined") return false;
  const path = window.location.pathname;
  return (
    path.includes("/requirement-chat/") ||
    path.includes("/free-chat") ||
    path.includes("/project-intake")
  );
}

export function redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const url = buildLoginUrl();
  // 在 iframe 中时应跳出 iframe，避免登录页嵌套在子应用里
  if (window.top && window.top !== window) {
    try {
      window.top.location.href = url;
      return;
    } catch {
      // 被 sandbox 限制时退回到当前 window
    }
  }
  window.location.href = url;
}

function bearerFromBareToken(raw: string): string {
  return `Bearer ${raw.trim()}`;
}

function readCookieValue(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const segments = document.cookie.split(";");
  for (const seg of segments) {
    const idx = seg.indexOf("=");
    if (idx === -1) continue;
    const k = seg.slice(0, idx).trim();
    if (k !== name) continue;
    let v = seg.slice(idx + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      /* keep as-is */
    }
    const t = v.trim();
    return t || undefined;
  }
  return undefined;
}

export function isAuthFromUserSession(): boolean {
  if (readCookieValue(ACCESS_TOKEN_COOKIE_NAME)) return true;
  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem(PARENT_APP_ACCESS_TOKEN_KEY)?.trim();
    if (raw) return true;
  }
  return false;
}

export class ApiUnauthorizedError extends Error {
  constructor(message = "登录已过期，请重新登录") {
    super(message);
    this.name = "ApiUnauthorizedError";
  }
}

/**
 * 接入服务未配置 / 未启动时，请求会被网关或 dev server 回退成 SPA 的 index.html，
 * 业务层 res.json() 会抛 `Unexpected token '<' ...`，对用户毫无意义。
 * 这里统一识别并转成可读原因（所有 harness API 共享此兜底）。
 */
export class ApiHtmlFallbackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiHtmlFallbackError";
  }
}

export function looksLikeHtml(res: Response): boolean {
  return (res.headers.get("content-type") ?? "").toLowerCase().includes("text/html");
}

export function describeHtmlFallback(input: string): string {
  // 未配置 base 时 URL 是相对路径（形如 /v2/requirements/all），必然打到当前站点
  if (!requirementApiBase || input.startsWith("/")) {
    return "需求数据服务未配置：请设置 VITE_BOSS_API_URL（或由宿主注入 window.YD.BOSS_API_URL）后重启"
  }
  return "需求数据服务无响应：请确认该服务已启动，且 VITE_BOSS_API_URL 指向正确"
}

function isUnauthorizedStatus(status: number): boolean {
  return status === 401;
}

function unauthorizedMessageFromBody(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  const msg = (data as { msg?: unknown }).msg;
  if (typeof msg === "string" && msg.trim()) return msg.trim();
  const message = (data as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) return message.trim();
  return undefined;
}

async function readUnauthorizedBody(res: Response): Promise<unknown | null> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    const data = (await res.clone().json()) as unknown;
    if (
      data != null &&
      typeof data === "object" &&
      ((data as { code?: unknown }).code === 401 ||
        (data as { code?: unknown }).code === "401")
    ) {
      return data;
    }
  } catch {
    /* 非 JSON 或解析失败时忽略 */
  }
  return null;
}

export function resolveRequirementApiAuthorization(): string | undefined {
  const fromCookie = readCookieValue(ACCESS_TOKEN_COOKIE_NAME);
  if (fromCookie) {
    localStorage.setItem(PARENT_APP_ACCESS_TOKEN_KEY, fromCookie);
    return bearerFromBareToken(fromCookie);
  }
  if (typeof localStorage !== "undefined") {
    const raw = localStorage.getItem(PARENT_APP_ACCESS_TOKEN_KEY)?.trim();
    if (raw) {
      return bearerFromBareToken(raw);
    }
  }
}

async function authorizedFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  const auth = resolveRequirementApiAuthorization();
  if (auth) {
    headers.set("Authorization", auth);
  }
  const res = await fetch(input, { ...init, headers });

  const unauthorizedBody = isUnauthorizedStatus(res.status)
    ? ({} as unknown)
    : await readUnauthorizedBody(res);
  if (unauthorizedBody != null) {
    // 只在对话页面触发登录跳转；非对话页面把 401 交给调用方处理
    if (isConversationRoute()) {
      redirectToLogin();
    }
    const message =
      unauthorizedMessageFromBody(unauthorizedBody) ||
      "登录已过期，请重新登录";
    throw new ApiUnauthorizedError(message);
  }

  // 成功响应却是 HTML：接入服务未配置/未启动，被网关或 dev server 回退成 SPA 首页。
  // 在这里拦下，避免业务层 res.json() 抛出 `Unexpected token '<'` 这种不可读错误。
  if (res.ok && looksLikeHtml(res)) {
    throw new ApiHtmlFallbackError(describeHtmlFallback(input));
  }

  return res;
}

export function requirementApiFetch(
  input: string,
  init?: RequestInit,
): Promise<Response> {
  return authorizedFetch(input, init);
}

/** 与 requirement API 同源 Node 服务时共用鉴权；Boss 管理端等其它 base 亦可用 */
export const bossApiFetch = requirementApiFetch;

export function errorFromJson(data: unknown, fallback: string): string {
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
  ) {
    return (data as { error: string }).error;
  }
  return fallback;
}
