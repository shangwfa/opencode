/**
 * 媒体上传客户端（原 upload 模块语义：boss-api getPubUploadUrl + PUT）。
 * GATEWAY_MEDIA_UPLOAD_URL / GATEWAY_MEDIA_UPLOAD_TOKEN 由环境配置
 * （迁移期兜底原内置 token，上线前轮换）。
 */
export interface MediaUploadResult {
  readUrl: string
}

interface PubUploadUrlResponse {
  data: { uploadUrl: string; readUrl: string; headers: Record<string, string>; exists: boolean }
}

function mediaConfig(): { baseUrl: string; token: string } {
  return {
    baseUrl: process.env["GATEWAY_MEDIA_UPLOAD_URL"] || "https://boss-api.shadow-rpa.net",
    token: process.env["GATEWAY_MEDIA_UPLOAD_TOKEN"] || "234e69f9-939d-44e0-8b8f-1560ba77e375",
  }
}

async function getPubUploadUrl(fileName: string, contentType: string, size?: number): Promise<PubUploadUrlResponse["data"]> {
  const { baseUrl, token } = mediaConfig()
  const res = await fetch(`${baseUrl}/boss/api/v1/media/getPubUploadUrl`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      contentType,
      fileName,
      ...(size !== undefined ? { size } : {}),
      fileOriginScene: "cdn_file",
      fileKeyAttrs: { fileOriginScene: "cdn_file", fileType: "file" },
    }),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json()) as PubUploadUrlResponse
  return json.data
}

async function putToUploadUrl(uploadUrl: string, headers: Record<string, string>, body: ArrayBuffer | string): Promise<void> {
  const { token } = mediaConfig()
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { ...headers, Authorization: `Bearer ${token}` },
    body,
  })
  if (!res.ok) throw new Error(`上传失败: HTTP ${res.status}`)
}

/** POST /gw-api/upload/file：multipart 文件上传 */
export async function uploadFile(filename: string, contentType: string, size: number, content: ArrayBuffer): Promise<MediaUploadResult> {
  const data = await getPubUploadUrl(filename, contentType, size)
  if (!data.exists) {
    await putToUploadUrl(data.uploadUrl, data.headers ?? {}, content)
  }
  return { readUrl: data.readUrl }
}

/** POST /gw-api/upload/text：文本内容上传 */
export async function uploadText(filename: string, content: string): Promise<MediaUploadResult> {
  const contentType = filename.slice(filename.indexOf(".") + 1)
  const data = await getPubUploadUrl(filename, contentType)
  if (!data.exists) {
    await putToUploadUrl(data.uploadUrl, data.headers ?? {}, content)
  }
  return { readUrl: data.readUrl }
}
