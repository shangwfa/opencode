export * as SessionTools from "./tools.js"

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@opencode/ai"
import { Tool } from "@opencode/schema/tool"
import { SessionTool } from "@opencode/schema/session-tool"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Database } from "../database/database.js"
import type { Session } from "../session.js"
import { SessionToolTable } from "./sql.js"

export type Info = SessionTool.Info
export type Payload = SessionTool.Payload

/** The shape accepted for session tool source: V1 `tool({ args })` definitions or V2 `Tool.Info`. */
interface ToolDefinition {
  readonly description?: string
  readonly args?: Record<string, unknown>
  readonly jsonSchema?: unknown
  readonly input?: Tool.ValueSchema
  readonly output?: Tool.ValueSchema
  readonly execute: (args: Record<string, unknown>, context: Record<string, unknown>) => unknown
}

export interface Interface {
  readonly list: (sessionID: Session.ID) => Effect.Effect<ReadonlyArray<Info>>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info>
  readonly remove: (sessionID: Session.ID, name: SessionTool.Name) => Effect.Effect<void>
  readonly clear: (sessionID: Session.ID) => Effect.Effect<void>
  /** Load durable definitions as request overlay tools; broken sources are skipped. */
  readonly load: (session: Session.Info) => Effect.Effect<ReadonlyArray<Tool.Info>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTools") {}

/**
 * Dynamic module cache keyed by code content. An upsert with new code gets a
 * new key and therefore a fresh module, which is what makes code updates take
 * effect on the next request without any explicit invalidation.
 */
const modules = new Map<string, Promise<any>>()

const PLUGIN_IMPORT = /import\s*\{\s*tool\s*\}\s*from\s*["'](?:@opencode-ai\/plugin|@opencode\/plugin)["'];?/g

/**
 * V1 tool sources import `tool` from `@opencode-ai/plugin`, where `tool()` is
 * an identity constructor and `tool.schema.*` are zod builders. V2 loads the
 * source without that package, so the import is replaced by a dependency-free
 * shim that keeps the V1 source form working unchanged.
 */
const TOOL_SHIM = `const __stlSchema = (typeName) => ({
  _def: { typeName },
  describe(description) {
    this.description = description
    this._def = { ...this._def, description }
    return this
  },
  isOptional() {
    return this._def.typeName === "ZodOptional"
  },
})
const tool = (def) => def
tool.schema = {
  string: () => __stlSchema("ZodString"),
  number: () => __stlSchema("ZodNumber"),
  boolean: () => __stlSchema("ZodBoolean"),
  array: () => __stlSchema("ZodArray"),
  object: () => __stlSchema("ZodObject"),
  optional: (inner) => ({ ...inner, _def: { typeName: "ZodOptional" }, isOptional: () => true }),
}
`

export function importToolCode(code: string): Promise<any> {
  const key = createHash("sha256").update(code).digest("hex")
  const cached = modules.get(key)
  if (cached) return cached
  const promise = (async () => {
    const source = code.replace(PLUGIN_IMPORT, TOOL_SHIM)
    const name = `.opencode-stl-${key.slice(0, 12)}-${Date.now()}.ts`
    let file: string | undefined
    // Prefer a workspace directory so user sources can resolve workspace
    // imports the way V1's loader did; the temp directory is the fallback.
    for (const dir of [import.meta.dir, os.tmpdir()]) {
      const candidate = path.join(dir, name)
      try {
        await fs.writeFile(candidate, source)
        file = candidate
        break
      } catch {}
    }
    if (!file) throw new Error("Failed to write temp file for session tool import")
    try {
      return await import(pathToFileURL(file).href)
    } finally {
      await fs.unlink(file).catch(() => {})
    }
  })()
  modules.set(key, promise)
  return promise
}

const isToolDefinition = (value: unknown): value is ToolDefinition =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ToolDefinition).execute === "function" &&
  typeof (value as ToolDefinition).description === "string"

const schemaKind = (value: unknown): string | undefined => {
  const typeName = (value as { _def?: { typeName?: string } } | undefined)?._def?.typeName
  switch (typeName) {
    case "ZodString":
      return "string"
    case "ZodNumber":
      return "number"
    case "ZodBoolean":
      return "boolean"
    case "ZodArray":
      return "array"
    case "ZodObject":
      return "object"
    default:
      return undefined
  }
}

const schemaDescription = (value: unknown): string | undefined =>
  (value as { description?: string } | undefined)?.description ??
  (value as { _def?: { description?: string } } | undefined)?._def?.description

const schemaOptional = (value: unknown): boolean =>
  typeof (value as { isOptional?: () => boolean } | undefined)?.isOptional === "function"
    ? (value as { isOptional: () => boolean }).isOptional()
    : (value as { _def?: { typeName?: string } } | undefined)?._def?.typeName === "ZodOptional"

/**
 * Derives a permissive JSON Schema from a V1 zod `args` shape. Argument
 * validation stays with the tool's own `execute`, so only catalog-facing
 * type/description/required information is extracted.
 */
export function inputFromArgs(args: Record<string, unknown>): Tool.ValueSchema {
  const properties: Record<string, unknown> = {}
  const required: string[] = []
  for (const [key, value] of Object.entries(args)) {
    const kind = schemaKind(value)
    const description = schemaDescription(value)
    properties[key] = { ...(kind ? { type: kind } : {}), ...(description ? { description } : {}) }
    if (!schemaOptional(value)) required.push(key)
  }
  return { type: "object", properties, ...(required.length > 0 ? { required } : {}) } as Tool.ValueSchema
}

const isValueSchema = (value: unknown): value is Tool.ValueSchema =>
  typeof value === "object" &&
  value !== null &&
  (typeof (value as { pipe?: unknown }).pipe === "function" ||
    "~standard" in (value as object) ||
    "type" in (value as object))

/** V1 `tool()` results and plain strings map onto the V2 Tool.Result contract. */
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
          ? ((value as { output: string }).output as string)
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

/**
 * Wraps one loaded definition as a request-overlay tool. Broken definitions
 * never reach this point; user-code failures surface as tool failures so the
 * model can continue the turn.
 */
export function toToolInfo(name: SessionTool.Name, def: ToolDefinition, directory: string): Tool.Info {
  const input = isValueSchema(def.input)
    ? def.input
    : isValueSchema(def.jsonSchema)
      ? def.jsonSchema
      : def.args
        ? inputFromArgs(def.args)
        : ({ type: "object", properties: {} } as Tool.ValueSchema)
  // V1 results carry display text in `output`; without a declared output schema
  // the registry rejects output values, so the text shape is declared here.
  const structured = isValueSchema(def.output)
  return {
    name,
    description: def.description ?? "",
    input,
    output: structured ? def.output : ({ type: "string" } as Tool.ValueSchema),
    // Session tools are user-authored task helpers; keep them on the native
    // tool list like V1 did instead of folding them into the Code Mode catalog.
    options: { codemode: false },
    execute: (args, context) =>
      Effect.tryPromise({
        try: () => Promise.resolve(def.execute((args ?? {}) as Record<string, unknown>, { ...context, directory })),
        catch: (cause) => new Error(cause instanceof Error ? cause.message : String(cause)),
      }).pipe(
        Effect.map((value) => toResult(value, structured)),
        Effect.mapError((error) => new ToolFailure({ message: error.message })),
      ),
  }
}

function fromRow(row: typeof SessionToolTable.$inferSelect): Info {
  return SessionTool.Info.make({
    id: row.id,
    name: row.name,
    description: row.description,
    code: row.code,
    time: { created: row.time_created, updated: row.time_updated },
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const stored = (sessionID: Session.ID) =>
      db
        .select()
        .from(SessionToolTable)
        .where(eq(SessionToolTable.session_id, sessionID))
        .all()
        .pipe(
          Effect.map((rows) => rows.map(fromRow).toSorted((a, b) => a.name.localeCompare(b.name))),
          Effect.orDie,
        )

    return Service.of({
      list: stored,
      create: (sessionID, input) =>
        Effect.gen(function* () {
          const now = Date.now()
          yield* db
            .insert(SessionToolTable)
            .values({
              id: SessionTool.ID.create(),
              session_id: sessionID,
              name: input.name,
              description: input.description,
              code: input.code,
              time_created: now,
              time_updated: now,
            })
            .onConflictDoUpdate({
              target: [SessionToolTable.session_id, SessionToolTable.name],
              set: {
                description: input.description,
                code: input.code,
                time_updated: sql`max(${now}, ${SessionToolTable.time_updated} + 1)`,
              },
            })
            .run()
            .pipe(Effect.orDie)
          const row = yield* db
            .select()
            .from(SessionToolTable)
            .where(and(eq(SessionToolTable.session_id, sessionID), eq(SessionToolTable.name, input.name)))
            .get()
            .pipe(Effect.orDie)
          if (!row) return yield* Effect.die(new Error(`Session tool upsert disappeared: ${input.name}`))
          return fromRow(row)
        }),
      remove: (sessionID, name) =>
        db
          .delete(SessionToolTable)
          .where(and(eq(SessionToolTable.session_id, sessionID), eq(SessionToolTable.name, name)))
          .run()
          .pipe(Effect.orDie),
      clear: (sessionID) =>
        db.delete(SessionToolTable).where(eq(SessionToolTable.session_id, sessionID)).run().pipe(Effect.orDie),
      load: (session) =>
        Effect.gen(function* () {
          const rows = yield* stored(session.id)
          const tools: Tool.Info[] = []
          for (const row of rows) {
            const mod = yield* Effect.tryPromise({ try: () => importToolCode(row.code), catch: () => null }).pipe(
              Effect.catch(() => Effect.succeed(null)),
            )
            if (!mod) continue
            const def = (mod.default ?? mod) as unknown
            if (!isToolDefinition(def)) continue
            tools.push(toToolInfo(row.name, def, session.location.directory))
          }
          return tools
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node],
})
