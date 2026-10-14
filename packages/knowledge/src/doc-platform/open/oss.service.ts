/**
 * OSS 预签名上传(阿里云 OSS V1 签名,PUT)
 * 替代原 yddoc /oss/getUploadAddress 上游依赖 —— knowledge 自持签名
 *
 * 环境变量(未配置时相关接口返回 CONFIG_ERROR):
 *   KNOWLEDGE_OSS_BUCKET            bucket 名
 *   KNOWLEDGE_OSS_ENDPOINT          如 oss-cn-hangzhou.aliyuncs.com
 *   KNOWLEDGE_OSS_ACCESS_KEY_ID
 *   KNOWLEDGE_OSS_ACCESS_KEY_SECRET
 *   KNOWLEDGE_OSS_PUBLIC_DOMAIN     资源访问域名(如 https://cdn.example.com/oss)
 */
import { createHmac, randomUUID } from "node:crypto";
import { BookOpenError } from "./errors.js";
import type { UploadAddress } from "./types.js";

interface OssConfig {
  bucket: string;
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  publicDomain: string;
}

const REQUIRED_ENV: Record<keyof OssConfig, string> = {
  bucket: "KNOWLEDGE_OSS_BUCKET",
  endpoint: "KNOWLEDGE_OSS_ENDPOINT",
  accessKeyId: "KNOWLEDGE_OSS_ACCESS_KEY_ID",
  accessKeySecret: "KNOWLEDGE_OSS_ACCESS_KEY_SECRET",
  publicDomain: "KNOWLEDGE_OSS_PUBLIC_DOMAIN",
};

let cached: OssConfig | null | undefined;

export function readOssConfig(): OssConfig {
  if (cached !== undefined) return cached as OssConfig;
  const values = {} as OssConfig;
  const missing: string[] = [];
  for (const [key, envName] of Object.entries(REQUIRED_ENV) as [keyof OssConfig, string][]) {
    const value = process.env[envName]?.trim();
    if (value) values[key] = value;
    else missing.push(envName);
  }
  if (missing.length) {
    cached = null;
    throw new BookOpenError(
      "CONFIG_ERROR",
      `OSS 未配置,缺少环境变量: ${missing.join(", ")}`,
      { missing },
    );
  }
  cached = values;
  return values;
}

/** 资源公共访问域名(原 fetchOssDomain 契约) */
export function ossPublicDomain(): string {
  return readOssConfig().publicDomain.replace(/\/$/, "");
}

/**
 * 生成 PUT 预签名地址
 * key 规则:doc-platform/{contextId}/{date}/{uuid}-{fileName}
 */
export function createPresignedPut(params: {
  fileName: string;
  fileSize: number;
  contentType?: string;
  /** 上下文目录段:docUniqueId 或临时 requestId 派生值 */
  contextId: string;
  expiresInSeconds?: number;
}): UploadAddress {
  const config = readOssConfig();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const safeName = params.fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_");
  const key = `doc-platform/${params.contextId}/${date}/${randomUUID()}-${safeName}`;
  const expires = Math.floor(Date.now() / 1000) + (params.expiresInSeconds ?? 3600);
  const contentType = params.contentType || "application/octet-stream";

  const stringToSign = `PUT\n\n${contentType}\n${expires}\n/${config.bucket}/${key}`;
  const signature = createHmac("sha1", config.accessKeySecret)
    .update(stringToSign)
    .digest("base64");

  const endpoint = config.endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const query = new URLSearchParams({
    OSSAccessKeyId: config.accessKeyId,
    Expires: String(expires),
    Signature: signature,
  });

  return {
    key,
    uploadUrl: `https://${config.bucket}.${endpoint}/${key}?${query.toString()}`,
    readUrl: `${ossPublicDomain()}/${key}`,
  };
}
