/**
 * 文档平台(knowledge)接口封装
 * - 浏览器:相对路径 /api/doc-platform/**,经 next.config.js rewrite 代理到 knowledge 内网
 * - SSR(getServerSideProps):process.env.KNOWLEDGE_INTERNAL_URL 直连,不走代理
 * 响应契约:{ code, success, message, data }(knowledge 统一约定)
 */

import axios from "axios";

/** SSR 直连地址(knowledge 内网) */
export function knowledgeInternalBaseUrl(): string {
  return (
    process.env.KNOWLEDGE_INTERNAL_URL?.replace(/\/$/, "") ||
    "http://127.0.0.1:8787"
  );
}

/** 服务端直连(knowledge 内网) */
export async function kbFetch<T = any>(
  path: string,
  init?: RequestInit,
): Promise<T | null> {
  try {
    const res = await fetch(`${knowledgeInternalBaseUrl()}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      cache: "no-store",
    });
    const json = await res.json();
    if (json?.code === 200) return json.data as T;
    return null;
  } catch (error) {
    console.error("[docPlatform] kbFetch failed:", path, error);
    return null;
  }
}

// 4xx/5xx 也进 unwrap 统一解析(取后端 message,而非 axios 默认错误文案)
const http = axios.create({ baseURL: "/api/doc-platform", validateStatus: () => true });
/** 管理请求只经过基础服务，Cookie 复用同站点部署下的 better-auth 会话。 */
export const baseServiceUrl = (process.env.NEXT_PUBLIC_HN_BASE_URL || "http://localhost:3201").replace(/\/+$/, "");
const adminHttp = axios.create({ baseURL: `${baseServiceUrl}/api/doc-platform`, withCredentials: true, validateStatus: () => true });

interface KbResponse<T = any> {
  code: number;
  success: boolean;
  message?: string;
  data: T;
}

async function unwrap<T>(promise: Promise<{ data: KbResponse<T> }>): Promise<T> {
  const res = await promise;
  if (res.data?.code !== 200) {
    throw new Error(res.data?.message || `请求失败(${res.data?.code})`);
  }
  return res.data.data;
}

// ── 类型 ──

export interface MenuTreeNode {
  id: string;
  name: string;
  type: "folder" | "doc";
  iconUrl: string | null;
  slug: string | null;
  enable: boolean;
  docUniqueId: string | null;
  parentId: string | null;
  path: string[];
  menuTrees: MenuTreeNode[];
}

export interface KnowledgeBaseItem {
  id: string;
  name: string;
  slug: string;
  languageCode: string | null;
  description: string | null;
  isPublic: boolean;
  settings: Record<string, unknown>;
  modes: { mode: string; enabled: boolean }[];
  createdAt: string;
  updatedAt: string;
}

// ── 知识库 ──

export function listKnowledgeBases(): Promise<KnowledgeBaseItem[]> {
  return unwrap(adminHttp.get("/kb-admin/knowledge-bases"));
}

export function createKnowledgeBase(params: {
  name: string;
  slug: string;
  languageCode?: string;
  description?: string;
}): Promise<KnowledgeBaseItem> {
  return unwrap(adminHttp.post("/kb-admin/knowledge-bases", params));
}

export function deleteKnowledgeBase(kbId: string): Promise<null> {
  return unwrap(adminHttp.delete(`/kb-admin/knowledge-bases/${kbId}`));
}

export function setKnowledgeBasePublic(
  kbId: string,
  isPublic: boolean,
): Promise<KnowledgeBaseItem> {
  return unwrap(adminHttp.post(`/kb-admin/knowledge-bases/${kbId}/public`, { isPublic }));
}

// ── 菜单/文档 ──

export function getAdminMenuTree(kbId: string): Promise<MenuTreeNode[]> {
  return unwrap(adminHttp.get(`/kb-admin/knowledge-bases/${kbId}/menus/tree`, { params: { includeDisabled: 1 } }));
}

export function createMenu(
  kbId: string,
  params: { name: string; type: "folder" | "doc"; parentId?: string | null; previousId?: string | null },
): Promise<{ id: string }> {
  return unwrap(adminHttp.post(`/kb-admin/knowledge-bases/${kbId}/menus`, params));
}

export function deleteMenu(kbId: string, menuId: string): Promise<null> {
  return unwrap(adminHttp.delete(`/kb-admin/knowledge-bases/${kbId}/menus/${menuId}`));
}

export function setMenuEnable(kbId: string, menuId: string, enable: boolean): Promise<null> {
  return unwrap(adminHttp.post(`/kb-admin/knowledge-bases/${kbId}/menus/${menuId}/${enable ? "enable" : "disable"}`));
}

export function reorderMenu(
  kbId: string,
  params: { menuId: string; targetParentId: string | null; targetPreviousId: string | null },
) {
  return unwrap(adminHttp.post(`/kb-admin/knowledge-bases/${kbId}/menus/reorder`, params));
}

export interface AdminDocument {
  id: string;
  menuId: string | null;
  contentType: string;
  draftContentJson: unknown;
  contentJson: unknown;
  content: string;
  status: string;
  publishedAt: string | null;
  updatedAt: string;
}

export function getAdminDocument(kbId: string, menuId: string): Promise<AdminDocument> {
  return unwrap(adminHttp.get(`/kb-admin/knowledge-bases/${kbId}/documents/${menuId}`));
}

export function saveDraft(
  kbId: string,
  menuId: string,
  params: { contentJson: unknown; contentType?: string },
): Promise<AdminDocument> {
  return unwrap(adminHttp.put(`/kb-admin/knowledge-bases/${kbId}/documents/${menuId}/draft`, params));
}

export function publishDocument(
  kbId: string,
  menuId: string,
  params: { contentJson: unknown; contentType?: string; plainTextContent?: string },
): Promise<AdminDocument> {
  return unwrap(adminHttp.post(`/kb-admin/knowledge-bases/${kbId}/documents/${menuId}/publish`, params));
}

// ── 公开搜索(智能检索,rag 混合检索) ──

export interface SearchHit {
  menuId: string;
  name: string;
  path: string[];
  snippet: string;
  score: number;
}

export interface SearchPublicResult {
  total: number;
  page: number;
  pageSize: number;
  items: SearchHit[];
  kb: string;
  kbName: string;
}

export function searchKb(
  kbSlug: string,
  params: { q: string; page?: number; pageSize?: number },
): Promise<SearchPublicResult> {
  return unwrap(http.post(`/kb/${encodeURIComponent(kbSlug)}/search`, params));
}
