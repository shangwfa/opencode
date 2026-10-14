import type { TreeDataNode } from "antd";
export interface ReqAddDraftParams {
  contentType: string;
  menuId: string;
  content: string;
}

export interface ReqBasicParams {
  id: string;
}

export enum RequestSource {
  BOSS = "boss",
  RPA = "rpa",
}

// 文件类型，doc：文档文件，doc_asset：文档资产，product_asset：产品资产
export enum FileType {
  DOC = "doc",
  DOC_ASSET = "doc_asset",
  PRODUCT_ASSET = "product_asset",
}

export interface ReqFileUploadParams {
  fileName: string;
  fileType: FileType;
  envCode: string;
  fileSize: number;
  menuId?: string;
}

// 目录类型，folder/doc
export enum MenuItemType {
  FOLDER = "folder",
  DOC = "doc",
}

export interface MenuInfo {
  brandCode: string;
  languageCode: string;
  name: string;
  type: MenuItemType;
  id?: string;
  contentKey?: string;
  iconUrl?: string;
  parentId?: string;
  previousId?: string;
}

export interface SaveDocParams {
  menuId: string;
  contentType: string;
  content: string;
  plainTextContent: string;
}

export interface ChangeOrderParams {
  id: string;
  targetPreviousId: string;
  targetParentId: string;
}

export interface GetMenuParams {
  brandCode: string;
  languageCode: string;
}

export interface ResBasic<T> {
  code: number;
  data: T;
  message?: string;
}

export interface MenuData {
  id: string; //文档唯一标识
  name: string;
  type: MenuItemType;
  menuTrees: TreeNode[];
  iconUrl: string;
  slug: string;
  url: string;
  enable: boolean;
  parentId: number;
  scope: string;
  docUniqueId: string; // 文档统一id
}

export interface MenuIdReq {
  menuId: string;
}

interface TreeNode extends TreeDataNode, MenuData {}

export enum Version {
  V4 = "v4",
}
