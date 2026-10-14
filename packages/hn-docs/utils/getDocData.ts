import axios from "axios";
import { resourceDomain } from "@/utils/resources";
import { docDomainAssemble } from "@/utils/document";
import { getUrlParams } from "./index";
import { RequestSource } from "@/api/index.d";

// sso获取资源，禁止请求头
const axiosWithoutAuth = axios.create();

export const getDocData = async (docUrl?: string) => {
  if (!docUrl) return "";
  const domain = await resourceDomain();

  // 内联 JSON 直通(文档平台正文直出,非 OSS 指针):解析后同样过资源域名拼装
  const trimmed = docUrl.trim();
  if (trimmed.startsWith("{")) {
    try {
      const inlineJson = JSON.parse(trimmed);
      return docDomainAssemble(inlineJson, domain);
    } catch {
      // 非法 JSON 则继续走原 OSS 拉取逻辑
    }
  }

  console.log("domain-->>", domain, "docUrl-->>", docUrl);

  // boss端的文档需要加时间戳,防止内容缓存
  if (getUrlParams("from") === RequestSource.BOSS) {
    docUrl = docUrl + "?timeStamp=" + new Date().getTime();
  }
  // 重置特定请求头
  if (axiosWithoutAuth.defaults?.headers?.common) {
    delete axiosWithoutAuth.defaults.headers.common["Authorization"];
  }

  const docContent = await axiosWithoutAuth.get(domain + docUrl);
  const doc = docDomainAssemble(docContent.data, domain);
  return doc;
};
