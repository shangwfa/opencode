import { get, resultResolve } from "./request";

export function getEnterpriseClassInfo() {
  return get("/api/college/v1/user/getEnterpriseClassInfo").then(resultResolve);
}

export function getUserInfo() {
  return get("/api/v1/user/info/rich").then(resultResolve);
}

// 提供已报名的学院用户学习信息
export function learnProgressInfo() {
  return get(`/api/college/v1/client/getClientLearnStatus`).then(resultResolve);
}

// 获取学院学员动态
export function bookMessageList(params: {
  classInfoUuid: string;
  textBookRecordUuid: string;
}) {
  return get(`/api/college/v1/book/messageList`, { params }).then(
    resultResolve
  );
}

// 查询当前已报名的企业班级
export function userClassInfo(params: { classInfoUuid: string }) {
  return get(`/api/college/v1/user/getUserClassInfo`, { params }).then(
    resultResolve
  );
}

export function getNewClientLearnStatus() {
  return get("/api/college/v1/client/getNewClientLearnStatus").then(
    resultResolve
  );
}
