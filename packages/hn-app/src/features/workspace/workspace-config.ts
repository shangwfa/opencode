export const WORKSPACE_UPLOADS_DIR = "uploads";
export const WORKSPACE_OUTPUT_DIR = "output";

export const INLINE_DATA_URL_LIMIT = 5 * 1024 * 1024;
export const MAX_UPLOAD_SIZE = 20 * 1024 * 1024;

export const EXCLUDED_DIRS_IN_FILE_TAB = new Set([
  "uploads",
  "output",
  ".git",
]);

/** 保留中文等 Unicode 字母/数字（\p{L}\p{N}），仅替换空白、引号、路径分隔符等特殊字符 */
export function sanitizeFilename(name: string): string {
  return name.replace(/[^\p{L}\p{N}._-]/gu, "_") || "file";
}

/** 去除尾部路径分隔符 */
export function stripTrailingSep(path: string): string {
  return path.replace(/[\\/]+$/, "");
}
