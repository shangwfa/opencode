/**
 * Path matching for tool inputs vs indexed file_path values.
 * Pure — no I/O. Accepts `./src/x.ts`, `src/x.ts`, `/workspace/repo/src/x.ts`,
 * or path suffix on a `/` boundary (bare `ar.ts` must not match `bar.ts`).
 */

export const pathMatches = (indexed: string, wanted: string): boolean => {
  const a = indexed.replace(/^\.\//, "").replace(/\/+/g, "/")
  const b = wanted.replace(/^\.\//, "").replace(/^\/workspace\//, "").replace(/\/+/g, "/")
  if (!b) return false
  if (a === b) return true
  if (a.endsWith("/" + b)) return true
  if (b.endsWith("/" + a)) return true
  if (!b.includes("/") && a.endsWith("/" + b)) return true
  return false
}

/** Filter items with a `file_path` field by user-supplied path fragment. */
export const filterByFilePath = <T extends { file_path: string }>(items: T[], file?: string): T[] => {
  if (!file) return items
  const wanted = file.replace(/^\.\//, "")
  const narrowed = items.filter((n) => pathMatches(n.file_path, wanted))
  return narrowed.length > 0 ? narrowed : items
}
