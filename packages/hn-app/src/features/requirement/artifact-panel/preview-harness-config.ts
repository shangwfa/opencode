export type PreviewHarnessConfigOptions = {
  autoRecording: boolean;
  autoInjectToken: boolean;
  accessToken?: string;
  baseHref?: string;
};

export function readBossAccessToken(): string | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const token =
      localStorage.getItem("ACCESS_TOKEN")?.trim() ||
      localStorage.getItem("accessToken")?.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export function buildPreviewFrameUrl(
  rawUrl: string,
  options: PreviewHarnessConfigOptions,
): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return "";
  try {
    const baseHref =
      options.baseHref ??
      (typeof window === "object" ? window.location.href : undefined);
    const url = baseHref ? new URL(trimmed, baseHref) : new URL(trimmed);
    return url.toString();
  } catch {
    return trimmed;
  }
}

export function getHarnessConfigValue(
  key: string,
  options: PreviewHarnessConfigOptions,
) {
  switch (key) {
    case "enableOpenCodeSelection":
      return true;
    case "enableRrweb":
      return options.autoRecording;
    case "replaceToken":
      return options.autoInjectToken && options.accessToken
        ? options.accessToken
        : null;
    default:
      return null;
  }
}
