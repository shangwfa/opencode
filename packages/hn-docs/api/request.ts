import axios from "axios";
import { getUrlParams } from "@/utils";
import { getCookie } from "@/utils/cookie";
import { init as initBridge } from "@/utils/native-bridge";
import { RequestSource } from "./index.d";
import { message } from "antd";
import { getLang } from "@/utils/getLang";
import { env } from "@/utils/env";

let token = getUrlParams("access_token") || getCookie("token");

export const hasLogged = !!token;
hasLogged &&
  (axios.defaults.headers.common["Authorization"] = `Bearer ${token}`);

const getRequestUrl = (source: RequestSource | undefined) => {
  const baseUrl = source === RequestSource.BOSS ? env.BOSS_URL : env.BASE_URL;
  console.log(baseUrl, "----------baseUrl--------");
  // 确保返回有效的 URL，如果环境变量未设置则返回空字符串
  return baseUrl || "";
};

const queryToken = async () => {
  if (!typeof window || typeof window === "undefined")
    return Promise.resolve("");
  if (getUrlParams("from") === RequestSource.BOSS) {
    return Promise.resolve(token);
  }
  try {
    const { javascriptBinding } = await initBridge();
    const sysToken = (await javascriptBinding?.getToken?.()) || "";
    return sysToken;
  } catch (error) {
    return "";
  }
};

export const get = (url: string, options?: any, source?: RequestSource) => {
  let requestUrl = getRequestUrl(source);
  // 如果 requestUrl 为空，使用 BASE_URL 作为后备
  if (!requestUrl) {
    requestUrl = env.BASE_URL || "";
  }

  // 拼接 URL
  const fullUrl = requestUrl + url;
  console.log(fullUrl, "------->>url<<---");

  // 如果最终 URL 仍然无效，抛出错误
  if (
    !fullUrl ||
    (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://"))
  ) {
    console.error(
      "Invalid URL:",
      fullUrl,
      "BASE_URL:",
      env.BASE_URL,
      "BOSS_URL:",
      env.BOSS_URL
    );
    return Promise.reject(
      new Error(
        `Invalid request URL: ${fullUrl}. Please check environment variables.`
      )
    );
  }

  return queryToken().then((token: string) => {
    token &&
      (axios.defaults.headers.common["Authorization"] = `Bearer ${token}`);
    return axios.get(fullUrl, options);
  });
};

export const post = (url: string, options?: any, source?: RequestSource) => {
  let requestUrl = getRequestUrl(source);
  if (!requestUrl) {
    requestUrl = env.BASE_URL || "";
  }
  url = requestUrl + url;

  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    console.error("Invalid URL:", url);
    return Promise.reject(
      new Error(
        `Invalid request URL: ${url}. Please check environment variables.`
      )
    );
  }

  return queryToken().then((token: string) => {
    token &&
      (axios.defaults.headers.common["Authorization"] = `Bearer ${token}`);
    return axios.post(url, options);
  });
};

export const deleteFetch = (
  url: string,
  options?: any,
  source?: RequestSource
) => {
  let requestUrl = getRequestUrl(source);
  if (!requestUrl) {
    requestUrl = env.BASE_URL || "";
  }
  url = requestUrl + url;

  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    console.error("Invalid URL:", url);
    return Promise.reject(
      new Error(
        `Invalid request URL: ${url}. Please check environment variables.`
      )
    );
  }

  return queryToken().then((token: string) => {
    token &&
      (axios.defaults.headers.common["Authorization"] = `Bearer ${token}`);
    return axios.delete(url, options);
  });
};

export const resultResolve = (res: any) => {
  if (res.data.code !== 200) {
    if (res.data.code === 401) {
      message.error(getLang("login_has_expired"));
    } else {
      // 有token为管理端，抛出异常
      token && message.error(res.data.msg);
    }
  }
  return res.status === 200 ? res.data : { code: res.status || 500, msg: "" };
};
