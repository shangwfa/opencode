/**
 * OSS/对象存储能力(三模式,按环境变量自动判定,优先级从上到下):
 *
 * 模式 A:代理原项目 yddoc/Boss 的 OSS 接口(内网环境)
 *   KNOWLEDGE_OSS_UPSTREAM_BASE_URL / _BOSS_URL / _TOKEN(可选) / _ENV_CODE
 *
 * 模式 B:Vercel Blob(公网部署/无内网场景)
 *   BLOB_READ_WRITE_TOKEN
 *   说明:Blob 为服务端上传模型(无预签名直传),走 putResource();
 *         resource-upload-sessions(外部直传会话)在该模式下暂不支持。
 *         Store Access 需为 Public(资源 URL 直接可读,编辑器图片场景)。
 *
 * 模式 C:自持阿里云 OSS V1 签名(yddoc 退役后的大文件/自有桶方案)
 *   KNOWLEDGE_OSS_BUCKET / _ENDPOINT / _ACCESS_KEY_ID / _ACCESS_KEY_SECRET / _PUBLIC_DOMAIN
 */
import { randomUUID } from "node:crypto"
import { put as vercelBlobPut } from "@vercel/blob"
import { BookOpenError } from "./errors.js"
import type { UploadAddress } from "./types.js"

const UPSTREAM_TIMEOUT = 15_000
const DOMAIN_CACHE_MS = 5 * 60 * 1000

export type UploadMode = "upstream" | "vercel-blob" | "aliyun"

export interface ServerUploadResult {
  key: string
  readUrl: string
  uploadMode: UploadMode
}

export function uploadMode(): UploadMode {
  if (
    process.env.KNOWLEDGE_OSS_UPSTREAM_BASE_URL?.trim() &&
    process.env.KNOWLEDGE_OSS_UPSTREAM_BOSS_URL?.trim()
  ) {
    return "upstream"
  }
  if (process.env.BLOB_READ_WRITE_TOKEN?.trim()) return "vercel-blob"
  if (process.env.KNOWLEDGE_OSS_BUCKET?.trim()) return "aliyun"
  throw new BookOpenError(
    "CONFIG_ERROR",
    "对象存储未配置:KNOWLEDGE_OSS_UPSTREAM_*(代理原项目)/ BLOB_READ_WRITE_TOKEN(Vercel Blob)/ KNOWLEDGE_OSS_*(自持签名)至少配置一组",
  )
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new BookOpenError("CONFIG_ERROR", `${name} 未配置`)
  return value
}

/** 资源存储路径段:safe(contextId)/date/uuid-name(导出供 resource-upload 代理预生成 key) */
export function objectPath(contextId: string, fileName: string): string {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "")
  const safeName = fileName.replace(/[^\w.\-\u4e00-\u9fa5]/g, "_")
  return `doc-platform/${contextId}/${date}/${randomUUID()}-${safeName}`
}

// ──────────────── 服务端上传(有内容即可存) ────────────────

/** 上传资源字节,返回 key 与可读地址(所有模式统一) */
export async function putResource(params: {
  bytes: Uint8Array
  contentType: string
  fileName: string
  /** 上下文目录段:docUniqueId 或临时 requestId 派生值 */
  contextId: string
  /** 模式 A 上游接口所需 envCode */
  envCode?: string
}): Promise<ServerUploadResult> {
  const mode = uploadMode()
  const key = objectPath(params.contextId, params.fileName)

  if (mode === "vercel-blob") {
    const token = requiredEnv("BLOB_READ_WRITE_TOKEN")
    const blob = await vercelBlobPut(key, Buffer.from(params.bytes), {
      contentType: params.contentType,
      access: "public",
      addRandomSuffix: false,
      token,
      allowOverwrite: true,
    })
    return { key, readUrl: blob.url, uploadMode: mode }
  }

  if (mode === "upstream") {
    const address = await upstreamRequestUploadAddress({
      fileName: params.fileName,
      fileSize: params.bytes.byteLength,
      contentType: params.contentType,
      contextId: params.contextId,
      envCode: params.envCode ?? "",
    })
    const put = await fetch(address.uploadUrl, {
      method: "PUT",
      body: new Uint8Array(params.bytes),
      headers: { "Content-Type": params.contentType },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT * 4),
    })
    if (!put.ok) {
      throw new BookOpenError("UPSTREAM_ERROR", `资源上传失败: OSS PUT ${put.status}`)
    }
    return { key: address.key, readUrl: address.readUrl ?? address.key, uploadMode: mode }
  }

  // aliyun:V1 签名服务端直传
  const bucket = requiredEnv("KNOWLEDGE_OSS_BUCKET")
  const endpoint = requiredEnv("KNOWLEDGE_OSS_ENDPOINT")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
  const accessKeyId = requiredEnv("KNOWLEDGE_OSS_ACCESS_KEY_ID")
  const accessKeySecret = requiredEnv("KNOWLEDGE_OSS_ACCESS_KEY_SECRET")
  const expires = Math.floor(Date.now() / 1000) + 3600
  const contentType = params.contentType || "application/octet-stream"
  const stringToSign = `PUT\n\n${contentType}\n${expires}\n/${bucket}/${key}`
  const signature = createHmacSync("sha1", accessKeySecret)
    .update(stringToSign)
    .digest("base64")
  const query = new URLSearchParams({
    OSSAccessKeyId: accessKeyId,
    Expires: String(expires),
    Signature: signature,
  })
  const put = await fetch(`https://${bucket}.${endpoint}/${key}?${query.toString()}`, {
    method: "PUT",
    body: new Uint8Array(params.bytes),
    headers: { "Content-Type": contentType },
  })
  if (!put.ok) {
    throw new BookOpenError("UPSTREAM_ERROR", `资源上传失败: OSS PUT ${put.status}`)
  }
  const publicDomain = process.env.KNOWLEDGE_OSS_PUBLIC_DOMAIN?.replace(/\/$/, "")
  return {
    key,
    readUrl: publicDomain ? `${publicDomain}/${key}` : `https://${bucket}.${endpoint}/${key}`,
    uploadMode: mode,
  }
}

