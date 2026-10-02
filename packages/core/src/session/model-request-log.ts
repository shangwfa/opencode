export * as ModelRequestLog from "./model-request-log.js"

import type { LLMRequest } from "@opencode/ai"
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"

const FILE = "model-requests.jsonl"
/**
 * A record past this size is marked truncated. Callers use these records to prove
 * that content is *absent* from a request, and a truncated record cannot do that.
 */
const MAX_BYTES = 32 * 1024 * 1024

/** The model-facing tool catalog, exactly as the provider receives it. */
export type RecordedTool = {
  readonly name: string
  readonly description?: string
  readonly inputSchema?: unknown
}

export type Entry = {
  readonly time: number
  readonly sessionID: string
  readonly kind: string
  readonly agent: string
  readonly model: { readonly id: string; readonly provider: string; readonly route: string }
  readonly toolNames: ReadonlyArray<string>
  readonly tools: ReadonlyArray<RecordedTool>
  readonly system?: unknown
  readonly messages?: unknown
  readonly toolChoice?: unknown
  readonly truncated: boolean
}

export type Input = {
  readonly sessionID: string
  readonly kind: string
  readonly agent: string
  readonly request: LLMRequest
}

/** Audit is opt-in: unset means no directory, no file, and no request projection cost. */
export const directory = (env: Readonly<Record<string, string | undefined>> = process.env) =>
  env["OPENCODE_MODEL_REQUEST_LOG"]?.trim() || undefined

export const file = (env: Readonly<Record<string, string | undefined>> = process.env) => {
  const target = directory(env)
  return target ? join(target, FILE) : undefined
}

const project = (input: Input) => {
  const request = input.request
  // A namespace entry carries nested tools; auditing has to see every schema the
  // provider can be shown, so flatten rather than only reading the top level.
  const tools: Array<RecordedTool> = []
  const collect = (entries: NonNullable<LLMRequest["tools"]>) => {
    for (const entry of entries) {
      if (entry.type === "namespace") {
        collect(entry.tools)
        continue
      }
      tools.push({
        name: entry.name,
        description: entry.description,
        inputSchema: entry.inputSchema,
      })
    }
  }
  collect(request.tools ?? [])
  return {
    time: Date.now(),
    sessionID: input.sessionID,
    kind: input.kind,
    agent: input.agent,
    model: {
      id: request.model.id,
      provider: request.model.provider,
      route: request.model.route.id,
    },
    toolNames: tools.map((tool) => tool.name),
    tools,
    system: request.system,
    messages: request.messages,
    toolChoice: request.toolChoice,
  }
}

/**
 * Append one audited model request. `http` and `providerOptions` are deliberately
 * not projected: they carry credentials and provider settings, and neither is
 * needed to audit what the model was shown.
 */
export function record(input: Input, env: Readonly<Record<string, string | undefined>> = process.env): Entry | undefined {
  const target = file(env)
  if (!target) return undefined
  let entry: Entry = { ...project(input), truncated: false }
  let line = JSON.stringify(entry)
  if (line.length > MAX_BYTES) {
    entry = { ...entry, system: undefined, messages: undefined, truncated: true }
    line = JSON.stringify(entry)
  }
  try {
    mkdirSync(directory(env)!, { recursive: true })
    appendFileSync(target, `${line}\n`)
  } catch {
    // Auditing must never break a model call; an unwritable directory is not
    // worth failing the Session over.
    return undefined
  }
  return entry
}
