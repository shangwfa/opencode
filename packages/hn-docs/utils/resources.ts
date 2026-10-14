import { queryOssDomain } from "@/api/customer";

let resourceDomainCache: string = "";
// 获取资源访问域名
export const resourceDomain = async (): Promise<string> => {
  if (resourceDomainCache) {
    return resourceDomainCache;
  }

  const response = await queryOssDomain();
  resourceDomainCache = response.data;
  return resourceDomainCache;
};
