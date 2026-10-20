import { UNSUPPORTED_PREVIEW_APP_IDS } from "@/const/requirement/preview";

export function extractRequirementRepoLabel(repoOrGitlab: string): string {
  const value = decodeURIComponent(repoOrGitlab).trim();
  if (!value) return "";
  try {
    const pathname = new URL(value).pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/, "");
    const segments = pathname.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : pathname;
  } catch {
    if (!value.includes("/")) return value;
    const normalized = value.replace(/\.git$/, "");
    const segments = normalized.split("/").filter(Boolean);
    return segments.length > 0 ? segments[segments.length - 1] : normalized;
  }
}

export function isGitlabRouteRepo(repoOrGitlab: string): boolean {
  const value = decodeURIComponent(repoOrGitlab).trim();
  if (!value) return false;
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.includes("/") ||
    value.endsWith(".git")
  );
}

const REQUIREMENT_APP_ID_ALIAS: Record<string, string> = {
  "xybot-front-home-v3": "xybot-front-homepage-v3",
};

/**
 * These projects are intentionally accessible only through a requirement
 * detail URL, so their records must not appear in any requirement collection.
 */
const REQUIREMENT_LIST_HIDDEN_APP_IDS = new Set(["xybot-work-order"]);

export function normalizeRequirementAppId(appId: string): string {
  const value = decodeURIComponent(appId).trim();
  if (!value) return "";
  return REQUIREMENT_APP_ID_ALIAS[value] ?? value;
}

export function isRequirementHiddenFromList(repoOrGitlab: string): boolean {
  const appId = normalizeRequirementAppId(
    extractRequirementRepoLabel(repoOrGitlab),
  );
  return REQUIREMENT_LIST_HIDDEN_APP_IDS.has(appId);
}

export function isPreviewSupportedAppId(appId: string): boolean {
  return !UNSUPPORTED_PREVIEW_APP_IDS.includes(appId.trim());
}
