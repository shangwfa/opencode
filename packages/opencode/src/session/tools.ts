import { Agent } from "@/agent/agent"
import { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import { MCP } from "@/mcp"
import { Permission } from "@/permission"
import { Tool } from "@/tool/tool"
import { ToolJsonSchema } from "@/tool/json-schema"
import { ToolRegistry } from "@/tool/registry"
import { Truncate } from "@/tool/truncate"
import { ModelID } from "@/provider/schema"
import { Plugin } from "@/plugin"
import type { TaskPromptOps } from "@/tool/task"
import { type Tool as AITool, tool, jsonSchema, type ToolExecutionOptions, asSchema } from "ai"
import { Context, Effect, Layer, Option } from "effect"
import { MessageV2 } from "./message-v2"
import * as Session from "./session"
import { SessionProcessor } from "./processor"
import { PartID, type SessionID } from "./schema"
import * as Log from "@opencode-ai/core/util/log"
import { EffectBridge } from "@/effect/bridge"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { Database } from "@/storage/db"
import { PartTable } from "@/session/session.sql"
import { resolveSandboxOpts } from "@/session/sandbox-opts"
import { InstanceState } from "@/effect/instance-state"
import { and, eq, sql } from "drizzle-orm"

const log = Log.create({ service: "session.tools" })

type StoredToolPart = Omit<MessageV2.ToolPart, "id" | "sessionID" | "messageID">
type StoredRunningToolPart = Omit<StoredToolPart, "state"> & { state: MessageV2.ToolStateRunning }
type ToolPartRow = Pick<typeof PartTable.$inferSelect, "id" | "session_id" | "message_id" | "data">
type LifecycleDb = {
  select(): {
    from(table: typeof PartTable): {
      where(condition: ReturnType<typeof eq>): {
        get(): Promise<ToolPartRow | undefined>
      }
    }
  }
  update(table: typeof PartTable): {
    set(value: { data: StoredToolPart; time_updated: number }): {
      where(condition: ReturnType<typeof and>): {
        returning(input: { id: typeof PartTable.id }): {
          all(): Promise<Array<{ id: PartID }>>
        }
      }
    }
  }
}

export interface Interface {
  readonly markTimedOut: (input: {
    partID: PartID
    expectedStart: number
    timeoutMs: number
    now?: number
  }) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTools") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const maybeSandbox = yield* Effect.serviceOption(SandboxProvider.Service)

    const markTimedOut: Interface["markTimedOut"] = Effect.fn("SessionTools.markTimedOut")(function* (input) {
      const now = input.now ?? Date.now()
      const result = yield* Effect.tryPromise({
        try: () =>
          Database.transaction(
            async (tx: LifecycleDb) => {
              const row = await tx.select().from(PartTable).where(eq(PartTable.id, input.partID)).get()
              const part = parseToolPart(row?.data)
              if (!row || !part) return undefined
              if (part.state.time.start !== input.expectedStart) return undefined
              if (now - part.state.time.start <= input.timeoutMs) return undefined

              const updateData: StoredToolPart = {
                ...part,
                state: {
                  status: "error",
                  input: part.state.input,
                  error: `Tool execution timed out after ${Math.round(input.timeoutMs / 1000)}s (watchdog)`,
                  metadata: { ...(part.state.metadata ?? {}), timeout: true },
                  time: { start: part.state.time.start, end: now },
                },
              }
              const updated = await tx
                .update(PartTable)
                .set({ data: updateData, time_updated: now })
                .where(runningToolCasCondition(input.partID, input.expectedStart))
                .returning({ id: PartTable.id })
                .all()
              if (updated.length === 0) return undefined
              return { row, updateData }
            },
            { behavior: "immediate" },
          ),
        catch: (error) => new Error(`mark timed out failed for ${input.partID}: ${String(error)}`),
      }).pipe(
        Effect.catchCause((cause) => {
          log.error("mark timed out failed", { partID: input.partID, cause: String(cause) })
          return Effect.succeed(undefined)
        }),
      )
      if (!result) return false

      const sessionID = result.row.session_id as SessionID

      // P1: 联动资源取消 — 对有状态命令工具 interrupt sandbox command session
      if (COMMAND_TOOLS.has(result.updateData.tool)) {
        yield* Option.match(maybeSandbox, {
          onNone: () => Effect.void,
          onSome: (provider) =>
            provider.interrupt(sessionID).pipe(
              Effect.catchCause((cause) => {
                log.warn("sandbox interrupt on timeout failed", { partID: input.partID, cause: String(cause) })
                return Effect.void
              }),
            ),
        })
      }

      log.warn("marked tool as timed out", {
        partID: result.row.id,
        sessionID,
        tool: result.updateData.tool,
        runningMs: now - input.expectedStart,
      })
      return true
    })

    return Service.of({ markTimedOut })
  }),
)