import { createHmac } from "node:crypto"
function createHmacSync(alg: string, key: string) {
  return createHmac(alg, key)
}

// ──────────────── 客户端直传地址(模式 A/C 支持;Vercel Blob 暂不支持) ────────────────

/** 资源公共访问域名(原 fetchOssDomain 契约) */
export async function ossPublicDomain(): Promise<string> {
  const mode = uploadMode()
  if (mode === "vercel-blob") {
    // Blob 的资源 URL 在上传时逐个生成,无统一域名
    throw new BookOpenError(
      "NOT_IMPLEMENTED",
      "Vercel Blob 模式无统一资源域名(上传时逐个返回 URL)",
    )
  }
  if (mode === "upstream") {
    const base = requiredEnv("KNOWLEDGE_OSS_UPSTREAM_BASE_URL").replace(/\/$/, "")
    const domain = await upstreamFetch<string>(
      `${base}/api/noauth/v1/yddoc/oss/domain`,
      { operation: "查询 OSS 域名" },
    )
    if (!domain) throw new BookOpenError("UPSTREAM_ERROR", "OSS 域名返回为空")
    return domain
  }
  return requiredEnv("KNOWLEDGE_OSS_PUBLIC_DOMAIN").replace(/\/$/, "")
}

/** 生成客户端 PUT 直传地址(仅模式 A/C;Vercel Blob 为服务端上传模型,不支持) */
export async function createPresignedPut(params: {
  fileName: string
  fileSize: number
  contentType?: string
  contextId: string
  envCode?: string
  expiresInSeconds?: number
}): Promise<UploadAddress> {
  const mode = uploadMode()
  if (mode === "vercel-blob") {
    throw new BookOpenError(
      "NOT_IMPLEMENTED",
      "Vercel Blob 模式暂不支持客户端直传会话:资源请通过 create_document/update_document 正文内联(data:/外链)提供,由服务端上传",
    )
  }
  if (mode === "upstream") {
    const envCode =
      (params.envCode && params.envCode !== "default" ? params.envCode : undefined) ??
      process.env.KNOWLEDGE_OSS_UPSTREAM_ENV_CODE?.trim() ??
      ""
    if (!envCode) {
      throw new BookOpenError(
        "CONFIG_ERROR",
        "KNOWLEDGE_OSS_UPSTREAM_ENV_CODE 未配置(上游 getUploadUrl 需要 envCode)",
      )
    }
    return upstreamRequestUploadAddress({
      fileName: params.fileName,
      fileSize: params.fileSize,
      contentType: params.contentType,
      contextId: params.contextId,
      envCode,
    })
  }

  const bucket = requiredEnv("KNOWLEDGE_OSS_BUCKET")
  const endpoint = requiredEnv("KNOWLEDGE_OSS_ENDPOINT")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "")
  const accessKeyId = requiredEnv("KNOWLEDGE_OSS_ACCESS_KEY_ID")
  const accessKeySecret = requiredEnv("KNOWLEDGE_OSS_ACCESS_KEY_SECRET")
  const key = objectPath(params.contextId, params.fileName)
  const expires = Math.floor(Date.now() / 1000) + (params.expiresInSeconds ?? 3600)
  const contentType = params.contentType || "application/octet-stream"
  const stringToSign = `PUT\n\n${contentType}\n${expires}\n/${bucket}/${key}`
  const signature = createHmacSync("sha1", accessKeySecret).update(stringToSign).digest("base64")
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

// ──────────────── 模式 A:upstream 代理实现 ────────────────

interface Envelope<T> {
  code?: number
  success?: boolean
  message?: string
  msg?: string
  data: T
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
    throw new BookOpenError(
      "UPSTREAM_ERROR",
      `${init.operation}失败: 响应非 JSON(${response.status})`,
      { operation: init.operation, upstreamStatus: response.status },
    )
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
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
