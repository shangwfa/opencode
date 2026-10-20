import { createHash } from "node:crypto"
import type { RuntimeActionDefinition } from "../engine/catalog-store.js"

export interface AppMcpTool {
  readonly actionId: string
  readonly name: string
  readonly description: string
  readonly inputSchema: RuntimeActionDefinition["inputSchema"]
  readonly contractHash: string
  readonly annotations: { readonly readOnlyHint: boolean; readonly destructiveHint: boolean; readonly openWorldHint: true }
}

export interface AppMcpToolLimits {
  readonly maxTools: number
  readonly maxToolBytes: number
  readonly maxTotalBytes: number
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex")

/** Ignore documentation text, but preserve property names even when named `description`. */
function canonical(value: unknown, schema = false, propertyMap = false): unknown {
  if (Array.isArray(value)) return value.map((item) => canonical(item, schema))
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, item]) => {
    if (schema && !propertyMap && ["description", "title", "$comment", "examples"].includes(key)) return []
    const map = schema && !propertyMap && ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"].includes(key)
    const childSchema = schema && (propertyMap || map || ["items", "additionalProperties", "unevaluatedProperties", "contains", "allOf", "anyOf", "oneOf", "not", "if", "then", "else", "prefixItems", "propertyNames"].includes(key))
    return [[key, canonical(item, childSchema, map)]]
  }))
}

export function appMcpContractHash(action: RuntimeActionDefinition): string {
  return digest(JSON.stringify(canonical({
    service: action.service,
    actionId: action.id,
    inputSchema: canonical(action.inputSchema, true),
    requiredScopes: [...action.requiredScopes].sort(),
    providerPermissions: [...action.providerPermissions].sort(),
    operationType: action.operationType,
    execution: action.execution,
  })))
}

export function appMcpToolName(actionId: string): string {
  if (!actionId.trim() || /[*?]/.test(actionId)) throw new Error("Action identity must be non-empty and literal.")
  const readable = actionId.replaceAll(".", "__").replace(/[^A-Za-z0-9_-]/g, "_")
  // Always include an identity suffix so normalization never aliases two actions.
  return `${readable.slice(0, 51)}_${digest(actionId).slice(0, 12)}`
}

export function selectAppMcpTools(
  service: string,
  actionIds: readonly string[],
  actions: readonly RuntimeActionDefinition[],
  limits: AppMcpToolLimits,
): readonly AppMcpTool[] {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error("MCP tool limits must be configured as positive integers.")
  }
  if (!service.trim() || actionIds.length === 0 || actionIds.length > limits.maxTools)
    throw new Error("Selected MCP tool count is outside the configured limits.")
  if (new Set(actionIds).size !== actionIds.length) throw new Error("Selected MCP actions must be unique.")
  const catalog = new Map(actions.map((action) => [action.id, action]))
  const names = new Set<string>()
  const tools = actionIds.map((id): AppMcpTool => {
    const action = catalog.get(id)
    if (!action || action.service !== service) throw new Error("Selected action does not belong to this application.")
    if (action.inputSchema.type !== "object") throw new Error("Selected action requires an object input schema.")
    const name = appMcpToolName(id)
    if (names.has(name)) throw new Error("Selected MCP tool names collide.")
    names.add(name)
    const tool: AppMcpTool = {
      actionId: id,
      name,
      description: action.description,
      inputSchema: action.inputSchema,
      contractHash: appMcpContractHash(action),
      annotations: {
        readOnlyHint: action.operationType === "read",
        destructiveHint: action.operationType === "destructive",
        openWorldHint: true,
      },
    }
    if (Buffer.byteLength(JSON.stringify(tool)) > limits.maxToolBytes) throw new Error("MCP tool exceeds its configured byte limit.")
    return tool
  })
  if (Buffer.byteLength(JSON.stringify(tools)) > limits.maxTotalBytes) throw new Error("MCP tool manifest exceeds its configured byte limit.")
  return tools
}
