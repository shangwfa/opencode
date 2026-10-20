import { base64Encode } from "@/shared/util/encode";

/** OpenCode SDK / 需求对话 URL `:dir` 对应的工作区路径，默认 `/workspace` */
export const OPENCODE_DIRECTORY =
  window.YD?.OPENCODE_DIRECTORY?.trim() || "/workspace";

/** URL 路由 `:dir` 段（base64），DirectoryLayout 解码后即为 OPENCODE_DIRECTORY */
export const OPENCODE_DIRECTORY_ROUTE_SLUG = base64Encode(OPENCODE_DIRECTORY);
