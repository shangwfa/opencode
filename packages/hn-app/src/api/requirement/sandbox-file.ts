import type { FileContent, FileNode } from "@/types/opencode";
import { opencodeSaasBaseUrl } from "@/utils/opencode-saas-base";

/** SaaS base URL，sandbox-file.ts / agentsMd.ts / nodeProjectPreview.ts 共用 */
export function opencodeSaasBase(): string {
  return opencodeSaasBaseUrl();
}

const OPENCODE_BASE = opencodeSaasBase();

/** 拼接沙箱绝对路径：path 已是绝对路径则原样返回，否则与 directory 拼接 */
export function resolveSandboxPath(directory: string, path: string): string {
  if (path.startsWith("/")) return path
  if (/^[A-Za-z]:[\\/]/.test(path) || /^[A-Za-z]:$/.test(path)) return path
  if (path.startsWith("\\\\") || path.startsWith("//")) return path
  return `${directory.replace(/[\\/]+$/, "")}/${path}`
}

export async function fetchSandboxFileList(input: {
  sessionID: string;
  directory: string;
  path: string;
}): Promise<FileNode[]> {
  const url = new URL(`${OPENCODE_BASE}/file`);
  url.searchParams.set("sessionID", input.sessionID.trim());
  url.searchParams.set("directory", input.directory.trim());
  url.searchParams.set("path", input.path.trim());

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`加载沙箱文件列表失败: ${res.status} ${text}`);
  }

  const data = (await res.json().catch(() => [])) as unknown;
  if (!Array.isArray(data)) {
    throw new Error("沙箱文件列表格式异常");
  }

  return data.map((node) => ({
    name: typeof node.name === "string" ? node.name : "",
    path: typeof node.path === "string" ? node.path : "",
    absolute: typeof node.absolute === "string" ? node.absolute : node.path,
    type: node.type === "directory" ? "directory" : "file",
    ignored: Boolean(node.ignored),
  }));
}

export async function fetchSandboxFileContent(input: {
  sessionID: string;
  directory: string;
  path: string;
}): Promise<FileContent> {
  const url = new URL(`${OPENCODE_BASE}/file/content`);
  url.searchParams.set("sessionID", input.sessionID.trim());
  url.searchParams.set("directory", input.directory.trim());
  url.searchParams.set("path", input.path.trim());

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`加载沙箱文件内容失败: ${res.status} ${text}`);
  }

  const data = (await res.json().catch(() => ({}))) as unknown;
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { content?: unknown }).content !== "string"
  ) {
    throw new Error("沙箱文件内容格式异常");
  }

  return {
    type: (data as { type?: unknown }).type === "binary" ? "binary" : "text",
    content: (data as { content: string }).content,
  };
}

/**
 * 搜索沙箱文件 / 目录（`GET /find/file`，见 files-api.md §八 T-FILE-60~64）。
 * 沙箱内走 `rg --files --hidden | grep -iF`（文件）或 `find -type d | grep -iF`（目录），
 * 返回 LegacyEntry 数组（`{name, path, absolute, type, ignored}`，即 FileNode 形状）。
 */
export async function searchSandboxFiles(input: {
  sessionID: string;
  query: string;
  /** true=搜目录（dirs=true），false/默认=搜文件（type=file） */
  dirs?: boolean;
  limit?: number;
}): Promise<FileNode[]> {
  const url = new URL(`${OPENCODE_BASE}/find/file`);
  url.searchParams.set("sessionID", input.sessionID.trim());
  url.searchParams.set("query", input.query.trim());
  if (input.dirs) url.searchParams.set("dirs", "true");
  else url.searchParams.set("type", "file");
  if (input.limit) url.searchParams.set("limit", String(input.limit));

  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`搜索沙箱文件失败: ${res.status} ${text}`);
  }

  const data = (await res.json().catch(() => [])) as unknown;
  if (!Array.isArray(data)) return [];
  return data.map((node) => ({
    name: typeof node.name === "string" ? node.name : "",
    path: typeof node.path === "string" ? node.path : "",
    absolute: typeof node.absolute === "string" ? node.absolute : (typeof node.path === "string" ? node.path : ""),
    type: node.type === "directory" ? "directory" : "file",
    ignored: Boolean(node.ignored),
  }));
}

// === SaaS files API（字节流读写删，见 docs/test-cases/sandbox/files-api.md） ===

function isSandboxUnavailable(status: number, text: string): boolean {
  return status === 502 && text.toLowerCase().includes("sandbox unavailable");
}

/** 构建 `GET /session/:id/files/download` URL（返回原始字节流，Content-Type 按扩展名推断） */
export function buildSandboxFileDownloadUrl(input: {
  sessionID: string;
  directory: string;
  path: string;
  cacheBust?: string | number;
}): string {
  const url = new URL(
    `${OPENCODE_BASE}/session/${encodeURIComponent(input.sessionID.trim())}/files/download`,
  );
  url.searchParams.set("path", resolveSandboxPath(input.directory, input.path));
  if (input.cacheBust !== undefined) {
    url.searchParams.set("_t", String(input.cacheBust));
  }
  return url.toString();
}

