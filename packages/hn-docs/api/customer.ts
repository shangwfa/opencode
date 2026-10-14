/**
 * 该文件用来存放用户端文档相关接口
 */

import { post, get, resultResolve } from "./request";
import { RequestSource } from "./index.d";

// 根据产品编码，获取目录树
export function queryMenusTrees(params: {
  brandCode: string;
  languageCode: string;
}) {
  return get("/api/noauth/v1/yddoc/menus/getMenuTreeByBrandCode", {
    params,
  }).then(resultResolve);
}

// 根据菜单id，获取文档内容
export function queryDocContent(params: { menuId: string }) {
  return get(`/api/noauth/v1/yddoc/menus/${params.menuId}/contents`).then(
    resultResolve
  );
}

// 获取文件存储域名
export function queryOssDomain() {
  return get(`/api/noauth/v1/yddoc/oss/domain`).then(resultResolve);
}

// 根据产品编码，获取产品信息
export function queryProductInfo(params: { productCode: string }) {
  return get(
    `/api/noauth/v1/yddoc/products/${params.productCode}`,
    {},
    RequestSource.RPA
  ).then(resultResolve);
}

//  获取oem信息
export function queryOemInfo() {
  return get(`/api/noauth/v1/ep/config/queryOem`, {}, RequestSource.RPA).then(
    resultResolve
  );
}

// 获取环境配置
export function queryDocEnvConfig(params: {
  brandCode: string;
  languageCode?: string;
}) {
  return get(`/api/noauth/v1/yddoc/envConfig/queryByBrandCodeAndLanguageCode`, {
    params,
  }).then(resultResolve);
}

// 根据别名查询文档id
export function queryDocIdByAlias(params: { alias: string }) {
  return get(`/api/v3/cornerstone/helpdoc/alias/queryDocIdByAlias`, {
    params,
  }).then(resultResolve);
}
