type SyntheticTextPartCandidate = {
  type: string;
  synthetic?: boolean;
};

export function isSyntheticTextOnlyParts(
  parts: readonly SyntheticTextPartCandidate[] | undefined,
) {
  if (!Array.isArray(parts) || parts.length === 0) return false;
  return parts.every((part) => part.type === "text" && part.synthetic);
}
