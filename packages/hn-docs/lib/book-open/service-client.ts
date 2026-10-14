/**
 * BookDocumentService 的远程(HTTP)实现 —— M2c 迁移后的壳客户端。
 *
 * 与 v1 本地实现同签名:rest.ts / mcp.ts 仅需切换 import,调用方零改动。
 * 后端:knowledge /api/doc-platform/open/**(路径以 kb 为 scope,v1 的 brandCode
 * 语义由调用方直接作为 kb 引用传递;languageCode 由知识库自身属性决定,下发前剥除)。
 */
import axios, { type AxiosRequestConfig } from "axios";
import { asBookOpenError, BookOpenError } from "./errors";
import type {
  CreateDocumentInput,
  CreateResourceUploadInput,
  DeleteDocumentInput,
  DocumentTreeInput,
  GetBlockInput,
  GetDocumentInput,
  SetDocumentEnabledInput,
  UpdateBlockInput,
  UpdateDocumentInput,
} from "./schemas";
import type { BossIdentity } from "./types";

/** 服务端内网地址(SSR/API 路由运行时) */
function knowledgeBaseUrl(): string {
  return (
    process.env.KNOWLEDGE_INTERNAL_URL?.replace(/\/$/, "") ||
    "http://127.0.0.1:8787"
  );
}

/** v1 scope 字段 → v2 kb 路径参数;languageCode 不下发(库属性) */
function toKbScope<T extends { brandCode?: string; languageCode?: string }>(
  input: T,
): { kb: string; rest: Omit<T, "brandCode" | "languageCode"> } {
  const { brandCode, languageCode, ...rest } = input as Record<string, unknown>;
  const kb = (brandCode ?? (input as any).kb) as string;
  if (!kb) throw new BookOpenError("VALIDATION_ERROR", "缺少知识库标识(brandCode/kb)");
  return { kb, rest: rest as Omit<T, "brandCode" | "languageCode"> };
}

export class BookDocumentService {
  constructor(private readonly identity: BossIdentity) {}

  private async call<T extends Record<string, unknown>>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    kb: string,
    path: string,
    options: { query?: Record<string, string | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const query = Object.fromEntries(
      Object.entries(options.query ?? {}).filter(([, v]) => v !== undefined),
    );
    const config: AxiosRequestConfig = {
      method,
      url: `${knowledgeBaseUrl()}/api/doc-platform/open/${encodeURIComponent(kb)}${path}`,
      params: query,
      data: options.body,
      headers: {
        // 鉴权后置:透传调用方 Bearer(当前服务端不校验,插槽已备)
        ...(this.identity.token
          ? { Authorization: `Bearer ${this.identity.token}` }
          : {}),
        "Content-Type": "application/json",
      },
      timeout: 30_000,
      // 知识库统一响应 { code, success, message, data / error };HTTP 状态与业务码一致
      validateStatus: () => true,
    };
    const res = await axios.request(config);
    const payload = res.data ?? {};
    if (res.status === 200 && payload.code === 200) {
      return payload.data as T;
    }
    const errorCode = payload.error?.code ?? "UPSTREAM_ERROR";
    throw new BookOpenError(errorCode, payload.message || "knowledge 调用失败", {
      ...(payload.error ?? {}),
      httpStatus: res.status,
    });
  }

  async listDocuments(input: DocumentTreeInput): Promise<Record<string, unknown>> {
    const { kb } = toKbScope(input);
    return this.call("GET", kb, "/documents/tree");
  }

  async getDocument(input: GetDocumentInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    const { docUniqueId, version } = rest as any;
    return this.call("GET", kb, `/documents/${encodeURIComponent(docUniqueId)}`, {
      query: { version },
    });
  }

  async getBlock(input: GetBlockInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    const { docUniqueId, blockId, version } = rest as any;
    return this.call(
      "GET",
      kb,
      `/documents/${encodeURIComponent(docUniqueId)}/blocks/${encodeURIComponent(blockId)}`,
      { query: { version } },
    );
  }

  async createDocument(input: CreateDocumentInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    return this.call("POST", kb, "/documents", { body: rest });
  }

  async updateDocument(input: UpdateDocumentInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    const { docUniqueId, ...body } = rest as any;
    return this.call("PATCH", kb, `/documents/${encodeURIComponent(docUniqueId)}`, { body });
  }

  async updateBlock(input: UpdateBlockInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    const { docUniqueId, blockId, ...body } = rest as any;
    return this.call(
      "PATCH",
      kb,
      `/documents/${encodeURIComponent(docUniqueId)}/blocks/${encodeURIComponent(blockId)}`,
      { body },
    );
  }

  async setDocumentEnabled(input: SetDocumentEnabledInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    const { docUniqueId, ...body } = rest as any;
    return this.call("PUT", kb, `/documents/${encodeURIComponent(docUniqueId)}/enabled`, { body });
  }

  async deleteDocument(input: DeleteDocumentInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    const { docUniqueId } = rest as any;
    return this.call("DELETE", kb, `/documents/${encodeURIComponent(docUniqueId)}`);
  }

  async createResourceUpload(input: CreateResourceUploadInput): Promise<Record<string, unknown>> {
    const { kb, rest } = toKbScope(input);
    return this.call("POST", kb, "/resource-upload-sessions", { body: rest });
  }
}

// 保持 axios 单实例语义,避免未使用告警
void axios;
