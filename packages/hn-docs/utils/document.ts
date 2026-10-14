// 递归 docData，将 OSS 资源字段拼上当前环境域名：
// video/image/attachment/iframe 的 attrs.src；
// rpaFlow 的 attrs["data-blocks"]；
// board 的 attrs["preview-img"]、attrs["board-data"]（http(s) 整段 URL 才处理，内联 JSON 不动）
const assembleAttrUrl = (attrs, key, domain) => {
  if (!attrs || typeof attrs !== "object") return;
  const raw = attrs[key];
  if (!raw || typeof raw !== "string") return;
  const t = raw.trim();
  if (isUrlWithDomain(t)) {
    attrs[key] = domain + new URL(t).pathname;
    return;
  }
  // 存盘去掉域名后多为以 / 开头的 path；内联 JSON 等不以 / 或 http 开头，不拼接
  if (t.startsWith("/")) {
    attrs[key] = domain + t;
  }
};

export const docDomainAssemble = (doc, domain) => {
  const recursive = (data) => {
    data.content.forEach((item) => {
      if (
        item.type === "video" ||
        item.type === "image" ||
        item.type === "attachment" ||
        (item.type === "iframe" &&
          (item.attrs?.isAttachment || item.attrs?.src))
      ) {
        const raw = item.attrs?.src ?? item.src;
        if (raw && typeof raw === "string") {
          const path = isUrlWithDomain(raw) ? new URL(raw).pathname : raw;
          const fullUrl = domain + path;
          if (!item.attrs) item.attrs = {};
          item.attrs.src = fullUrl;
          if ("src" in item) delete item.src;
        }
      }
      if (item.type === "rpaFlow" && item.attrs) {
        assembleAttrUrl(item.attrs, "data-blocks", domain);
      }
      if (item.type === "board" && item.attrs) {
        assembleAttrUrl(item.attrs, "preview-img", domain);
        assembleAttrUrl(item.attrs, "board-data", domain);
      }
      if (item.content && Array.isArray(item.content)) {
        recursive(item);
      }
    });
  };
  recursive(doc);
  return doc;
};

// 判断url是否包含域名
export const isUrlWithDomain = (url) => {
  return url.startsWith("http://") || url.startsWith("https://");
};
