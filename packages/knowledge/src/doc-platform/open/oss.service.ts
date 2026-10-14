/**
 * OSS 能力(双模式):
 *
 * 模式 A(默认,当前):代理原项目 yddoc/Boss 的 OSS 接口
 *   - 上传地址:POST {BOSS_URL}/boss/api/v3/cornerstone/helpdoc/oss/getUploadUrl
 *     (需服务级 Boss Token,鉴权后置期间的过渡方案)
 *   - 资源域名:GET {BASE_URL}/api/noauth/v1/yddoc/oss/domain(noauth,带内存缓存)
 *   环境变量:
 *     KNOWLEDGE_OSS_UPSTREAM_BASE_URL   原 NEXT_PUBLIC_BASE_URL(网关根)
 *     KNOWLEDGE_OSS_UPSTREAM_BOSS_URL   原 NEXT_PUBLIC_BOSS_URL
 *     KNOWLEDGE_OSS_UPSTREAM_TOKEN      服务级 Boss Token
 *     KNOWLEDGE_OSS_UPSTREAM_ENV_CODE   envCode(test/staging/online)
 *
 * 模式 B(yddoc 退役后切换):自持阿里云 OSS V1 签名
 *   KNOWLEDGE_OSS_BUCKET / _ENDPOINT / _ACCESS_KEY_ID / _ACCESS_KEY_SECRET / _PUBLIC_DOMAIN
 */
import { createHmac, randomUUID } from "node:crypto";
import { BookOpenError } from "./errors.js";
import type { UploadAddress } from "./types.js";

const UPSTREAM_TIMEOUT = 15_000;
const DOMAIN_CACHE_MS = 5 * 60 * 1000;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new BookOpenError("CONFIG_ERROR", `${name} 未配置`);
  return value;
}

function upstreamEnabled(): boolean {
  // token 可选:缺失时上游 getUploadUrl 会 401 透传(domain 为 noauth 仍可用)
  return !!(
    process.env.KNOWLEDGE_OSS_UPSTREAM_BASE_URL?.trim() &&
    process.env.KNOWLEDGE_OSS_UPSTREAM_BOSS_URL?.trim()
  );
}

function selfHostedEnabled(): boolean {
  return !!process.env.KNOWLEDGE_OSS_BUCKET?.trim();
}

function assertConfigured(): void {
  if (upstreamEnabled() || selfHostedEnabled()) return;
  throw new BookOpenError(
    "CONFIG_ERROR",
    "OSS 未配置:需 KNOWLEDGE_OSS_UPSTREAM_*(代理原项目)或 KNOWLEDGE_OSS_*(自持签名)",
  );
}

// ── 模式 A:upstream 代理 ──

interface Envelope<T> {
  code?: number;
  success?: boolean;
  message?: string;
  msg?: string;
  data: T;
}

async function upstreamFetch<T>(
  url: string,
  init: RequestInit & { operation: string },
): Promise<T> {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT),
      redirect: "manual",
    })
  } catch (error: any) {
    throw new BookOpenError("UPSTREAM_ERROR", `${init.operation}失败: ${error.message}`, {
      operation: init.operation,
    })
  }
  const envelope = (await response.json().catch(() => null)) as Envelope<T> | null
  if (!envelope) {
    throw new BookOpenError("UPSTREAM_ERROR", `${init.operation}失败: 响应非 JSON(${response.status})`, {
      operation: init.operation,
      upstreamStatus: response.status,
    })
  }
  if (envelope.code !== undefined && envelope.code !== 200) {
    throw new BookOpenError(
      envelope.code === 401 ? "UNAUTHORIZED" : "UPSTREAM_ERROR",
      envelope.message || envelope.msg || `${init.operation}失败`,
      { operation: init.operation, upstreamCode: envelope.code },
    )
  }
  if (envelope.success === false) {
    throw new BookOpenError("UPSTREAM_ERROR", envelope.message || envelope.msg || `${init.operation}失败`, {
      operation: init.operation,
    })
  }
  return envelope.data
}

let domainCache: { value: string; expire: number } | null = null

/** 资源公共访问域名(原 fetchOssDomain 契约,noauth + 5min 缓存) */
export async function ossPublicDomain(): Promise<string> {
  if (domainCache && domainCache.expire > Date.now()) return domainCache.value

  if (upstreamEnabled()) {
    const base = requiredEnv("KNOWLEDGE_OSS_UPSTREAM_BASE_URL").replace(/\/$/, "")
    const domain = await upstreamFetch<string>(
      `${base}/api/noauth/v1/yddoc/oss/domain`,
      { operation: "查询 OSS 域名" },
    )
    if (!domain) throw new BookOpenError("UPSTREAM_ERROR", "OSS 域名返回为空")
    domainCache = { value: domain, expire: Date.now() + DOMAIN_CACHE_MS }
    return domain
  }
  if (selfHostedEnabled()) {
    const domain = requiredEnv("KNOWLEDGE_OSS_PUBLIC_DOMAIN").replace(/\/$/, "")
    domainCache = { value: domain, expire: Date.now() + DOMAIN_CACHE_MS }
    return domain
  }
  assertConfigured()
  return "" // 不可达:assertConfigured 抛出
}

