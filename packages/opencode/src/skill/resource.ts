import { createHash } from "crypto"
import path from "path"
import { Schema } from "effect"

export const MAX_SIZE = 256 * 1024
export const MAX_BUNDLE_SIZE = 1024 * 1024
export const MAX_COUNT = 64
export const SANDBOX_ROOT = "/home/sandbox/.local/share/opencode/session-skills"

export const Type = Schema.Literals(["doc", "script", "template", "asset"])
export type Type = Schema.Schema.Type<typeof Type>

export class InvalidResourceError extends Schema.TaggedErrorClass<InvalidResourceError>()("SkillInvalidResourceError", {
  message: Schema.String,
  path: Schema.optional(Schema.String),
}) {}

export const Input = Schema.Struct({
  path: Schema.String,
  type: Type,
  content: Schema.String,
})
export type Input = Schema.Schema.Type<typeof Input>

export const Stored = Schema.Struct({
  path: Schema.String,
  type: Type,
  content: Schema.String,
  size: Schema.Number,
  digest: Schema.String,
})
export type Stored = Schema.Schema.Type<typeof Stored>

export const Info = Schema.Struct({
  path: Schema.String,
  type: Type,
  size: Schema.Number,
  digest: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

export function make(input: Input): Stored {
  const resourcePath = normalizePath(input.path)
  const size = Buffer.byteLength(input.content)
  if (size > MAX_SIZE) {
    throw new InvalidResourceError({ message: `Skill resource exceeds ${MAX_SIZE} bytes`, path: resourcePath })
  }
  return {
    path: resourcePath,
    type: input.type,
    content: input.content,
    size,
    digest: digest(input.content),
  }
}

export function fromStored(input: Input & { size?: number; digest?: string }): Stored {
  return make(input)
}

export function metadata(resource: Stored): Info {
  return {
    path: resource.path,
    type: resource.type,
    size: resource.size,
    digest: resource.digest,
  }
}

export function validateBundle(resources: readonly Stored[]) {
  if (resources.length > MAX_COUNT) {
    throw new InvalidResourceError({ message: `Skill has more than ${MAX_COUNT} resources` })
  }
  if (new Set(resources.map((resource) => resource.path)).size !== resources.length) {
    throw new InvalidResourceError({ message: "Skill contains duplicate resource paths" })
  }
  const size = resources.reduce((total, resource) => total + resource.size, 0)
  if (size > MAX_BUNDLE_SIZE) {
    throw new InvalidResourceError({ message: `Skill resources exceed ${MAX_BUNDLE_SIZE} bytes` })
  }
  return [...resources]
}

export function normalizePath(input: string) {
  const invalid = () => new InvalidResourceError({ message: "Invalid skill resource path", path: input })
  if (!input || input.includes("\0") || input.includes("\\") || path.posix.isAbsolute(input)) throw invalid()
  const segments = input.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) throw invalid()
  return segments.join("/")
}

export function kind(file: string): Type {
  if (file.startsWith("templates/")) return "template"
  if (file.startsWith("references/")) return "doc"
  const extension = path.extname(file)
  if ([".md", ".mdx", ".txt"].includes(extension)) return "doc"
  if ([".sh", ".bash", ".zsh", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) {
    return "script"
  }
  return "asset"
}

export function snapshot(content: string, resources: readonly Stored[]) {
  return digest(
    JSON.stringify({
      content,
      resources: resources
        .map((resource) => ({ path: resource.path, digest: resource.digest }))
        .toSorted((a, b) => a.path.localeCompare(b.path)),
    }),
  )
}

export function directory(sessionID: string, id: string, content: string, resources: readonly Stored[]) {
  return path.posix.join(SANDBOX_ROOT, sessionID, id, snapshot(content, resources))
}

export function directoryForName(sessionID: string, name: string, content: string, resources: readonly Stored[]) {
  return directory(sessionID, digest(name), content, resources)
}

export function isManagedPath(input: string) {
  const normalized = path.posix.normalize(input)
  return normalized === SANDBOX_ROOT || normalized.startsWith(`${SANDBOX_ROOT}/`)
}

function digest(content: string) {
  return createHash("sha256").update(content).digest("hex")
}

export * as SkillResource from "./resource"
