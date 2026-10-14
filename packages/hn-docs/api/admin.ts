/**
 * 该文件用来存放boss系统的接口，主要用来管理端做文档的管理
 */

import { post, get, deleteFetch, resultResolve } from "./request";
import type {
  ReqAddDraftParams,
  ReqBasicParams,
  ReqFileUploadParams,
  MenuInfo,
  SaveDocParams,
  ChangeOrderParams,
  GetMenuParams,
  MenuIdReq,
} from "./index.d";
import { RequestSource } from "./index.d";
import { env } from "@/utils/env";

const ENV_PATH = env.ENV === "private" ? "" : "/boss";

// 获取上传url
export function getUploadUrl(data: ReqFileUploadParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/oss/getUploadUrl`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 新增草稿
export function addDraft(data: ReqAddDraftParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/draft/add`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 删除草稿
export function deleteDraft(data: ReqBasicParams) {
  return deleteFetch(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/draft/delete`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 根据menuId删除草稿
export function deleteByMenuIdDraft(data: MenuIdReq) {
  return deleteFetch(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/draft/deleteByMenuId?menuId=${data.menuId}`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 更新草稿
export function updateDraft(data: ReqAddDraftParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/draft/update`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 查询草稿箱文档内容
export function queryAdminDraftContent(params: MenuIdReq) {
  return get(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/draft/queryByMenuId`,
    { params },
    RequestSource.BOSS
  ).then(resultResolve);
}

// 新增菜单
export function addMenu(data: MenuInfo) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/add`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 更新菜单
export function updateMenu(data: MenuInfo) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/update`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 删除菜单
export function deleteMenu(data: ReqBasicParams) {
  return deleteFetch(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/delete?id=${data.id}`,
    {},
    RequestSource.BOSS
  ).then(resultResolve);
}

//保存文档内容
export function saveDoc(data: SaveDocParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/save`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 调整菜单顺序
export function tuneUpOrder(data: ChangeOrderParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/tuneUpOrder`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 启用菜单
export function menuEnable(data: ReqBasicParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/enable`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 禁用菜单
export function menuDisable(data: ReqBasicParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/disable`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 查询菜单树
export function getAdminMenuTree(params: GetMenuParams) {
  return get(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/getAdminMenuTreeByBrandCode`,
    { params },
    RequestSource.BOSS
  ).then(resultResolve);
}

// 查询文档内容
export function queryDoc(params: ReqBasicParams) {
  return get(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/queryById`,
    { params },
    RequestSource.BOSS
  ).then(resultResolve);
}

// 获取环境配置
export function getDocEnvConfig(params: ReqBasicParams) {
  return get(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/envConfig/getDocEnvConfig`,
    { params },
    RequestSource.BOSS
  ).then(resultResolve);
}

export interface ReqDocEnvConfigParams {
  aliasList: string[];
  docId: string;
}
// 修改别名
export function updateAlias(data: ReqDocEnvConfigParams) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/alias/update`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}

// 根据文档id查询别名
export function getDocAliasById(params: { docId: string }) {
  return get(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/alias/listByDocId`,
    { params },
    RequestSource.BOSS
  ).then(resultResolve);
}

// 根据品牌查询所属产品下所有环境
export function queryAllDocEnvByBrandCode(params: { brandCode: string }) {
  return get(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/envConfig/queryAllDocEnvByBrandCode`,
    { params },
    RequestSource.BOSS
  ).then(resultResolve);
}

export interface ReqSyncParams {
  docMenuId: string;
  sourceDocEnvConfigId: string;
  targetDocEnvConfigIds: string[];
}

// 同步文档到其它语言
export function contentSync(data: {
  sourceDocEnvConfigId: string;
  docMenuId: string;
  targetDocEnvConfigIdList: string[];
}) {
  return post(
    `${ENV_PATH}/api/v3/cornerstone/helpdoc/menu/sync`,
    data,
    RequestSource.BOSS
  ).then(resultResolve);
}
