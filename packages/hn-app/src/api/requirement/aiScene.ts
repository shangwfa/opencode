import { bossApiFetch } from "./client";

export type AiSceneResourceType = "SKILL" | "COMMAND" | "COMPOSITION";

export type AiSceneResource = {
  id?: string | number;
  title?: string;
  description?: string;
  usageScenarios?: string;
  type?: AiSceneResourceType;
  fileLink?: string;
  linkedMaterials?: string[];
};

function unwrapAiScenePayload<T>(raw: T | { data?: T }): T {
  if (raw && typeof raw === "object" && "data" in raw) {
    const wrapped = raw as { data?: T };
    if (wrapped.data !== undefined) return wrapped.data;
  }
  return raw as T;
}

/** 安全文件夹/文件名（与 CLI skills 命令对齐） */
export function safeAiSceneFolderName(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, "_").trim() || "resource";
}

export async function getAiSceneList(params?: {
  sceneType?: string;
  type?: "SKILL" | "COMMAND" | "COMPOSITION";
}): Promise<AiSceneResource[]> {
  const search = new URLSearchParams();
  if (params?.sceneType) search.set("sceneType", params.sceneType);
  if (params?.type) search.set("type", params.type);
  const qs = search.toString();
  const url = `https://staging-logs.yingdao.com/platform/ai-scene${qs ? `?${qs}` : ""}`;
  const res = await bossApiFetch(url);
  if (!res.ok) throw new Error("获取 AI 场景列表失败");
  const raw = (await res.json()) as
    | AiSceneResource[]
    | { data?: AiSceneResource[] };
  return Array.isArray(raw) ? raw : (raw?.data ?? []);
}

export async function getAiSceneById(id: string): Promise<AiSceneResource> {
  const trimmed = id.trim();
  if (!trimmed) throw new Error("资源 id 不能为空");
  const url = `https://staging-logs.yingdao.com/platform/ai-scene/${encodeURIComponent(trimmed)}`;
  const res = await bossApiFetch(url);
  if (res.status === 404) throw new Error("资源不存在");
  if (!res.ok) throw new Error(`获取 AI 场景详情失败 (${res.status})`);
  const raw = (await res.json()) as AiSceneResource | { data?: AiSceneResource };
  return unwrapAiScenePayload(raw);
}

/** 将本地文件夹名、标题或平台 id 解析为平台资源 id */
export async function resolvePlatformSkillId(
  nameOrId: string,
  list?: AiSceneResource[],
): Promise<string | null> {
  const trimmed = nameOrId.trim();
  if (!trimmed) return null;
  try {
    await getAiSceneById(trimmed);
    return trimmed;
  } catch {
    // 非 id 或不存在，改从列表按标题/文件夹名匹配
  }
  const items = list ?? (await getAiSceneList());
  for (const item of items) {
    const id = item.id != null ? String(item.id) : "";
    if (!id) continue;
    if (id === trimmed) return id;
    const title = (item.title ?? "").trim();
    if (title && title === trimmed) return id;
    if (title && safeAiSceneFolderName(title) === trimmed) return id;
  }
  return null;
}

export function aiScenesToTemplateMeta(
  list: AiSceneResource[],
): { id: string; title: string; description: string }[] {
  return list.flatMap((item) => {
    const id = item.title?.trim() ?? "";
    if (!id) return [];
    return [
      {
        id,
        title: id,
        description: item.description?.trim()
          ? String(item.description)
          : `模版 ${item.id ?? ""}`,
      },
    ];
  });
}
