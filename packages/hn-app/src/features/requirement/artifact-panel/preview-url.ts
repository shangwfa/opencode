const ABSOLUTE_HTTP_URL_RE = /^https?:\/\//i;

function normalizeBaseHref(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    url.search = "";
    url.hash = "";
    if (!url.pathname.endsWith("/")) {
      url.pathname = `${url.pathname}/`;
    }
    return url.toString();
  } catch {
    return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
  }
}

function routeFromUrl(url: URL): string {
  return `${url.pathname || "/"}${url.search}${url.hash}`;
}

export function isAbsolutePreviewUrl(url: string): boolean {
  return ABSOLUTE_HTTP_URL_RE.test(url.trim());
}

export function resolvePreviewFrameUrl(
  displayUrl: string,
  previewBaseUrl: string | undefined,
): string {
  const trimmed = displayUrl.trim();
  if (!trimmed) return "";
  if (isAbsolutePreviewUrl(trimmed)) return trimmed;

  const base = normalizeBaseHref(previewBaseUrl ?? "");
  if (!base) return trimmed;

  try {
    const route = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
    return new URL(route, base).toString();
  } catch {
    return trimmed;
  }
}

export function normalizePreviewDisplayUrl(
  href: string,
  previewBaseUrl: string | undefined,
): string {
  const trimmed = href.trim();
  if (!trimmed) return "";

  const base = normalizeBaseHref(previewBaseUrl ?? "");
  if (!base) return trimmed;

  try {
    const current = new URL(trimmed, base);
    const baseUrl = new URL(base);
    const basePath = baseUrl.pathname.endsWith("/")
      ? baseUrl.pathname
      : `${baseUrl.pathname}/`;
    const basePathWithoutSlash = basePath.slice(0, -1);

    if (
      current.origin === baseUrl.origin &&
      (current.pathname === basePathWithoutSlash ||
        current.pathname === baseUrl.pathname ||
        current.pathname.startsWith(basePath))
    ) {
      const path =
        current.pathname === basePathWithoutSlash
          ? ""
          : current.pathname.slice(basePath.length);
      return `/${path}${current.search}${current.hash}`;
    }
  } catch {
    return trimmed;
  }

  return trimmed;
}

export function previewOriginFromUrl(url: string): string | undefined {
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  try {
    return new URL(trimmed).origin;
  } catch {
    return undefined;
  }
}