/** 下载沙箱文件为 Blob（文本/二进制统一走 files/download，Content-Type 由 SaaS 按扩展名推断） */
export async function downloadSandboxFileBlob(input: {
  sessionID: string;
  directory: string;
  path: string;
  cacheBust?: string | number;
}): Promise<Blob> {
  const res = await fetch(buildSandboxFileDownloadUrl(input));
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (isSandboxUnavailable(res.status, text)) {
      throw new Error("沙箱正在同步内容，请稍后重试");
    }
    throw new Error(`下载沙箱文件失败: ${res.status} ${text}`);
  }
  return res.blob();
}

/** 上传文件到沙箱（`POST /session/:id/files/upload`，目录自动创建，覆盖写） */
export async function uploadSandboxFile(input: {
  sessionID: string;
  /** 目标目录绝对路径（如 /workspace/worktrees/sid/uploads） */
  directory: string;
  /** 文件名（不含路径分隔符，危险字符会被 SaaS 拒绝） */
  filename: string;
  /** 文件字节（File / Blob / ArrayBuffer / Uint8Array） */
  body: Blob | ArrayBuffer | Uint8Array;
}): Promise<{ path: string; size: number }> {
  const url = new URL(
    `${OPENCODE_BASE}/session/${encodeURIComponent(input.sessionID.trim())}/files/upload`,
  );
  url.searchParams.set("path", input.directory.replace(/[\\/]+$/, ""));
  url.searchParams.set("filename", input.filename);

  const res = await fetch(url.toString(), {
    method: "POST",
    body: input.body as BodyInit,
  });
  const data = (await res.json().catch(() => ({}))) as {
    path?: string;
    size?: number;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(`上传沙箱文件失败: ${res.status} ${data.error ?? JSON.stringify(data)}`);
  }
  return { path: data.path ?? "", size: data.size ?? 0 };
}

/** 删除沙箱文件/目录（`POST /session/:id/files/remove`，目录递归删除） */
export async function removeSandboxFile(input: {
  sessionID: string;
  directory: string;
  path: string;
}): Promise<{ path: string; removed: boolean; type: string }> {
  const url = new URL(
    `${OPENCODE_BASE}/session/${encodeURIComponent(input.sessionID.trim())}/files/remove`,
  );
  url.searchParams.set("path", resolveSandboxPath(input.directory, input.path));

  const res = await fetch(url.toString(), { method: "POST" });
  const data = (await res.json().catch(() => ({}))) as {
    path?: string;
    removed?: boolean;
    type?: string;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(`删除沙箱文件失败: ${res.status} ${data.error ?? JSON.stringify(data)}`);
  }
  return {
    path: data.path ?? "",
    removed: data.removed ?? false,
    type: data.type ?? "file",
  };
}

/** 构建 `POST /session/:id/files/create` URL（创建/覆盖写文件，父目录自动创建） */
export function buildSandboxFileCreateUrl(input: {
  sessionID: string;
  directory: string;
  path: string;
}): string {
  const url = new URL(
    `${OPENCODE_BASE}/session/${encodeURIComponent(input.sessionID.trim())}/files/create`,
  );
  url.searchParams.set("path", resolveSandboxPath(input.directory, input.path));
  return url.toString();
}

/** 创建/覆盖写沙箱文件（`POST /session/:id/files/create`，父目录自动创建，覆盖写，见 files-api.md T-FILE-10~14） */
export async function createSandboxFile(input: {
  sessionID: string;
  directory: string;
  /** 文件路径（相对 directory 或绝对路径） */
  path: string;
  /** 文件内容（文本传 string；二进制传 Blob / Uint8Array / ArrayBuffer） */
  content: Blob | ArrayBuffer | Uint8Array | string;
}): Promise<{ path: string; size: number; created: boolean }> {
  const res = await fetch(buildSandboxFileCreateUrl(input), {
    method: "POST",
    body: input.content as BodyInit,
  });
  const data = (await res.json().catch(() => ({}))) as {
    path?: string;
    size?: number;
    created?: boolean;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(`创建沙箱文件失败: ${res.status} ${data.error ?? JSON.stringify(data)}`);
  }
  return { path: data.path ?? "", size: data.size ?? 0, created: data.created ?? false };
}

/** 构建 `POST /session/:id/files/mkdir` URL（多级递归创建目录，幂等） */
export function buildSandboxMkdirUrl(input: {
  sessionID: string;
  directory: string;
  path: string;
}): string {
  const url = new URL(
    `${OPENCODE_BASE}/session/${encodeURIComponent(input.sessionID.trim())}/files/mkdir`,
  );
  url.searchParams.set("path", resolveSandboxPath(input.directory, input.path));
  return url.toString();
}

/** 在沙箱创建目录（`POST /session/:id/files/mkdir`，多级递归，幂等，见 files-api.md T-FILE-01~05） */
export async function mkdirSandboxPath(input: {
  sessionID: string;
  directory: string;
  /** 目录路径（相对 directory 或绝对路径） */
  path: string;
}): Promise<{ path: string; created: boolean }> {
  const res = await fetch(buildSandboxMkdirUrl(input), {
    method: "POST",
  });
  const data = (await res.json().catch(() => ({}))) as {
    path?: string;
    created?: boolean;
    error?: string;
  };
  if (!res.ok) {
    throw new Error(`创建沙箱目录失败: ${res.status} ${data.error ?? JSON.stringify(data)}`);
  }
  return { path: data.path ?? "", created: data.created ?? false };
}
