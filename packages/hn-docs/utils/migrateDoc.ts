/**
 * 老数据迁移：将 Novel (Tiptap v2) / 旧 book-v3 文档结构迁移为
 * Tiptap v3 + @xybot/editor-extensions 兼容的 JSON。
 * 在 getDocData 返回后、写入编辑器前调用一次。
 */

// highlightBlock 默认样式（与 editor-extensions highlightBlock 默认一致）
const HIGHLIGHT_BLOCK_DEFAULTS = {
  icon: "💡",
  textColor: "#0F1118",
  borderColor: "rgba(20,116,242,0.1)",
  backgroundColor: "rgba(20,116,242,0.25)",
};

export type DocNode = {
  type: string;
  content?: DocNode[];
  attrs?: Record<string, unknown>;
  text?: string;
  [key: string]: unknown;
};

export type DocDoc = {
  type: string;
  content?: DocNode[];
  attrs?: Record<string, unknown>;
  [key: string]: unknown;
};

function ensureAttrs(node: DocNode): Record<string, unknown> {
  if (!node.attrs || typeof node.attrs !== "object") {
    node.attrs = {};
  }
  return node.attrs as Record<string, unknown>;
}

function buildParagraphsFromText(text: string): DocNode[] {
  const lines = text.split(/\r?\n/);
  return (lines.length > 0 ? lines : [""]).map((line) => ({
    type: "paragraph",
    content: line ? [{ type: "text", text: line }] : [],
  }));
}

function migrateNode(node: DocNode): void {
  if (!node || typeof node.type !== "string") return;

  const attrs = ensureAttrs(node);

  // microApp → rpaFlow，保留原有 attrs（height, data-blocks, version, content-type）
  if (node.type === "microApp") {
    node.type = "rpaFlow";
    if ("contentType" in attrs && !("content-type" in attrs)) {
      attrs["content-type"] = attrs.contentType;
      delete attrs.contentType;
    }
  }

  // quoteBlock 是不可编辑的 atom 节点。book-v3 的“引用”应使用原生 blockquote，
  // 历史 blockquote 需要原样保留 content/marks；已被旧迁移转成 quoteBlock 的草稿尽量还原。
  if (node.type === "quoteBlock") {
    const quoteAttrs = ensureAttrs(node);
    const headText =
      typeof quoteAttrs.headText === "string" ? quoteAttrs.headText : "";
    const text = typeof quoteAttrs.text === "string" ? quoteAttrs.text : "";
    const paragraphs = buildParagraphsFromText(
      [headText, text].filter(Boolean).join("\n"),
    );

    node.type = "blockquote";
    node.attrs = {};
    node.content =
      Array.isArray(node.content) && node.content.length > 0
        ? node.content
        : paragraphs;
  }

  // description → highlightBlock：将 text* 包裹为 paragraph+，设置默认 attrs
  if (node.type === "description") {
    node.type = "highlightBlock";
    const inner =
      Array.isArray(node.content) && node.content.length > 0
        ? node.content
        : [];
    node.content = [
      {
        type: "paragraph",
        content: inner.length > 0 ? inner : [],
      },
    ];
    node.attrs = {
      ...HIGHLIGHT_BLOCK_DEFAULTS,
      ...(node.attrs || {}),
    };
  }

  // 媒体节点：顶层 src 合并到 attrs.src
  const mediaTypes = ["image", "video", "attachment", "iframe"] as const;
  if (mediaTypes.includes(node.type as (typeof mediaTypes)[0])) {
    const src = (node as DocNode & { src?: string }).src;
    if (src != null && typeof src === "string") {
      attrs.src = src;
      delete (node as DocNode & { src?: string }).src;
    }
  }

  // 图片宽高：若老数据写在其它字段可在此归一为 attrs.width / attrs.height
  if (node.type === "image") {
    const n = node as DocNode & { width?: number; height?: number };
    if (n.width != null && attrs.width == null) attrs.width = n.width;
    if (n.height != null && attrs.height == null) attrs.height = n.height;
    if (n.width != null) delete n.width;
    if (n.height != null) delete n.height;

    // 仅为缺少 isAutoSize 的老数据补齐固定尺寸模式。
    // 新数据会同时保存 width/height 和 isAutoSize，不能覆盖重置尺寸写入的 true。
    if (
      attrs.width != null &&
      attrs.height != null &&
      attrs.isAutoSize == null
    ) {
      attrs.isAutoSize = false;
    }
  }

  if (Array.isArray(node.content)) {
    node.content.forEach((child) => migrateNode(child as DocNode));
  }
}

/**
 * 迁移文档 JSON，使老数据兼容新编辑器（Tiptap v3 + editor-extensions）。
 * 会修改传入的 doc 对象。
 */
export function migrateDoc(doc: DocDoc): DocDoc {
  if (!doc || doc.type !== "doc") return doc;
  if (Array.isArray(doc.content)) {
    doc.content.forEach((node) => migrateNode(node as DocNode));
  }
  return doc;
}