const COMMAND_TOOLS = new Set(["bash", "task"])

export const defaultLayer = layer

function parseToolPart(data: unknown): StoredRunningToolPart | undefined {
  const value = typeof data === "string" ? parseJson(data) : data
  if (!isRecord(value)) return
  if (value.type !== "tool") return
  if (typeof value.callID !== "string") return
  if (typeof value.tool !== "string") return
  if (!isRecord(value.state)) return
  if (value.state.status !== "running") return
  if (!isRecord(value.state.time)) return
  if (typeof value.state.time.start !== "number") return
  return value as StoredRunningToolPart
}

function parseJson(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function runningToolCasCondition(partID: PartID, start: number) {
  if (Database.dialect === "pg") {
    return and(
      eq(PartTable.id, partID),
      sql`${PartTable.data}->>'type' = 'tool'`,
      sql`${PartTable.data}->'state'->>'status' = 'running'`,
      sql`(${PartTable.data}->'state'->'time'->>'start')::bigint = ${start}`,
    )
  }
  return and(
    eq(PartTable.id, partID),
    sql`json_extract(${PartTable.data}, '$.type') = 'tool'`,
    sql`json_extract(${PartTable.data}, '$.state.status') = 'running'`,
    sql`json_extract(${PartTable.data}, '$.state.time.start') = ${start}`,
  )
}

export const resolve = Effect.fn("SessionTools.resolve")(function* (input: {
  agent: Agent.Info
  model: Provider.Model
  session: Session.Info
  processor: Pick<SessionProcessor.Handle, "message" | "updateToolCall" | "completeToolCall">
  bypassAgentCheck: boolean
  messages: MessageV2.WithParts[]
  promptOps: TaskPromptOps
}) {
  using _ = log.time("resolveTools")
  const tools: Record<string, AITool> = {}
  const run = yield* EffectBridge.make()
  const plugin = yield* Plugin.Service
  const permission = yield* Permission.Service
  const registry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service
  const truncate = yield* Truncate.Service

  const maybeSandboxProvider = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
  const root = maybeSandboxProvider
    ? yield* Effect.promise(() => resolveSandboxOpts(input.session.id))
    : { id: input.session.id }
  const sandboxSessionID = root.id
  const useApp = root.pvcMode === "app" && !!root.appId?.trim()

  function getSandbox(): Promise<unknown> | null {
    if (!maybeSandboxProvider) {
      return null
    }
    const t0 = Date.now()
    return maybeSandboxProvider
      .getOrCreate(sandboxSessionID, useApp ? { pvcMode: root.pvcMode, appId: root.appId } : undefined)
      .pipe(Effect.runPromise)
      .then((sb) => {
        log.info("sandbox ready", { sandboxSessionID, ms: Date.now() - t0 })
        return sb
      })
      .catch((err) => {
        log.error("sandbox init failed", {
          sandboxSessionID,
          ms: Date.now() - t0,
          error: err instanceof Error ? err.message : String(err),
        })
        return null
      })
  }

  const context = (args: Record<string, unknown>, options: ToolExecutionOptions): Tool.Context => ({
    sessionID: input.session.id,
    sandboxSessionID,
    abort: options.abortSignal!,
    messageID: input.processor.message.id,
    callID: options.toolCallId,
    extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck, promptOps: input.promptOps },
    agent: input.agent.name,
    messages: input.messages,
    sandbox: getSandbox(),
    metadata: (val) =>
      input.processor.updateToolCall(options.toolCallId, (match) => {
        if (!["running", "pending"].includes(match.state.status)) return match
        return {
          ...match,
          state: {
            title: val.title,
            metadata: val.metadata,
            status: "running",
            input: args,
            time: { start: Date.now() },
          },
        }
      }),
    ask: (req) =>
      permission
        .ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: Permission.merge(input.agent.permission, input.session.permission ?? []),
        })
        .pipe(Effect.orDie),
  })

  for (const item of yield* registry.tools({
    modelID: ModelID.make(input.model.api.id),
    providerID: input.model.providerID,
    agent: input.agent,
    sessionID: input.session.id,
  })) {
    const schema = ProviderTransform.schema(input.model, ToolJsonSchema.fromTool(item))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
      execute(args, options) {
        return run.promise(
          Effect.gen(function* () {
            const ctx = context(args, options)
            yield* plugin.trigger(
              "tool.execute.before",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID },
              { args },
            )
            const result = yield* item.execute(args, ctx)
            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            yield* plugin.trigger(
              "tool.execute.after",
              { tool: item.id, sessionID: ctx.sessionID, callID: ctx.callID, args },
              output,
            )
            if (options.abortSignal?.aborted) {
              yield* input.processor.completeToolCall(options.toolCallId, output)
            }
            return output
          }),
        )
      },
    })
  }

  for (const [key, item] of Object.entries(yield* mcp.toolsForSession(input.session.id))) {
    const execute = item.execute
    if (!execute) continue

    const schema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
    const transformed = ProviderTransform.schema(input.model, schema)
    item.inputSchema = jsonSchema(transformed)
    item.execute = (args, opts) =>
      run.promise(
        Effect.gen(function* () {
          const ctx = context(args, opts)
          yield* plugin.trigger(
            "tool.execute.before",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId },
            { args },
          )
          const result: Awaited<ReturnType<NonNullable<typeof execute>>> = yield* Effect.gen(function* () {
            yield* ctx.ask({ permission: key, metadata: {}, patterns: ["*"], always: ["*"] })
            return yield* Effect.promise(() => execute(args, opts))
          }).pipe(
            Effect.withSpan("Tool.execute", {
              attributes: {
                "tool.name": key,
                "tool.call_id": opts.toolCallId,
                "session.id": ctx.sessionID,
                "message.id": input.processor.message.id,
              },
            }),
          )
          yield* plugin.trigger(
            "tool.execute.after",
            { tool: key, sessionID: ctx.sessionID, callID: opts.toolCallId, args },
            result,
          )

          const textParts: string[] = []
          const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []
          for (const contentItem of result.content) {
            if (contentItem.type === "text") textParts.push(contentItem.text)
            else if (contentItem.type === "image") {
              attachments.push({
                type: "file",
                mime: contentItem.mimeType,
                url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
              })
            } else if (contentItem.type === "resource") {
              const { resource } = contentItem
              if (resource.text) textParts.push(resource.text)
              if (resource.blob) {
                attachments.push({
                  type: "file",
                  mime: resource.mimeType ?? "application/octet-stream",
                  url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                  filename: resource.uri,
                })
              }
            }
          }

          const truncated = yield* truncate.output(textParts.join("\n\n"), {}, input.agent)
          const metadata = {
            ...result.metadata,
            truncated: truncated.truncated,
            ...(truncated.truncated && { outputPath: truncated.outputPath }),
          }

          const output = {
            title: "",
            metadata,
            output: truncated.content,
            attachments: attachments.map((attachment) => ({
              ...attachment,
              id: PartID.ascending(),
              sessionID: ctx.sessionID,
              messageID: input.processor.message.id,
            })),
            content: result.content,
          }
          if (opts.abortSignal?.aborted) {
            yield* input.processor.completeToolCall(opts.toolCallId, output)
          }
          return output
        }),
      )
    tools[key] = item
  }

  return tools
})

export * as SessionTools from "./tools"
