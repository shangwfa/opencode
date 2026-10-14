import { BookOpenError } from "./errors";
import {
  MAX_DOCUMENT_BYTES,
  TiptapDocumentSchema,
  type TiptapDocument,
} from "./schemas";

const RESOURCE_ATTRS: Record<string, string[]> = {
  image: ["src"],
  video: ["src"],
  attachment: ["src"],
  iframe: ["src"],
  board: ["preview-img", "board-data"],
  rpaFlow: ["data-blocks"],
};

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const FORBIDDEN_SCHEMES = /^(?:javascript|data|blob|file):/i;
const EXTERNAL_URL = /^(?:https?:)?\/\//i;

export interface ContentInspection {
  content: TiptapDocument;
  plainTextContent: string;
  resourceRefs: Set<string>;
  byteLength: number;
}

function normalizeResourceRef(value: string): string {
  const normalized = value.trim();
  if (!normalized) return "";
  if (FORBIDDEN_SCHEMES.test(normalized) || EXTERNAL_URL.test(normalized)) {
    throw new BookOpenError(
      "VALIDATION_ERROR",
      "文档资源只允许使用 book-v3 OSS 相对路径",
      { resource: normalized.slice(0, 200) },
    );
  }
  if (normalized.includes("\\") || normalized.includes("..")) {
    throw new BookOpenError("VALIDATION_ERROR", "文档资源路径不合法");
  }
  const withoutQuery = normalized.split("?")[0] ?? "";
  return withoutQuery.split("#")[0] ?? "";
}

export function inspectDocumentContent(input: unknown): ContentInspection {
  const parsed = TiptapDocumentSchema.safeParse(input);
  if (!parsed.success) {
    throw new BookOpenError("VALIDATION_ERROR", "正文不是有效的 TipTap JSON");
  }

  const serialized = JSON.stringify(parsed.data);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > MAX_DOCUMENT_BYTES) {
    throw new BookOpenError("VALIDATION_ERROR", "文档正文不能超过 2MB");
  }

  const resourceRefs = new Set<string>();
  const texts: string[] = [];
  let nodeCount = 0;

  const visit = (value: unknown, depth: number): void => {
    if (depth > 40) {
      throw new BookOpenError("VALIDATION_ERROR", "文档节点嵌套过深");
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, depth + 1));
      return;
    }
    if (!value || typeof value !== "object") return;

    nodeCount += 1;
    if (nodeCount > 50_000) {
      throw new BookOpenError("VALIDATION_ERROR", "文档节点数量过多");
    }

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new BookOpenError("VALIDATION_ERROR", "文档包含不允许的字段");
      }
    }

    if (record.type === "text" && typeof record.text === "string") {
      texts.push(record.text);
    }

    const nodeType = typeof record.type === "string" ? record.type : "";
    const attrs = record.attrs;
    if (attrs && typeof attrs === "object" && !Array.isArray(attrs)) {
      const attrRecord = attrs as Record<string, unknown>;
      const resourceAttrs = RESOURCE_ATTRS[nodeType] ?? [];
      for (const attrName of resourceAttrs) {
        const attrValue = attrRecord[attrName];
        if (typeof attrValue === "string") {
          const ref = normalizeResourceRef(attrValue);
          if (ref) resourceRefs.add(ref);
        }
      }
    }

    Object.values(record).forEach((child) => visit(child, depth + 1));
  };

  visit(parsed.data, 0);
  const plainTextContent = texts.join("\n").slice(0, 1_000_000);
  return { content: parsed.data, plainTextContent, resourceRefs, byteLength };
}
