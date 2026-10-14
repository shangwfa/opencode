export interface BossIdentity {
  token: string;
  userUuid: string;
  roleCodeList: string[];
}

export type BrandRole = "admin" | "brand_admin" | "brand_edit";

export interface PermissionContext {
  identity: BossIdentity;
  brandCode: string;
  languageCode: string;
  docBrandId: string;
  envCode: string;
  languageCodes: string[];
  brandRole?: BrandRole;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canEnable: boolean;
  canDelete: boolean;
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

export interface EnvContext {
  docBrandId: string;
  envCode: string;
  languageCodes: string[];
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
