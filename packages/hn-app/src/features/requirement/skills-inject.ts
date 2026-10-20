import JSZip from "jszip";
import {
  getAiSceneById,
  getAiSceneList,
  resolvePlatformSkillId,
  safeAiSceneFolderName,
  type AiSceneResource,
} from "@/api/requirement/aiScene";

export type SessionSkillResourceType = "doc" | "script" | "template" | "asset";

export type SessionSkillResource = {
  path: string;
  type: SessionSkillResourceType;
  content: string;
};

export type SessionSkillBundle = {
  name: string;
  description: string;
  content: string;
  resources: SessionSkillResource[];
};

export type SkillDownloadTarget = {
  fileLink: string;
  fallbackName: string;
};

export type InjectSessionSkillsInput = {
  sessionId: string;
  skillNames: string[];
  baseUrl: string;
};

export type InjectSessionSkillsResult = {
  created: Array<{ name: string; resourceCount: number }>;
  skipped: Array<{ input: string; reason: string }>;
};

const MAX_RESOURCE_BYTES = 256 * 1024;
const MAX_BUNDLE_BYTES = 1024 * 1024;
const MAX_RESOURCES = 64;

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".pdf",
  ".zip",
  ".mp3",
  ".mp4",
]);

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const SCRIPT_EXTENSIONS = new Set([
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
]);

export function inferResourceType(relativePath: string): SessionSkillResourceType {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("templates/")) return "template";
  if (
    normalized.startsWith("references/") ||
    normalized.startsWith("docs/") ||
    normalized.startsWith("rules/")
  ) {
    return "doc";
  }
  const dot = normalized.lastIndexOf(".");
  const ext = dot >= 0 ? normalized.slice(dot).toLowerCase() : "";
  if (DOC_EXTENSIONS.has(ext)) return "doc";
  if (SCRIPT_EXTENSIONS.has(ext)) return "script";
  return "asset";
}

export function parseSkillFrontmatter(text: string): {
  meta: Record<string, string>;
  body: string;
} {
  if (!text.startsWith("---")) {
    return { meta: {}, body: text };
  }
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: text };
  }
  const meta: Record<string, string> = {};
  const lines = match[1].split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const colon = line.indexOf(":");
    if (colon === -1) {
      i += 1;
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value === "|" || value === ">") {
      const block: string[] = [];
      i += 1;
      while (i < lines.length && (lines[i].startsWith(" ") || !lines[i].trim())) {
        block.push(lines[i].trim());
        i += 1;
      }
      meta[key] = block.filter(Boolean).join(" ");
      continue;
    }
    value = value.replace(/^['"]|['"]$/g, "");
    meta[key] = value;
    i += 1;
  }
  return { meta, body: match[2] ?? "" };
}

function isValidResourcePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/")) return false;
  if (normalized.includes("..")) return false;
  return true;
}

function shouldSkipResourcePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith(".") || normalized.split("/").some((seg) => seg.startsWith("."))) {
    return true;
  }
  const dot = normalized.lastIndexOf(".");
  const ext = dot >= 0 ? normalized.slice(dot).toLowerCase() : "";
  return BINARY_EXTENSIONS.has(ext);
}

function findSkillMdPath(files: Record<string, string>): string | undefined {
  if (files["SKILL.md"]) return "SKILL.md";
  const match = Object.keys(files).find(
    (p) => p.endsWith("/SKILL.md") || p.toLowerCase() === "skill.md",
  );
  return match;
}

export function buildSessionSkillBundle(
  files: Record<string, string>,
  fallbackName: string,
): SessionSkillBundle {
  const skillMdPath = findSkillMdPath(files);
  if (!skillMdPath) {
    throw new Error("zip 中未找到 SKILL.md");
  }

  const skillMd = files[skillMdPath];
  const { meta, body } = parseSkillFrontmatter(skillMd);
  const name = (meta.name ?? fallbackName).trim() || fallbackName;
  const description = (meta.description ?? name).trim() || name;
  const content = body.trim() || skillMd;

  const prefix = skillMdPath.includes("/")
    ? skillMdPath.slice(0, skillMdPath.lastIndexOf("/") + 1)
    : "";

  const resources: SessionSkillResource[] = [];
  let totalBytes = new TextEncoder().encode(content).length;

  const sortedPaths = Object.keys(files).sort();
  for (const filePath of sortedPaths) {
    if (filePath === skillMdPath) continue;
    if (prefix && !filePath.startsWith(prefix)) continue;

    const relativePath = prefix ? filePath.slice(prefix.length) : filePath;
    if (!relativePath || !isValidResourcePath(relativePath)) continue;
    if (shouldSkipResourcePath(relativePath)) continue;

    const fileContent = files[filePath];
    const size = new TextEncoder().encode(fileContent).length;
    if (size > MAX_RESOURCE_BYTES) continue;
    if (totalBytes + size > MAX_BUNDLE_BYTES) break;
    if (resources.length >= MAX_RESOURCES) break;

    resources.push({
      path: relativePath,
      type: inferResourceType(relativePath),
      content: fileContent,
    });
    totalBytes += size;
  }

  return { name, description, content, resources };
}

