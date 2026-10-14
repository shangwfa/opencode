import { post, get, resultResolve } from "./request";

// 获取登录账号临时token
export function createJumpToken() {
  return post("/api/v1/user/token/createJumpToken").then(resultResolve);
}

// 代理token
export const proxyToken = () => {
  return post("/api/v1/proxy/token").then(resultResolve);
};

// 获取用户信息
export const getUserInfo = () => {
  return get("/api/v1/user/info/rich").then(resultResolve);
};
