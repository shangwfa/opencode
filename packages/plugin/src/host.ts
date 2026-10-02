export * as Host from "./host.js"

import path from "node:path"
import { importModule, resolveModule } from "@opencode/util/runtime-import"

export interface Target {
  readonly directory: string
  readonly name?: string
}

export interface Entrypoints {
  readonly server?: string
  readonly tui?: string
  readonly rpc?: string
}

export function resolve(target: Target): Entrypoints {
  const entry = (subpaths: readonly string[]) => {
    for (const subpath of subpaths) {
      const specifier = target.name
        ? [target.name, subpath].filter(Boolean).join("/")
        : path.resolve(target.directory, subpath || "index")
      try {
        return resolveModule(specifier, target.directory)
      } catch (error) {
        if (!isMissingResolution(error)) throw error
      }
    }
    return undefined
  }
  return { server: entry(["server", ""]), tui: entry(["tui"]), rpc: entry(["rpc"]) }
}

// A missing subpath is expected while probing entrypoints; anything else must
// propagate. Bun's `ResolveMessage` does not extend `Error`, so decide by the
// resolution code rather than by prototype.
const MISSING_RESOLUTION_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
  "ERR_PACKAGE_PATH_NOT_EXPORTED",
  "ERR_UNSUPPORTED_DIR_IMPORT",
])

function isMissingResolution(error: unknown) {
  if (typeof error !== "object" || error === null) return false
  const code = (error as { code?: unknown }).code
  return typeof code === "string" && MISSING_RESOLUTION_CODES.has(code)
}

export function load(entrypoint: string): Promise<unknown> {
  return importModule(entrypoint)
}
