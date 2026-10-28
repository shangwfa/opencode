import { BookOpenError } from "./errors";
import type { ImportableResourceKind } from "./resource-normalizer";

function inferContentTypeFromBytes(bytes: Buffer): string | undefined {
  if (bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a")
    return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return "image/webp";
  if (bytes.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  if (bytes.subarray(0, 4).toString("hex") === "1a45dfa3") return "video/webm";

  return undefined;
}

function inferContentType(
  bytes: Buffer,
  sourceUrl?: string,
): string | undefined {
  const contentTypeFromBytes = inferContentTypeFromBytes(bytes);
  if (contentTypeFromBytes) return contentTypeFromBytes;

  if (!sourceUrl) return undefined;
  let pathname = "";
  try {
    pathname = new URL(sourceUrl).pathname.toLowerCase();
  } catch {
    return undefined;
  }
  const extension = pathname.split(".").pop();
  return {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    mp4: "video/mp4",
    webm: "video/webm",
    mov: "video/quicktime",
    pdf: "application/pdf",
    txt: "text/plain",
    zip: "application/zip",
  }[extension ?? ""];
}

export function validatedContentType(
  kind: ImportableResourceKind,
  declared: string,
  bytes: Buffer,
  sourceUrl?: string,
): string {
  const normalized = declared.split(";", 1)[0]?.trim().toLowerCase() || "";
  let contentType =
    !normalized || normalized === "application/octet-stream"
      ? inferContentType(bytes, sourceUrl) || normalized
      : normalized;
  const contentTypeFromBytes = inferContentTypeFromBytes(bytes);
  if (
    kind === "image" &&
    !contentType.startsWith("image/") &&
    contentTypeFromBytes?.startsWith("image/")
  ) {
    contentType = contentTypeFromBytes;
  }
  if (kind === "image" && contentType === "image/svg+xml") {
    throw new BookOpenError(
      "VALIDATION_ERROR",
      "自动重新上传不支持可能包含脚本的 SVG 图片",
    );
  }
  if (kind === "image" && !contentType.startsWith("image/")) {
    throw new BookOpenError(
      "VALIDATION_ERROR",
      "图片资源的 Content-Type 必须为 image/*",
    );
  }
  if (kind === "video" && !contentType.startsWith("video/")) {
    throw new BookOpenError(
      "VALIDATION_ERROR",
      "视频资源的 Content-Type 必须为 video/*",
    );
  }
  return contentType || "application/octet-stream";
}
