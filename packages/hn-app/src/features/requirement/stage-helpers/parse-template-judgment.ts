/** layout-template-judge 产物：标准 JSON（template-selection.json，与 Harness 约定一致） */

export type TemplateCatalogEntry = {
  templateId: string;
  description?: string;
};

export type TemplateSelectionDocument = {
  selection_version?: string;
  status?: string;
  agent?: string;
  judged_at?: string;
  template_source?: "user" | "ai-scene";
  summary?: string;
  useExistingTemplate: boolean;
  templateId?: string;
  templateName?: string;
  reason?: string;
  usageScenarios?: string;
  requirementHighlights?: string[];
  templateCatalog?: TemplateCatalogEntry[];
  matchExplanation?: string;
};

/** UI 沿用的精简形态 */
export type TemplateJudgment = {
  useExistingTemplate: boolean;
  templateId?: string;
  templateName?: string;
  reason?: string;
  usageScenarios?: string;
  summary?: string;
  matchExplanation?: string;
  requirementHighlights?: string[];
};


function parseTemplateCatalog(raw: unknown): TemplateCatalogEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const entries: TemplateCatalogEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const templateId =
      typeof o.templateId === "string" ? o.templateId.trim() : "";
    if (!templateId) continue;
    const description =
      typeof o.description === "string" && o.description.trim()
        ? o.description.trim()
        : undefined;
    entries.push({ templateId, description });
  }
  return entries.length ? entries : undefined;
}

function parseStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const items = raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
  return items.length ? items : undefined;
}

/** 校验 Harness 落盘的标准 JSON 对象 */
export function validateTemplateSelectionDocument(
  parsed: unknown,
  forbiddenTemplateIds?: readonly string[],
): TemplateSelectionDocument | undefined {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const o = parsed as Record<string, unknown>;

  if (o.status !== "completed") return undefined;

  if (typeof o.useExistingTemplate !== "boolean") return undefined;

  const summary =
    typeof o.summary === "string" && o.summary.trim()
      ? o.summary.trim()
      : undefined;
  const reason =
    typeof o.reason === "string" && o.reason.trim()
      ? o.reason.trim()
      : undefined;
  const usageScenarios =
    typeof o.usageScenarios === "string" && o.usageScenarios.trim()
      ? o.usageScenarios.trim()
      : undefined;

  if (o.useExistingTemplate) {
    const templateId =
      typeof o.templateId === "string" ? o.templateId.trim() : "";
    if (!templateId || forbiddenTemplateIds?.includes(templateId)) return undefined;
    const templateName =
      typeof o.templateName === "string" && o.templateName.trim()
        ? o.templateName.trim()
        : undefined;
    return {
      selection_version:
        typeof o.selection_version === "string"
          ? o.selection_version.trim()
          : undefined,
      status: "completed",
      agent:
        typeof o.agent === "string" ? o.agent.trim() : undefined,
      judged_at:
        typeof o.judged_at === "string" ? o.judged_at.trim() : undefined,
      template_source:
        o.template_source === "user" || o.template_source === "ai-scene"
          ? o.template_source
          : undefined,
      summary,
      useExistingTemplate: true,
      templateId,
      templateName,
      reason,
      usageScenarios,
      requirementHighlights: parseStringArray(o.requirementHighlights),
      templateCatalog: parseTemplateCatalog(o.templateCatalog),
      matchExplanation:
        typeof o.matchExplanation === "string" && o.matchExplanation.trim()
          ? o.matchExplanation.trim()
          : undefined,
    };
  }

  return {
    selection_version:
      typeof o.selection_version === "string"
        ? o.selection_version.trim()
        : undefined,
    status: "completed",
    agent: typeof o.agent === "string" ? o.agent.trim() : undefined,
    judged_at:
      typeof o.judged_at === "string" ? o.judged_at.trim() : undefined,
    template_source:
      o.template_source === "user" || o.template_source === "ai-scene"
        ? o.template_source
        : undefined,
    summary,
    useExistingTemplate: false,
    reason,
    usageScenarios,
    requirementHighlights: parseStringArray(o.requirementHighlights),
    templateCatalog: parseTemplateCatalog(o.templateCatalog),
    matchExplanation:
      typeof o.matchExplanation === "string" && o.matchExplanation.trim()
        ? o.matchExplanation.trim()
        : undefined,
  };
}

export function parseTemplateSelectionDocument(
  raw: string,
  forbiddenTemplateIds?: readonly string[],
): TemplateSelectionDocument | undefined {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return validateTemplateSelectionDocument(JSON.parse(trimmed), forbiddenTemplateIds);
  } catch {
    return undefined;
  }
}

export function toTemplateJudgment(
  doc: TemplateSelectionDocument | undefined,
): TemplateJudgment | undefined {
  if (!doc) return undefined;
  if (doc.useExistingTemplate) {
    return {
      useExistingTemplate: true,
      templateId: doc.templateId,
      templateName: doc.templateName,
      reason: doc.reason,
      usageScenarios: doc.usageScenarios,
      summary: doc.summary,
      matchExplanation: doc.matchExplanation,
      requirementHighlights: doc.requirementHighlights,
    };
  }
  return {
    useExistingTemplate: false,
    reason: doc.reason,
    usageScenarios: doc.usageScenarios,
    summary: doc.summary,
    matchExplanation: doc.matchExplanation,
    requirementHighlights: doc.requirementHighlights,
  };
}

/** 从产物 JSON 文本解析模版匹配结果 */
export function parseTemplateJudgment(
  raw: string,
  forbiddenTemplateIds?: readonly string[],
): TemplateJudgment | undefined {
  return toTemplateJudgment(parseTemplateSelectionDocument(raw, forbiddenTemplateIds));
}

export function templateDisplayName(judgment: TemplateJudgment | undefined) {
  if (!judgment?.useExistingTemplate) return "";
  return (
    judgment.templateName?.trim() ||
    judgment.templateId?.trim() ||
    ""
  );
}

/** 无匹配时的展示文案：summary → reason → matchExplanation */
export function templateNoMatchDetail(judgment: TemplateJudgment | undefined) {
  if (!judgment || judgment.useExistingTemplate) return "";
  return (
    judgment.summary?.trim() ||
    judgment.reason?.trim() ||
    judgment.matchExplanation?.trim() ||
    ""
  );
}
