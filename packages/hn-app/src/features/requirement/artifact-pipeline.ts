import type { FileContent } from "@/types/opencode";
import {
  fileContentToMarkdown,
  parseArtifactContent,
} from "./parse-artifact-content";

/** 将 GET /file/content 响应体规范为可存入 StageArtifact 的 Markdown */
export function artifactMarkdownFromResponse(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const body = JSON.parse(trimmed) as FileContent;
    if (body && typeof body === "object" && "type" in body) {
      const md = fileContentToMarkdown(body);
      if (md !== undefined) {
        const norm = md.trim();
        if (norm) return md;
      }
    }
  } catch {}
  const md = parseArtifactContent(trimmed);
  return md.trim() ? md : undefined;
}
