import { Effect, Schema } from "effect"
import { Tool } from "@opencode/schema/tool"
import type { SessionTool } from "@opencode/schema/session-tool"

export interface ToolDefinition {
  readonly description?: string
  readonly args?: Record<string, unknown>
  readonly jsonSchema?: unknown
  readonly input?: Tool.ValueSchema
  readonly output?: Tool.ValueSchema
  readonly execute: (args: Record<string, unknown>, context: Record<string, unknown>) => unknown
}

export const isToolDefinition = (value: unknown): value is ToolDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ToolDefinition).execute === "function" &&
  typeof (value as ToolDefinition).description === "string"

export function inputFromArgs(args: Record<string, unknown>): Tool.ValueSchema {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  const kinds: Record<string, string> = {
    ZodString: "string",
    ZodNumber: "number",
    ZodBoolean: "boolean",
    ZodArray: "array",
    ZodObject: "object",
  }
  for (const [key, value] of Object.entries(args)) {
    const schema = value as {
      description?: string
      _def?: { typeName?: string; description?: string }
      isOptional?: () => boolean
    }
    const kind = kinds[schema?._def?.typeName ?? ""]
    const description = schema?.description ?? schema?._def?.description
    properties[key] = { ...(kind ? { type: kind } : {}), ...(description ? { description } : {}) }
    if (!(schema?.isOptional?.() ?? schema?._def?.typeName === "ZodOptional")) required.push(key)
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) } as Tool.ValueSchema
}

const isValueSchema = (value: unknown): value is Tool.ValueSchema =>
  Schema.isSchema(value) ||
  (typeof value === "object" &&
    value !== null &&
    (typeof (value as { pipe?: unknown }).pipe === "function" || "~standard" in value || "type" in value))

export function toResult(value: unknown, structured = false): Tool.Result {
  if (structured) {
    if (typeof value === "object" && value !== null) {
      const record = value as { title?: string; output?: unknown; metadata?: Record<string, unknown> }
      return {
        output: record.output,
        metadata: { ...record.metadata, ...(record.title === undefined ? {} : { title: record.title }) },
      }
    }
    return { output: value }
  }
  const text =
    typeof value === "string"
      ? value
      : typeof value === "object" && value !== null
        ? typeof (value as { output?: unknown }).output === "string"
          ? (value as { output: string }).output
          : JSON.stringify((value as { output?: unknown }).output ?? value)
        : String(value)
  if (typeof value === "object" && value !== null) {
    const record = value as { title?: string; metadata?: Record<string, unknown> }
    return {
      output: text,
      content: text,
      metadata: { ...record.metadata, ...(record.title === undefined ? {} : { title: record.title }) },
    }
  }
  return { output: text, content: text }
}

/** Runs only inside the Sandbox worker. Core uses its manifest, never this user executor. */
export function toToolInfo(name: SessionTool.Name, def: ToolDefinition, directory: string): Tool.Info {
  const input = isValueSchema(def.input)
    ? def.input
    : isValueSchema(def.jsonSchema)
      ? def.jsonSchema
      : def.args
        ? inputFromArgs(def.args)
        : ({ type: "object", properties: {} } as Tool.ValueSchema)
  const structured = isValueSchema(def.output)
  return {
    name,
    description: def.description ?? "",
    input,
    output: structured ? def.output : ({ type: "string" } as Tool.ValueSchema),
    options: { codemode: false },
    execute: (args, context) =>
      Effect.tryPromise({
        try: () => Promise.resolve(def.execute((args ?? {}) as Record<string, unknown>, { ...context, directory })),
        catch: (cause) => new Tool.Error({ message: cause instanceof Error ? cause.message : String(cause) }),
      }).pipe(Effect.map((value) => toResult(value, structured))),
  }
}
