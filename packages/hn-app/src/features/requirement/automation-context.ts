import {
  isAbsolutePreviewUrl,
  resolvePreviewFrameUrl,
} from "./artifact-panel/preview-url";
import { readBossAccessToken } from "./artifact-panel/preview-harness-config";

export const AUTOMATION_AGENT = "dyn-cdp-automation";
export const AUTOMATION_CONTEXT_PREFIX = "[Automation Context]";

type ResolveAutomationContextInput = {
  previewBaseUrl: string | undefined;
  previewUrl: string;
  autoInjectToken: boolean;
  customToken: string;
  readAccessToken?: () => string | undefined;
};

export type AutomationContext = {
  previewUrl: string;
  accessToken: string | null;
  ready: boolean;
  text: string;
};

export function resolveAutomationAccessToken(input: {
  autoInjectToken: boolean;
  customToken: string;
  readAccessToken?: () => string | undefined;
}): string | null {
  if (!input.autoInjectToken) return null;
  const customToken = input.customToken.trim();
  if (customToken) return customToken;
  return (input.readAccessToken ?? readBossAccessToken)()?.trim() || null;
}

export function buildAutomationContextText(input: {
  previewUrl: string;
  accessToken: string | null;
}): string {
  return `${AUTOMATION_CONTEXT_PREFIX}\n${JSON.stringify({
    preview_url: input.previewUrl,
    access_token: input.accessToken,
  })}`;
}

export function resolveAutomationContext(
  input: ResolveAutomationContextInput,
): AutomationContext {
  const previewUrl = resolvePreviewFrameUrl(
    input.previewUrl,
    input.previewBaseUrl,
  ).trim();
  const accessToken = resolveAutomationAccessToken(input);

  return {
    previewUrl,
    accessToken,
    ready: isAbsolutePreviewUrl(previewUrl),
    text: buildAutomationContextText({ previewUrl, accessToken }),
  };
}

export function appendAutomationContext(
  runtimeContextText: string | undefined,
  automationContextText: string,
): string {
  return [runtimeContextText?.trim(), automationContextText.trim()]
    .filter(Boolean)
    .join("\n\n");
}