export function collectDownloadTargets(
  resource: AiSceneResource,
  list: AiSceneResource[],
): SkillDownloadTarget[] {
  const resourceType = resource.type ?? "SKILL";
  const fallbackFromTitle = safeAiSceneFolderName(
    resource.title || String(resource.id ?? "resource"),
  );

  if (resourceType !== "COMPOSITION") {
    const fileLink = resource.fileLink?.trim();
    if (!fileLink) return [];
    return [{ fileLink, fallbackName: fallbackFromTitle }];
  }

  const targets: SkillDownloadTarget[] = [];
  const mainLink = resource.fileLink?.trim();
  if (mainLink) {
    targets.push({ fileLink: mainLink, fallbackName: fallbackFromTitle });
  }

  for (const materialId of resource.linkedMaterials ?? []) {
    const linked = list.find((item) => String(item.id) === String(materialId));
    const fileLink = linked?.fileLink?.trim();
    if (!linked || !fileLink) continue;
    const fallbackName = safeAiSceneFolderName(
      linked.title || String(linked.id ?? materialId),
    );
    targets.push({ fileLink, fallbackName });
  }

  return targets;
}

function normalizeZipPath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

function stripZipRootPrefix(paths: string[]): string {
  const firstSegments = new Set(paths.map((p) => p.split("/")[0]));
  if (firstSegments.size === 1 && paths.some((p) => p.includes("/"))) {
    return paths[0].split("/")[0] + "/";
  }
  return "";
}

export async function downloadSkillFiles(
  fileLink: string,
): Promise<Record<string, string>> {
  const res = await fetch(fileLink);
  if (!res.ok) {
    throw new Error(`下载 skill zip 失败 (${res.status})`);
  }
  const buffer = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);

  const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  if (entries.length === 0) return {};

  const normalizedPaths = entries.map(([path]) => normalizeZipPath(path));
  const stripPrefix = stripZipRootPrefix(normalizedPaths.filter(Boolean));

  const files: Record<string, string> = {};
  for (let i = 0; i < entries.length; i++) {
    const [, entry] = entries[i];
    const normalized = normalizedPaths[i];
    if (!normalized) continue;
    const relativePath = stripPrefix
      ? normalized.slice(stripPrefix.length)
      : normalized;
    if (!relativePath) continue;
    files[relativePath] = await entry.async("string");
  }
  return files;
}

export async function createSessionSkill(input: {
  sessionId: string;
  baseUrl: string;
  bundle: SessionSkillBundle;
}): Promise<SessionSkillBundle> {
  const sid = input.sessionId.trim();
  if (!sid) throw new Error("sessionId 不能为空");

  const base = input.baseUrl.replace(/\/$/, "");
  const url = new URL(`${base}/session/${encodeURIComponent(sid)}/skills/create`);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: input.bundle.name,
      description: input.bundle.description,
      content: input.bundle.content,
      resources: input.bundle.resources,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(body.trim() || `创建 session skill 失败 (${res.status})`);
  }

  return (await res.json()) as SessionSkillBundle;
}

export async function injectSessionSkills(
  input: InjectSessionSkillsInput,
): Promise<InjectSessionSkillsResult> {
  const sid = input.sessionId.trim();
  if (!sid) {
    throw new Error("sessionId 不能为空");
  }

  const result: InjectSessionSkillsResult = { created: [], skipped: [] };
  const sceneList = await getAiSceneList();

  for (const skillName of input.skillNames) {
    const trimmed = skillName.trim();
    if (!trimmed) {
      result.skipped.push({ input: skillName, reason: "skill 名称为空" });
      continue;
    }

    try {
      const platformId = await resolvePlatformSkillId(trimmed, sceneList);
      if (!platformId) {
        result.skipped.push({
          input: trimmed,
          reason: "未找到匹配的平台 skill",
        });
        continue;
      }

      const resource = await getAiSceneById(platformId);
      const targets = collectDownloadTargets(resource, sceneList);
      if (targets.length === 0) {
        result.skipped.push({
          input: trimmed,
          reason: "资源无 fileLink，无法下载",
        });
        continue;
      }

      for (const target of targets) {
        const files = await downloadSkillFiles(target.fileLink);
        const bundle = buildSessionSkillBundle(files, target.fallbackName);
        await createSessionSkill({
          sessionId: sid,
          baseUrl: input.baseUrl,
          bundle,
        });
        result.created.push({
          name: bundle.name,
          resourceCount: bundle.resources.length,
        });
      }
    } catch (err) {
      result.skipped.push({
        input: trimmed,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

export async function injectSkillsBeforeCodeGen(input: {
  sessionId: string;
  templateId: string;
  defaultTemplateSkillId?: string;
  baseUrl: string;
}): Promise<InjectSessionSkillsResult> {
  const templateId = input.templateId.trim() || input.defaultTemplateSkillId?.trim() || "";
  return injectSessionSkills({
    sessionId: input.sessionId,
    skillNames: [templateId],
    baseUrl: input.baseUrl,
  });
}
