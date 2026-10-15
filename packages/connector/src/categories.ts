/**
 * Connector category taxonomy.
 *
 * Provider definitions declare `categories: string[]` (see `engine/core/types.ts`);
 * this module aggregates that per-provider metadata into the category taxonomy
 * served to clients and powers category filtering of the provider directory.
 *
 * Entry point for the category feature; exposed as `@opencode/connector/categories`.
 */

/** One category label with how many providers declare it. */
export type ConnectorCategory = {
  /** The category name as declared by providers, e.g. `Developer Tools`. */
  readonly id: string
  /** Same as {@link ConnectorCategory.id}; kept distinct for client rendering. */
  readonly displayName: string
  /** Number of providers declaring this category. */
  readonly providerCount: number
}

/** Minimal provider shape needed for aggregation. */
export type CategorizedProvider = {
  readonly categories: ReadonlyArray<string>
}

/**
 * Aggregates per-provider category labels into a stable taxonomy.
 *
 * Empty labels are dropped; labels are deduplicated case-insensitively keeping
 * the first-seen casing. Output is sorted alphabetically (case-insensitive) so
 * clients get a stable order regardless of provider iteration order.
 */
export function collectCategories(providers: ReadonlyArray<CategorizedProvider>): ReadonlyArray<ConnectorCategory> {
  const byKey = new Map<string, ConnectorCategory>()
  for (const provider of providers) {
    for (const raw of provider.categories ?? []) {
      const label = raw.trim()
      if (!label) continue
      const key = label.toLowerCase()
      const existing = byKey.get(key)
      if (existing) {
        byKey.set(key, {
          id: existing.id,
          displayName: existing.displayName,
          providerCount: existing.providerCount + 1,
        })
      } else {
        byKey.set(key, { id: label, displayName: label, providerCount: 1 })
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()))
}

/** Case-insensitive membership test for one provider/category pair. */
export function matchesCategory(provider: CategorizedProvider, category: string): boolean {
  const key = category.trim().toLowerCase()
  if (!key) return true
  return (provider.categories ?? []).some((label) => label.trim().toLowerCase() === key)
}

/**
 * Filters providers by one category label (case-insensitive).
 * An empty/blank category returns the input unchanged.
 */
export function filterByCategory<T extends CategorizedProvider>(
  providers: ReadonlyArray<T>,
  category: string | undefined,
): ReadonlyArray<T> {
  if (!category || !category.trim()) return providers
  return providers.filter((provider) => matchesCategory(provider, category))
}
