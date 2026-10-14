import { setCookie } from "./cookie";
import { recordLogs } from "@/api/public";

export function initConfig() {
  if (!typeof window || typeof window === "undefined") return;
  const accessToken = getUrlParams("access_token");
  if (accessToken) {
    setCookie("token", accessToken);
  }
}

/**
 * 获取url参数
 * @param key
 * @param targetUrl
 * @returns
 */
export const getUrlParams = (key: string, targetUrl = undefined) => {
  let query = "";
  if (targetUrl && targetUrl.split("?")) {
    query = targetUrl.split("?")[1] || "";
  } else if (typeof window !== "undefined" && window.location.search) {
    query = window.location.search.substring(1);
  }
  let vars = query?.split("&") || [];
  for (let i = 0; i < vars.length; i++) {
    let pair = vars[i].split("=");
    if (pair[0] == key) {
      return decodeURIComponent(pair[1]);
    }
  }
  return "";
};
/**
 * 唤起客户端快速发帖
 * @param key
 */
export const ShowPublishErrorWindow = async (key: string) => {
  if (window.CefSharp) {
    await CefSharp.BindObjectAsync("javascriptBinding");
    if (typeof javascriptBinding.showPublishErrorWindow != "undefined") {
      javascriptBinding.showPublishErrorWindow(key);
    } else {
      window.open("https://www.yingdao.com/community/discuss/", "__blank");
    }
  }
};

export const replaceUrlParams = (
  key: string,
  value: string,
  targetUrl = "",
) => {
  let query = "";
  if (targetUrl && targetUrl.split("?")) {
    query = targetUrl.split("?")[1] || "";
  } else if (typeof window !== "undefined" && window.location.search) {
    query = window.location.search.substring(1);
  }
  let obj = {};
  let vars = query?.split("&") || [];
  for (var i = 0; i < vars.length; i++) {
    let pair = vars[i].split("=");
    obj[pair[0]] = pair[1];
  }
  obj[key] = encodeURIComponent(value);
  let search = Object.keys(obj).reduce((pre, cur) => {
    if (!cur || !obj[cur]) return pre;
    return pre + `${pre !== "" ? "&" : ""}${cur}=${obj[cur]}`;
  }, "");
  search = search ? `?${search}` : "";

  if (typeof window !== "undefined" && window.location) {
    const { pathname, hash } = window.location;
    const newUrl = `${pathname}${search}${hash || ""}`;
    window.history.replaceState("", "", newUrl);
  }
};

export const recordLog = (
  key: string,
  source: "normal" | "question" | "noResult" = "normal",
) => {
  const keywords: any = sessionStorage.getItem("keywords");
  if (keywords != key) {
    const params = {
      spm: "w.d.sk",
      tags:
        source === "normal"
          ? "khd:" + key
          : source === "question"
            ? "khd-false:" + key
            : "khd-NoR-false:" + key,
    };
    recordLogs(params).then((res) => {
      sessionStorage.setItem("keywords", key);
    });
  }
};

/**
 * 防抖
 * @param fn 函数
 * @param interval 间隔时间，毫秒
 */
export function debounce(func, timeout = 200) {
  let timer;
  return (...args) => {
    timer && clearTimeout(timer);
    timer = setTimeout(() => {
      func.apply(this, args);
    }, timeout);
  };
}

/**
 * 生成uuid
 * @param prefix 前缀
 */
export const generateUUID = (prefix: string = "") => {
  const str = "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(
    /[xy]/g,
    function (c) {
      var r = (Math.random() * 16) | 0,
        v = c == "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    },
  );
  return (prefix ? prefix + "_" : "") + str;
};

/**
 * 将文本转换为 URL 友好的 slug
 * @param text 标题文本
 * @returns slug 格式的字符串
 */
export const textToSlug = (text: string): string => {
  if (!text) return "";

  return (
    text
      .toString()
      .toLowerCase()
      .trim()
      // 移除特殊字符，保留中文、字母、数字、空格和连字符
      .replace(/[^\u4e00-\u9fa5a-z0-9\s-]/g, "")
      // 将空格替换为连字符
      .replace(/\s+/g, "-")
      // 将多个连字符替换为单个
      .replace(/-+/g, "-")
      // 移除首尾的连字符
      .replace(/^-+|-+$/g, "")
  );
};
