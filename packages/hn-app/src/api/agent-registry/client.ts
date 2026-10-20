import type {
  AgentRegistryItem,
  AgentRegistryListResult,
  CreateAgentRegistryBody,
  ListAgentRegistryParams,
  UpdateAgentRegistryBody,
} from "./types";
import {
  requirementApiFetch,
  requirementApiBase,
} from "@/api/requirement/client";

const AGENT_REGISTRY_PREFIX = `${requirementApiBase}/agent-registry`;

/**
 * 获取 Agent Registry 列表（分页）
 * GET /agent-registry?keyword=xxx&source=market&page=1&pageSize=20
 *
 * 响应: AgentRegistryListResult
 */
export async function fetchAgentRegistryList(
  params?: ListAgentRegistryParams | string,
): Promise<AgentRegistryListResult> {
  const url = new URL(AGENT_REGISTRY_PREFIX, window.location.origin);
  const p: ListAgentRegistryParams | undefined =
    typeof params === "string" ? { keyword: params } : params;
  if (p?.keyword?.trim()) {
    url.searchParams.set("keyword", p.keyword.trim());
  }
  if (p?.creator_uuid?.trim()) {
    url.searchParams.set("creator_uuid", p.creator_uuid.trim());
  }
  if (p?.is_public !== undefined) {
    url.searchParams.set("is_public", String(p.is_public));
  }
  if (p?.source?.trim()) {
    url.searchParams.set("source", p.source.trim());
  }
  if (p?.page !== undefined) {
    url.searchParams.set("page", String(p.page));
  }
  if (p?.pageSize !== undefined) {
    url.searchParams.set("pageSize", String(p.pageSize));
  }
  const res = await requirementApiFetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`获取 Agent 列表失败: ${res.status} ${text}`);
  }
  const data = await res.json();
  // 兼容旧版后端直接返回数组的情况
  if (Array.isArray(data)) {
    return { items: data as AgentRegistryItem[], total: data.length, page: p?.page ?? 1, pageSize: data.length };
  }
  return data as AgentRegistryListResult;
}

/**
 * 获取单个 Agent 详情
 * GET /agent-registry/{name}
 */
export async function fetchAgentRegistryItem(
  name: string,
): Promise<AgentRegistryItem | null> {
  const res = await requirementApiFetch(
    `${AGENT_REGISTRY_PREFIX}/${encodeURIComponent(name)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`获取 Agent 详情失败: ${res.status} ${text}`);
  }
  return (await res.json()) as AgentRegistryItem;
}

/**
 * 按 id 获取单个 Agent 详情
 * GET /agent-registry/by-id/{id}
 */
export async function fetchAgentRegistryItemById(
  id: string,
): Promise<AgentRegistryItem | null> {
  const trimmed = id.trim();
  if (!trimmed) return null;
  const res = await requirementApiFetch(
    `${AGENT_REGISTRY_PREFIX}/by-id/${encodeURIComponent(trimmed)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`获取 Agent 详情失败: ${res.status} ${text}`);
  }
  return (await res.json()) as AgentRegistryItem;
}

/**
 * 将项目配置中的 registry agent 引用解析为 OpenCode 需要的 agent name。
 * 新配置优先按 id 解析；id 未命中时兼容旧 name 配置。
 */
export async function resolveAgentRegistryNames(
  refs: readonly string[] | undefined,
): Promise<string[]> {
  const normalized: string[] = [];
  for (const ref of refs ?? []) {
    const trimmed = ref.trim();
    if (trimmed && !normalized.includes(trimmed)) normalized.push(trimmed);
  }

  const names: string[] = [];
  for (const ref of normalized) {
    const byId = await fetchAgentRegistryItemById(ref);
    const row = byId ?? await fetchAgentRegistryItem(ref);
    const name = row?.name?.trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * 创建 Agent
 * POST /agent-registry
 */
export async function createAgentRegistryItem(
  body: CreateAgentRegistryBody,
): Promise<AgentRegistryItem> {
  const res = await requirementApiFetch(AGENT_REGISTRY_PREFIX, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`创建 Agent 失败: ${res.status} ${text}`);
  }
  return (await res.json()) as AgentRegistryItem;
}

/**
 * 更新 Agent
 * PUT /agent-registry/{name}
 */
export async function updateAgentRegistryItem(
  name: string,
  body: UpdateAgentRegistryBody,
): Promise<AgentRegistryItem> {
  const res = await requirementApiFetch(
    `${AGENT_REGISTRY_PREFIX}/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`更新 Agent 失败: ${res.status} ${text}`);
  }
  return (await res.json()) as AgentRegistryItem;
}

/**
 * 删除 Agent
 * DELETE /agent-registry/{name}
 *
 * 成功返回 204，无返回体
 */
export async function deleteAgentRegistryItem(name: string): Promise<void> {
  const res = await requirementApiFetch(
    `${AGENT_REGISTRY_PREFIX}/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`删除 Agent 失败: ${res.status} ${text}`);
  }
}
