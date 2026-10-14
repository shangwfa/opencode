/**
 * 文档平台 Open API 类型(原 lib/book-open types 演进)
 * v2:去品牌/多租户知识库模型 —— scope 由 brandCode+languageCode 变更为 kb;
 * 鉴权后置(决策 #4),OpenCaller 为占位身份
 */

export interface OpenCaller {
  /** 预留:鉴权接入后的调用方标识(Boss userUuid / API key id) */
  id?: string;
}

export interface OpenContext {
  caller: OpenCaller;
  /** 知识库 id(knowledge_bases.id) */
  kbId: string;
  /** 知识库 slug(公开地址段) */
  kbSlug: string;
  /** 知识库语言(单语言树) */
  languageCode: string;
  languageCodes: string[];
  envCode: string;
  canRead: true;
  canCreate: true;
  canUpdate: true;
  canEnable: true;
  canDelete: true;
}

export interface MenuNode {
  id: string;
  name: string;
  type: "folder" | "doc";
  menuTrees?: MenuNode[];
  iconUrl?: string;
  slug?: string;
  url?: string;
  enable?: boolean;
  parentId?: string | number;
  scope?: string;
  docUniqueId?: string;
  [key: string]: unknown;
}

/**
 * 文档记录(documents 行的契约投影)
 * contentKey v2 语义:dp://{docUniqueId}(正文入库,不再是 OSS key;保留字段兼容旧客户端)
 */
export interface DocumentRecord {
  menuId: string;
  docUniqueId: string;
  name: string;
  enable: boolean;
  contentKey?: string;
  contentType?: string;
  hasDraft?: boolean;
  draftId?: string;
  content?: unknown;
  [key: string]: unknown;
}

export interface UploadAddress {
  key: string;
  uploadUrl: string;
  readUrl?: string;
}

export interface KnowledgeTaskResult {
  taskId: string;
  [key: string]: unknown;
}
