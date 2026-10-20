import type { GitlabBranchItem } from "@/api/requirement";

export function resolveRequirementCopyBranch(input: {
  currentBranch?: string;
  baseBranch?: string;
  branches: readonly Pick<GitlabBranchItem, "name" | "default">[];
}): string {
  const current = input.currentBranch?.trim() ?? "";
  const base = input.baseBranch?.trim() ?? "";
  const remoteNames = new Set(
    input.branches.map((branch) => branch.name.trim())
  );
  if (current && remoteNames.has(current)) return current;
  if (base) return base;
  return (
    input.branches.find((branch) => branch.default)?.name.trim() ||
    input.branches[0]?.name.trim() ||
    current
  );
}
