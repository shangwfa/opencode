import { post, get, resultResolve } from "./request";
import type { Version } from "./index.d";

// 获取登录账号临时token
export function createJumpToken() {
  return post("/api/v1/user/token/createJumpToken").then(resultResolve);
}
// 搜索联想
export function helpDocTips(params: {
  key: string;
  productCode: string;
  version: Version;
}) {
  return get(`/api/noauth/v1/sys/fullIndex/helpDoc/tips`, { params }).then(
    resultResolve
  );
}

// 获取场景数据源
export function getListBySceneCode(params: { sceneCodes: string }) {
  return get(`/api/v1/sys/sceneDataSource/listBySceneCode`, { params }).then(
    resultResolve
  );
}

// 获取场景数据源
export function getSearch(params: {
  productCode;
  version: Version;
  page: number;
  size: number;
  key?: string;
  source?: string;
}) {
  return get(`/api/noauth/v1/sys/fullIndex/search`, { params }).then(
    resultResolve
  );
}

// 埋点
export function recordLogs(params: { spm: string; tags: string }) {
  return get(`/api/noauth/v1/sys/spm/record/log`, { params }).then(
    resultResolve
  );
}

export function getSearchNew(params: {
  productCode;
  version: Version;
  page: number;
  size: number;
  key?: string;
  source?: string;
}) {
  return get(`/api/noauth/v1/sys/fullIndex/searchNew`, { params }).then(
    resultResolve
  );
}
