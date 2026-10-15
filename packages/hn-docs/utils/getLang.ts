import LOCAL_ZH_LANGS from "@/local/zh-CN.json";
import LOCAL_EN_LANGS from "@/local/en-US.json";

let LANGS = {};

export const getLang = (key: string): string => {
  if (!key) return "";

  const languages =
    LANGS && Object.keys(LANGS).length ? parseJsonString(LANGS) ?? {} : {};
  const lang = languages[key] || LOCAL_ZH_LANGS[key];
  return lang ? lang : key;
};

const parseJsonString = (input) => {
  try {
    if (typeof input === "object") return input; // 已是对象直接返回
    return JSON.parse(input);
  } catch (e) {
    console.error("解析JSON失败:", e);
    return null;
  }
};

export const updateLanguageData = (languages) => {
  // 兼容对象/字符串两种入参;非法值置空走本地语言包兜底
  LANGS = languages || {};
};
