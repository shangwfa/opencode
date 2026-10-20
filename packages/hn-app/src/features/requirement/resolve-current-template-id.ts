import { readTemplateSelectionDecision } from "@/features/requirement/stage-helpers/template-selection-storage";
import {
  parseTemplateJudgment,
  toTemplateJudgment,
  validateTemplateSelectionDocument,
} from "@/features/requirement/stage-helpers/parse-template-judgment";

function parseLayoutDesignerTemplateId(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const root = parsed as Record<string, unknown>;
    const decision = root.templateDecision as
      | { confirmedUseTemplate?: unknown }
      | undefined;
    if (decision?.confirmedUseTemplate !== true) return undefined;
    const selection = validateTemplateSelectionDocument(root.templateSelection);
    const judgment = toTemplateJudgment(selection);
    return judgment?.useExistingTemplate ? judgment.templateId?.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveCurrentTemplateId(input: {
  sessionId: string;
  templateSelectionArtifact?: string;
  defaultTemplateSkillId?: string;
}): string {
  const sid = input.sessionId.trim();
  const fallback = input.defaultTemplateSkillId?.trim() || "";
  if (!sid) return fallback;

  const storageDecision = readTemplateSelectionDecision(sid);
  const fromStorage = storageDecision?.templateId?.trim();
  if (fromStorage && storageDecision?.accepted) return fromStorage;
  if (storageDecision?.accepted === false) return fallback;

  const artifact = input.templateSelectionArtifact?.trim();
  if (artifact) {
    const fromLayoutDesigner = parseLayoutDesignerTemplateId(artifact);
    if (fromLayoutDesigner) return fromLayoutDesigner;

    const judgment = parseTemplateJudgment(artifact);
    const fromArtifact = judgment?.templateId?.trim();
    if (fromArtifact && judgment?.useExistingTemplate) {
      return fromArtifact;
    }
  }

  return fallback;
}
