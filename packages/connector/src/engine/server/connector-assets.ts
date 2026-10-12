import { join } from "node:path";

/**
 * Bundled runtime assets of this package: `catalog/` (generated provider catalog) and `migrations/`
 * (SQL migrations). Located from `import.meta.dirname` (this file lives in `src/engine/server/`), so the
 * directory travels with the source tree regardless of the process working directory.
 */
export function getConnectorAssetDirectory(): string {
  return isStandaloneExecutable() ? join(import.meta.dirname, "open-connector") : join(import.meta.dirname, "..", "..", "..", "assets");
}

/** Only Bun defines the `Bun` global; Node and workerd never do, so the read is safe everywhere. */
export function isStandaloneExecutable(): boolean {
  return (globalThis as { Bun?: { isStandaloneExecutable?: boolean } }).Bun?.isStandaloneExecutable === true;
}
