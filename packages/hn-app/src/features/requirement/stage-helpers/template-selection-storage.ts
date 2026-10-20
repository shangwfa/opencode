export type TemplateSelectionDecision = {
  accepted: boolean;
  templateId?: string;
  templateName?: string;
};

const key = (sessionId: string) =>
  `req-chat-template-selection:${sessionId.trim()}`;

export function storeTemplateSelectionDecision(
  sessionId: string,
  decision: TemplateSelectionDecision,
) {
  sessionStorage.setItem(key(sessionId), JSON.stringify(decision));
}

export function readTemplateSelectionDecision(
  sessionId: string,
): TemplateSelectionDecision | undefined {
  const raw = sessionStorage.getItem(key(sessionId.trim()));
  if (!raw) return undefined;
  try {
    const body = JSON.parse(raw) as TemplateSelectionDecision;
    if (typeof body.accepted !== "boolean") return undefined;
    return body;
  } catch {
    return undefined;
  }
}
