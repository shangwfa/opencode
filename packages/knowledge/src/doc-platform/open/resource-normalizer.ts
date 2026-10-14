import { BookOpenError } from "./errors";
import { TiptapDocumentSchema, type TiptapDocument } from "./schemas";

const MAX_NODE_DEPTH = 40;
const MAX_NODE_COUNT = 50_000;
const MAX_IMPORTED_RESOURCES = 50;
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const RESOURCE_ATTRS: Record<string, string[]> = {
  image: ["src"],
  video: ["src"],
  attachment: ["src"],
  iframe: ["src"],
  board: ["preview-img", "board-data"],
  rpaFlow: ["data-blocks"],
};

export type ImportableResourceKind = "image" | "video" | "attachment";

export type ResourceImportRequest =
  | {
      sourceType: "data";
      bytes: Buffer;
      contentType: string;
      resourceKind: ImportableResourceKind;
    }
  | {
      sourceType: "url";
      url: string;
      resourceKind: ImportableResourceKind;
    };

export interface ResourceNormalizerOptions {
  getOssDomain: () => Promise<string>;
  importResource: (request: ResourceImportRequest) => Promise<string>;
}

export interface ResourceNormalizationResult {
  content: TiptapDocument;
  normalizedCount: number;
  importedCount: number;
}

function importableKind(
  nodeType: string,
  attrName: string,
): ImportableResourceKind | undefined {
  if (nodeType === "image" && attrName === "src") return "image";
  if (nodeType === "video" && attrName === "src") return "video";
  if (nodeType === "attachment" && attrName === "src") return "attachment";
  if (nodeType === "board" && attrName === "preview-img") return "image";
  if (nodeType === "rpaFlow" && attrName === "data-blocks") return "attachment";
  return undefined;
}

function resourceError(
  message: string,
  nodeType: string,
  attrName: string,
): BookOpenError {
  return new BookOpenError("VALIDATION_ERROR", message, {
    nodeType,
    attribute: attrName,
  });
}

