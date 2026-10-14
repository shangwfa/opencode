import { env, getBasePath } from "./env";

const CACHE_TTL = 10 * 60 * 1000; // 10分钟有效期

// 获取请求域名（动态获取，避免模块加载时环境变量未注入）
const getRequestUrlDomain = () => {
  const domain = env.SERVER_URL || env.BASE_URL;
  if (!domain) {
    console.error(
      "REQUEST_URL_DOMAIN is not set. Please check NEXT_PUBLIC_SERVER_URL or NEXT_PUBLIC_BASE_URL environment variables."
    );
  }
  return domain || "";
};

const urlInfoCache = new Map<
  string,
  { value: string | null; expire: number }
>();
const verifyCache = new Map<string, { value: string | null; expire: number }>();

function getCache(map: Map<string, any>, key: string) {
  const cached = map.get(key);
  if (cached && cached.expire > Date.now()) {
    return cached.value;
  }
  if (cached) map.delete(key);
  return undefined;
}

function setCache(map: Map<string, any>, key: string, value: string | null) {
  map.set(key, { value, expire: Date.now() + CACHE_TTL });
}

export const verifyUrl = async (pathname: string): Promise<string | null> => {
  const cached = getCache(verifyCache, pathname);
  if (cached !== undefined) return cached;

  const aliasRes = await getUrlInfo(pathname);
  if (aliasRes) {
    setCache(verifyCache, pathname, aliasRes);
    return aliasRes;
  }

  const match = pathname.match(/^\/([^\/]+)(?:\/([^\/]+))?/);
  if (!match) return null;

  const [_, brandCode, languageCode] = match;
  if (!brandCode) return await getUrlInfo(pathname);

  // /{brandCode}/help 特殊处理
  if (`/${brandCode}/help` === pathname) {
    const helpUrl = `/${brandCode}/${env.ENV === "international" ? "en-US" : "zh-CN"}/help`;
    setCache(verifyCache, pathname, helpUrl);
    return helpUrl;
  }
  if (`/${brandCode}` === pathname) {
    const helpUrl = `/${brandCode}/zh-CN`;
    return helpUrl;
  }

  const params = new URLSearchParams({
    brandCode,
    languageCode: languageCode || "",
  }).toString();

  const requestDomain = getRequestUrlDomain();
  if (!requestDomain) {
    console.error("Cannot make API request: REQUEST_URL_DOMAIN is not set");
    return null;
  }

  const apiUrl = `${requestDomain}/api/noauth/v1/yddoc/envConfig/queryByBrandCodeAndLanguageCode?${params}`;
  const result = await fetch(apiUrl, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (result.status !== 200) return null;
  const data = await result.json();
  console.log("queryByBrandCodeAndLanguageCode data--->>>----------", data);

  if (data.code === 200) {
    if (!languageCode) {
      const defaultLanguageCode =
        data?.data?.defaultLanguageCode ||
        (env.ENV === "international" ? "en-US" : "zh-CN");
      const url = `/${brandCode}/${defaultLanguageCode}`;
      setCache(verifyCache, pathname, url);
      return url;
    }
    setCache(verifyCache, pathname, null);
    return null;
  } else {
    if (`/${brandCode}` === pathname) {
      const url = `/${brandCode}/${env.ENV === "international" ? "en-US" : "zh-CN"}`;
      setCache(verifyCache, pathname, url);
      return url;
    }
    setCache(verifyCache, pathname, null);
    return null;
  }
};

// 获取别名信息，带缓存
const getUrlInfo = async (pathname: string): Promise<string | null> => {
  const cached = getCache(urlInfoCache, pathname);
  if (cached !== undefined) return cached;

  const alias = pathname.replace(/^\//, "");
  const requestDomain = getRequestUrlDomain();
  if (!requestDomain) {
    console.error("Cannot make API request: REQUEST_URL_DOMAIN is not set");
    return null;
  }

  const apiUrl = `${requestDomain}/api/noauth/v1/yddoc/menus/queryDocIdByAlias?alias=${alias}`;
  console.log("apiUrl--->>>", apiUrl, alias);
  const response = await fetch(apiUrl, {
    method: "GET",
    headers: { "Content-Type": "application/json" },
  });
  if (response.status !== 200) {
    const errorBody = await response.text();
    console.log("response.error--->>>", response.status, errorBody);
    return null;
  }

  const data = await response.json();
  console.log("queryDocIdByAlias data--->>>----------", data);

  if (data.code === 200 && data.data) {
    const { languageCode, brandCode, docId, defaultLanguageCode } = data.data;
    const basePath = getBasePath();
    // 根据请求路径和 basePath 配置决定是否带前缀
    const url =
      basePath && pathname.includes(`${basePath}/`)
        ? `${basePath}/${brandCode}/${languageCode || defaultLanguageCode}/${docId}`
        : `/${brandCode}/${languageCode || defaultLanguageCode}/${docId}`;
    setCache(urlInfoCache, pathname, url);
    return url;
  }
  setCache(urlInfoCache, pathname, null);
  return null;
};
