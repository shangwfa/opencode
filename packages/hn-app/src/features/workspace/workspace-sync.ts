import {
  buildSandboxFileDownloadUrl,
  uploadSandboxFile,
} from "@/api/requirement/sandbox-file";
import {
  WORKSPACE_UPLOADS_DIR,
  INLINE_DATA_URL_LIMIT,
  MAX_UPLOAD_SIZE,
  sanitizeFilename,
  stripTrailingSep,
} from "./workspace-config";

export type WorkspaceAttachmentResult = {
  /** files/download URL，用作图片预览 src + context text url 兜底 */
  ossUrl: string;
  sandboxPath: string;
  sandboxRelativePath: string;
  filename: string;
  mime: string;
  size: number;
};

export async function syncAttachmentToWorkspace(input: {
  sessionId: string;
  workingDirectory: string;
  file: File;
}): Promise<WorkspaceAttachmentResult> {
  const { sessionId, workingDirectory, file } = input;

  if (file.size > MAX_UPLOAD_SIZE) {
    throw new Error(`文件超过 ${MAX_UPLOAD_SIZE / 1024 / 1024}MB 限制`);
  }

  const safeName = sanitizeFilename(file.name);

  const targetDir = `${stripTrailingSep(workingDirectory)}/${WORKSPACE_UPLOADS_DIR}`;
  await uploadSandboxFile({
    sessionID: sessionId,
    directory: targetDir,
    filename: safeName,
    body: file,
  });

  const sandboxRelativePath = `${WORKSPACE_UPLOADS_DIR}/${safeName}`;
  const sandboxPath = `${stripTrailingSep(workingDirectory)}/${sandboxRelativePath}`;

  // files/download URL 作 ossUrl：图片预览可用（SaaS 按 Content-Type 返回字节，<img> 可直接加载），
  // context text 的 url 字段兜底（AI 主要靠 path 用 read 工具读取）
  const ossUrl = buildSandboxFileDownloadUrl({
    sessionID: sessionId,
    directory: workingDirectory,
    path: sandboxRelativePath,
  });

  return {
    ossUrl,
    sandboxPath,
    sandboxRelativePath,
    // [REQUIREMENT] 返回 safeName 而非 file.name，确保 context text 中的文件名与沙箱存储一致，
    // AI 按 context text 中的 name 用 read 工具读取时能正确找到文件
    filename: safeName,
    mime: file.type || "application/octet-stream",
    size: file.size,
  };
}

export function shouldUseDataUrl(file: File): boolean {
  return file.size <= INLINE_DATA_URL_LIMIT;
}
