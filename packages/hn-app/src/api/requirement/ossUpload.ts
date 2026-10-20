const OSS_UPLOAD_URL = "https://staging-logs.yingdao.com/upload-api/oss/upload";

export type OssUploadInput = {
  key: string;
  file: File | Blob;
  name?: string;
  type?: string;
  bucket?: string;
  acl?: string;
  canOverride?: boolean;
};

export type OssUploadResult = {
  linkUrl: string;
  bucket?: string;
  etag?: string;
  expireDate?: string;
};

function readMessage(data: unknown, fallback: string): string {
  if (!data || typeof data !== "object") return fallback;
  const message = (data as { message?: unknown }).message;
  if (typeof message === "string" && message.trim()) return message.trim();
  const error = (data as { error?: unknown }).error;
  if (typeof error === "string" && error.trim()) return error.trim();
  return fallback;
}

function readResult(data: unknown): OssUploadResult | undefined {
  if (!data || typeof data !== "object") return undefined;
  const payload = "data" in data ? (data as { data?: unknown }).data : data;
  if (!payload || typeof payload !== "object") return undefined;
  const linkUrl = (payload as { linkUrl?: unknown }).linkUrl;
  if (typeof linkUrl !== "string" || !linkUrl.trim()) return undefined;
  return {
    linkUrl: linkUrl.trim(),
    bucket:
      typeof (payload as { bucket?: unknown }).bucket === "string"
        ? ((payload as { bucket: string }).bucket)
        : undefined,
    etag:
      typeof (payload as { etag?: unknown }).etag === "string"
        ? ((payload as { etag: string }).etag)
        : undefined,
    expireDate:
      typeof (payload as { expireDate?: unknown }).expireDate === "string"
        ? ((payload as { expireDate: string }).expireDate)
        : undefined,
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return undefined;
  }
}

export async function uploadOssFile(
  input: OssUploadInput,
): Promise<OssUploadResult> {
  const form = new FormData();
  form.append("key", input.key);
  form.append("file", input.file, input.name ?? input.key.split("/").pop() ?? "file");
  if (input.name) form.append("name", input.name);
  if (input.type) form.append("type", input.type);
  if (input.bucket) form.append("bucket", input.bucket);
  if (input.acl) form.append("acl", input.acl);
  if (input.canOverride !== undefined) {
    form.append("canOverride", String(input.canOverride));
  }

  const res = await fetch(OSS_UPLOAD_URL, {
    method: "POST",
    body: form,
  });
  const data = await readJson(res);
  if (!res.ok) {
    throw new Error(readMessage(data, "OSS 上传失败"));
  }
  const result = readResult(data);
  if (!result) {
    throw new Error("OSS 上传成功但未返回 linkUrl");
  }
  return result;
}

export const ossUploadUrl = OSS_UPLOAD_URL;
