import axios from "axios";

import type { MenuData } from "@/api/index.d";
import { MenuItemType } from "@/api/index.d";
import { queryAllDocEnvByBrandCode } from "@/api/admin";
import { env } from "@/utils/env";

export type KnowledgeSyncOperation =
  | "upsertDocument"
  | "deleteDocument"
  | "batchUpsertDocuments"
  | "batchDeleteDocuments";

export interface KnowledgeSyncDocument {
  docUniqueId: string;
  menuId?: string;
  name?: string;
  content?: unknown;
  force?: boolean;
  docPath?: string;
  parentPath?: string;
  metadata?: Record<string, unknown>;
}

export interface CreateKnowledgeSyncTaskParams {
  brandCode: string;
  languageCode: string;
  operation: KnowledgeSyncOperation;
  documents: KnowledgeSyncDocument[];
  name?: string;
}

export interface KnowledgeSyncTaskResponse {
  code: number;
  success: boolean;
  message: string;
  data: {
    taskId: string;
    knowledgeBaseId: string;
    operation: KnowledgeSyncOperation;
    documentCount: number;
    status: string;
  };
}

function getNodeAiBaseUrl() {
  const baseUrl = env.YDDOC_API_URL?.replace(/\/$/, "");
  if (!baseUrl) {
    throw new Error("NEXT_PUBLIC_YDDOC_API_URL is not configured");
  }
  return baseUrl;
}

export function canCreateKnowledgeSyncTask() {
  return env.ENV !== "private";
}

interface DocEnvConfigItem {
  brandCode: string;
  brandName: string;
  languageCode: string;
  languageName: string;
}

/**
 * 获取知识库名（规则：品牌名-语言中文名，如"影刀 AI 国内版-简体中文"）
 * 查询失败或未匹配到环境信息时返回 undefined，不阻断同步流程（由服务端按默认规则命名）
 */
export async function getKnowledgeBaseName(
  brandCode: string,
  languageCode: string,
): Promise<string | undefined> {
  if (!canCreateKnowledgeSyncTask()) return undefined;
  try {
    const response = await queryAllDocEnvByBrandCode({ brandCode });
    const envList = (
      Array.isArray(response?.data) ? response.data : []
    ) as DocEnvConfigItem[];
    const matched = envList.find(
      (item) =>
        item.brandCode === brandCode && item.languageCode === languageCode,
    );
    if (matched?.brandName && matched?.languageName) {
      return `${matched.brandName}-${matched.languageName}`;
    }
    console.warn("未匹配到品牌语言环境信息，知识库同步使用默认命名", {
      brandCode,
      languageCode,
    });
    return undefined;
  } catch (error) {
    console.warn("查询品牌语言环境信息失败，知识库同步使用默认命名", error);
    return undefined;
  }
}

export async function createKnowledgeSyncTask(params: CreateKnowledgeSyncTaskParams) {
  if (!canCreateKnowledgeSyncTask()) {
    console.info("当前环境不创建知识库同步任务，已跳过", {
      brandCode: params.brandCode,
      languageCode: params.languageCode,
      env: env.ENV,
    });
    return null;
  }

  const response = await axios.post<KnowledgeSyncTaskResponse>(
    `${getNodeAiBaseUrl()}/knowledge-base/sync-from-doc-platform`,
    params,
  );
  return response.data;
}

export function collectDocumentNodes(node: MenuData): MenuData[] {
  if (node.type === MenuItemType.DOC) {
    return [node];
  }

  return (node.menuTrees || []).flatMap((child) => collectDocumentNodes(child));
}

export function findMenuNodeById(menus: MenuData[] | undefined, id?: string): MenuData | undefined {
  if (!menus?.length || !id) {
    return undefined;
  }

  for (const menu of menus) {
    if (menu.id === id) {
      return menu;
    }

    const child = findMenuNodeById(menu.menuTrees, id);
    if (child) {
      return child;
    }
  }

  return undefined;
}

export function getMenuPath(
  menus: MenuData[] | undefined,
  id?: string,
): { docPath?: string; parentPath?: string } {
  if (!menus?.length || !id) {
    return {};
  }

  const traverse = (
    nodes: MenuData[],
    parentNames: string[],
  ): { docPath?: string; parentPath?: string } | undefined => {
    for (const node of nodes) {
      const currentPath = [...parentNames, node.name];
      if (node.id === id) {
        return {
          docPath: currentPath.join("/"),
          parentPath: parentNames.join("/"),
        };
      }

      const result = traverse(node.menuTrees || [], currentPath);
      if (result) {
        return result;
      }
    }

    return undefined;
  };

  return traverse(menus, []) || {};
}

export function toDeleteSyncDocument(node: MenuData): KnowledgeSyncDocument {
  return {
    docUniqueId: node.docUniqueId,
    menuId: node.id,
    name: node.name,
  };
}
