/**
 * 文档平台(doc-platform)类型定义
 */

export type MenuItemType = "folder" | "doc"
export type KbMode = "rag" | "llm-wiki" | "graph-rag"

/** 菜单树节点(出参形状对齐前端 MenuData 语义) */
export interface MenuTreeNode {
  id: string
  name: string
  type: MenuItemType
  iconUrl: string | null
  slug: string | null
  enable: boolean
  docUniqueId: string | null
  parentId: string | null
  /** 根到当前节点的名称路径(公开地址面包屑用) */
  path: string[]
  menuTrees: MenuTreeNode[]
}

export interface CreateKbRequest {
  name: string
  slug: string
  languageCode?: string
  description?: string
  /** 检索模式集合,默认 ['rag'];当前仅支持 rag */
  modes?: KbMode[]
}

export interface UpdateKbRequest {
  name?: string
  slug?: string
  languageCode?: string
  description?: string
  isPublic?: boolean
  settings?: Record<string, unknown>
}

export interface CreateMenuRequest {
  name: string
  type: MenuItemType
  parentId?: string | null
  previousId?: string | null
  iconUrl?: string | null
  slug?: string | null
}

export interface ReorderMenuRequest {
  menuId: string
  targetParentId: string | null
  targetPreviousId: string | null
}

export interface SaveDraftRequest {
  contentJson: unknown
  contentType?: string
}

export interface PublishDocumentRequest {
  contentJson: unknown
  contentType?: string
  /** 前端可传纯文本;缺省时服务端从 contentJson 提取 */
  plainTextContent?: string
}

/** 业务错误:routes 层映射为 HTTP 状态码 */
export class DocPlatformError extends Error {
  code:
    | "VALIDATION_ERROR"
    | "NOT_FOUND"
    | "CONFLICT"
    | "UNSUPPORTED_MODE"

  constructor(code: DocPlatformError["code"], message: string) {
    super(message)
    this.code = code
  }
}