function stripQueryAndFragment(value: string): string {
  return value.split(/[?#]/, 1)[0] ?? "";
}

function normalizeRelativePath(
  value: string,
  nodeType: string,
  attrName: string,
): string {
  const normalized = stripQueryAndFragment(value.trim());
  if (
    !normalized ||
    normalized.includes("\\") ||
    normalized.split("/").includes("..")
  ) {
    throw resourceError("文档资源路径不合法", nodeType, attrName);
  }
  return normalized;
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return undefined;
  }
}

function pathWithinBase(pathname: string, basePathname: string): boolean {
  const base = basePathname.replace(/\/+$/, "");
  if (!base || base === "/") return true;
  return pathname === base || pathname.startsWith(`${base}/`);
}

function standardOssPath(
  sourceUrl: URL,
  ossDomain: string,
): string | undefined {
  let domainUrl: URL;
  try {
    domainUrl = new URL(ossDomain);
  } catch {
    throw new BookOpenError("UPSTREAM_ERROR", "OSS 域名配置无效");
  }
  if (
    sourceUrl.origin !== domainUrl.origin ||
    !pathWithinBase(sourceUrl.pathname, domainUrl.pathname)
  ) {
    return undefined;
  }
  return sourceUrl.pathname;
}

function decodeDataUrl(
  value: string,
  nodeType: string,
  attrName: string,
): { bytes: Buffer; contentType: string } {
  const comma = value.indexOf(",");
  if (comma < 0) {
    throw resourceError("data: 资源格式无效", nodeType, attrName);
  }
  const metadata = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  const parts = metadata.split(";");
  const contentType = (parts[0] || "text/plain").trim().toLowerCase();
  const isBase64 = parts
    .slice(1)
    .some((part) => part.toLowerCase() === "base64");
  let bytes: Buffer;

  try {
    if (isBase64) {
      const compact = payload.replace(/\s/g, "");
      if (
        !compact ||
        compact.length % 4 === 1 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
      ) {
        throw new Error("invalid base64");
      }
      const padded = compact.padEnd(Math.ceil(compact.length / 4) * 4, "=");
      bytes = Buffer.from(padded, "base64");
    } else {
      bytes = Buffer.from(decodeURIComponent(payload), "utf8");
    }
  } catch {
    throw resourceError("data: 资源内容无法解码", nodeType, attrName);
  }

  if (bytes.length === 0) {
    throw resourceError("data: 资源内容为空", nodeType, attrName);
  }
  return { bytes, contentType };
}

export async function normalizeDocumentResources(
  input: unknown,
  options: ResourceNormalizerOptions,
): Promise<ResourceNormalizationResult> {
  const parsed = TiptapDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new BookOpenError("VALIDATION_ERROR", "正文不是有效的 TipTap JSON");
  }

  const content = JSON.parse(JSON.stringify(parsed.data)) as TiptapDocument;
  const imported = new Map<string, Promise<string>>();
  let ossDomainPromise: Promise<string> | undefined;
  let normalizedCount = 0;
  let importedCount = 0;
  let nodeCount = 0;

  const getOssDomain = () => {
    ossDomainPromise ??= options.getOssDomain();
    return ossDomainPromise;
  };

  const importOnce = (
    cacheKey: string,
    request: ResourceImportRequest,
    nodeType: string,
    attrName: string,
  ): Promise<string> => {
    const existing = imported.get(cacheKey);
    if (existing) return existing;
    importedCount += 1;
    if (importedCount > MAX_IMPORTED_RESOURCES) {
      throw resourceError(
        `单篇文档自动重新上传的资源不能超过 ${MAX_IMPORTED_RESOURCES} 个`,
        nodeType,
        attrName,
      );
    }
    const pending = options.importResource(request);
    imported.set(cacheKey, pending);
    return pending;
  };

  const normalizeRef = async (
    rawValue: string,
    nodeType: string,
    attrName: string,
  ): Promise<string> => {
    const value = rawValue.trim();
    const lower = value.toLowerCase();
    if (lower.startsWith("blob:")) {
      throw resourceError(
        "blob: 资源仅在创建它的浏览器上下文中有效，服务端无法重新上传",
        nodeType,
        attrName,
      );
    }
    if (lower.startsWith("file:")) {
      throw resourceError(
        "file: 资源指向调用方本地文件，服务端禁止读取，请先上传到 OSS",
        nodeType,
        attrName,
      );
    }

    const kind = importableKind(nodeType, attrName);
    if (lower.startsWith("data:")) {
      if (!kind) {
        throw resourceError(
          `${nodeType}.${attrName} 不支持自动重新上传 data: 资源`,
          nodeType,
          attrName,
        );
      }
      const decoded = decodeDataUrl(value, nodeType, attrName);
      return importOnce(
        `${kind}:${value}`,
        {
          sourceType: "data",
          bytes: decoded.bytes,
          contentType: decoded.contentType,
          resourceKind: kind,
        },
        nodeType,
        attrName,
      );
    }

    if (/^(?:https?:)?\/\//i.test(value)) {
      const sourceUrl = parseUrl(value);
      if (!sourceUrl || !["http:", "https:"].includes(sourceUrl.protocol)) {
        throw resourceError("资源 URL 格式无效", nodeType, attrName);
      }
      if (sourceUrl.username || sourceUrl.password) {
        throw resourceError(
          "外部资源 URL 不允许包含用户名或密码",
          nodeType,
          attrName,
        );
      }
      const standardPath = standardOssPath(sourceUrl, await getOssDomain());
      if (standardPath) return standardPath;
      if (!kind) {
        throw resourceError(
          `${nodeType}.${attrName} 不支持自动重新上传外部资源`,
          nodeType,
          attrName,
        );
      }
      return importOnce(
        `${kind}:${sourceUrl.toString()}`,
        {
          sourceType: "url",
          url: sourceUrl.toString(),
          resourceKind: kind,
        },
        nodeType,
        attrName,
      );
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
      throw resourceError("文档资源协议不受支持", nodeType, attrName);
    }
    return normalizeRelativePath(value, nodeType, attrName);
  };

  const visit = async (value: unknown, depth: number): Promise<void> => {
    if (depth > MAX_NODE_DEPTH) {
      throw new BookOpenError("VALIDATION_ERROR", "文档节点嵌套过深");
    }
    if (Array.isArray(value)) {
      for (const item of value) await visit(item, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;

    nodeCount += 1;
    if (nodeCount > MAX_NODE_COUNT) {
      throw new BookOpenError("VALIDATION_ERROR", "文档节点数量过多");
    }
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new BookOpenError("VALIDATION_ERROR", "文档包含不允许的字段");
      }
    }

    const nodeType = typeof record.type === "string" ? record.type : "";
    const attrs = record.attrs;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      const attrRecord = attrs as Record<string, unknown>;
      for (const attrName of RESOURCE_ATTRS[nodeType] ?? []) {
        const attrValue = attrRecord[attrName];
        if (typeof attrValue !== "string" || !attrValue.trim()) continue;
        const normalized = await normalizeRef(attrValue, nodeType, attrName);
        if (normalized !== attrValue) normalizedCount += 1;
        attrRecord[attrName] = normalizeRelativePath(
          normalized,
          nodeType,
          attrName,
        );
      }
    }

    for (const child of Object.values(record)) await visit(child, depth + 1);
  };

  await visit(content, 0);
  return { content, normalizedCount, importedCount };
}
