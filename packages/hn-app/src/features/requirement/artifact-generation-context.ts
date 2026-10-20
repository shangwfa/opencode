import type { ArtifactGenerationMode } from "./config/requirement-chat-config";

export const ARTIFACT_GENERATION_CONTEXT_PREFIX =
  "[Artifact Generation Context]";

export function buildArtifactGenerationContext(
  mode: ArtifactGenerationMode,
  causedByMessageId?: string,
): string {
  return [
    ARTIFACT_GENERATION_CONTEXT_PREFIX,
    `artifactGenerationMode: ${mode}`,
    causedByMessageId?.trim()
      ? `artifactCausedByMessageId: ${causedByMessageId.trim()}`
      : undefined,
  ]
    .filter(Boolean)
    .join("\n");
}

export function attachArtifactCausedByMessageId(
  context: string | undefined,
  messageId: string,
): string | undefined {
  if (!context?.includes(ARTIFACT_GENERATION_CONTEXT_PREFIX)) return context;
  const line = `artifactCausedByMessageId: ${messageId.trim()}`;
  if (/artifactCausedByMessageId:\s*\S+/.test(context)) {
    return context.replace(/artifactCausedByMessageId:\s*\S+/, line);
  }
  return `${context.trim()}\n${line}`;
}

export function parseArtifactCausedByMessageId(
  parts: readonly { type?: string; text?: string; synthetic?: boolean }[] | undefined,
): string | undefined {
  for (const part of parts ?? []) {
    if (part.type !== "text" || !part.synthetic) continue;
    if (!part.text?.includes(ARTIFACT_GENERATION_CONTEXT_PREFIX)) continue;
    const match = part.text.match(/artifactCausedByMessageId:\s*(\S+)/);
    if (match?.[1]) return match[1];
  }
}

export function parseArtifactGenerationMode(
  parts: readonly { type?: string; text?: string; synthetic?: boolean }[] | undefined,
): ArtifactGenerationMode | undefined {
  for (const part of parts ?? []) {
    if (part.type !== "text" || !part.synthetic) continue;
    if (!part.text?.includes(ARTIFACT_GENERATION_CONTEXT_PREFIX)) continue;
    const match = part.text.match(/artifactGenerationMode:\s*(concise|detailed)\b/);
    if (match?.[1] === "concise" || match?.[1] === "detailed") {
      return match[1];
    }
  }
}