function upstreamRequestUploadAddress(params: {
  fileName: string
  fileSize: number
  contentType?: string
  contextId: string
  envCode: string
}): Promise<UploadAddress> {
  const bossUrl = requiredEnv("KNOWLEDGE_OSS_UPSTREAM_BOSS_URL").replace(/\/$/, "")
  const token = process.env.KNOWLEDGE_OSS_UPSTREAM_TOKEN?.trim() ?? ""
  return upstreamFetch<UploadAddress>(
    `${bossUrl}/boss/api/v3/cornerstone/helpdoc/oss/getUploadUrl`,
    {
      operation: "获取 OSS 上传地址",
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        fileName: params.fileName,
        fileSize: params.fileSize,
        fileType: "doc_asset",
        envCode: params.envCode,
        menuId: params.contextId,
      }),
    },
  )
}

// ── 模式 B:自持签名 ──

function selfHostedPresignedPut(params: {
  fileName: string
  contentType?: string
  contextId: string
  expiresInSeconds?: number
}): UploadAddress {
  const bucket = requiredEnv("KNOWLEDGE_OSS_BUCKET")
  const endpoint = requiredEnv("KNOWLEDGE_OSS_ENDPOINT").replace(/^https?:\/\//, "").replace(/\/$/, "")
  const accessKeyId = requiredEnv("KNOWLEDGE_OSS_ACCESS_KEY_ID")
  const accessKeySecret = requiredEnv("KNOWLEDGE_OSS_ACCESS_KEY_SECRET")

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const safeName = params.fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")
  const key = `doc-platform/${params.contextId}/${date}/${randomUUID()}-${safeName}`
  const expires = Math.floor(Date.now() / 1000) + (params.expiresInSeconds ?? 3600)
  const contentType = params.contentType || "application/octet-stream"

  const stringToSign = `PUT\n\n${contentType}\n${expires}\n/${bucket}/${key}`
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64")
  const query = new URLSearchParams({
    OSSAccessKeyId: accessKeyId,
    Expires: String(expires),
    Signature: signature,
  })

  const publicDomain = process.env.KNOWLEDGE_OSS_PUBLIC_DOMAIN?.replace(/\/$/, "")
  return {
    key,
    uploadUrl: `https://${bucket}.${endpoint}/${key}?${query.toString()}`,
    ...(publicDomain ? { readUrl: `${publicDomain}/${key}` } : {}),
  }
}

// ── 统一入口 ──

function upstreamEnvCode(contextEnvCode?: string): string {
  return (
    (contextEnvCode && contextEnvCode !== "default" ? contextEnvCode : undefined) ??
    process.env.KNOWLEDGE_OSS_UPSTREAM_ENV_CODE?.trim() ??
    ""
  )
}

/**
 * 生成 PUT 预签名/代理上传地址
 * key 规则(模式 B):doc-platform/{contextId}/{date}/{uuid}-{fileName}
 */
export async function createPresignedPut(params: {
  fileName: string
  fileSize: number
  contentType?: string
  /** 上下文目录段:docUniqueId 或临时 requestId 派生值 */
  contextId: string
  /** 上游接口所需 envCode(代理模式;取 OpenContext.settings.envCode 或环境默认) */
  envCode?: string
  expiresInSeconds?: number
}): Promise<UploadAddress> {
  assertConfigured()

  if (upstreamEnabled()) {
    const envCode = upstreamEnvCode(params.envCode)
    if (!envCode) {
      throw new BookOpenError(
        "CONFIG_ERROR",
        "KNOWLEDGE_OSS_UPSTREAM_ENV_CODE 未配置(上游 getUploadUrl 需要 envCode)",
      )
    }
    const address = await upstreamRequestUploadAddress({
      fileName: params.fileName,
      fileSize: params.fileSize,
      contentType: params.contentType,
      contextId: params.contextId,
      envCode,
    })
    if (!address.key || !address.uploadUrl) {
      throw new BookOpenError("UPSTREAM_ERROR", "OSS 上传地址返回不完整")
    }
    return address
  }

  return selfHostedPresignedPut(params)
}
