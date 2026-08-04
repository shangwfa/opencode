export * as SaasTask from "."

import postgres from "postgres"
import { Context, Effect, Layer, Schema } from "effect"
import { SaasProject } from "@/saas-project"
import { ProjectSecret } from "@/saas-project/secret"
import { Identifier } from "@/id/id"
import { Database } from "@/storage/db"

export const ID = Schema.String.check(Schema.isPattern(/^task_[0-9A-Za-z]+$/)).pipe(Schema.brand("SaasTask.ID"))
export type ID = typeof ID.Type

export const ResourceName = SaasProject.ResourceName

export const Info = Schema.Struct({
  id: ID,
  title: Schema.String,
  description: Schema.String,
  projectIds: Schema.Array(SaasProject.ID),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type Info = typeof Info.Type

export const CreateInput = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  projectIds: Schema.optional(Schema.Array(SaasProject.ID)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type CreateInput = typeof CreateInput.Type

export const UpdateInput = Schema.Struct({
  title: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  projectIds: Schema.optional(Schema.Array(SaasProject.ID)),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type UpdateInput = typeof UpdateInput.Type

export const AgentInput = SaasProject.AgentInput
export type AgentInput = SaasProject.AgentInput

const PermissionRule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Schema.Literals(["allow", "deny", "ask"]),
})

export const AgentInfo = Schema.Struct({
  id: Schema.String,
  taskID: ID,
  name: ResourceName,
  description: Schema.optional(Schema.String),
  mode: Schema.Literals(["primary", "subagent", "all"]),
  prompt: Schema.optional(Schema.String),
  permission: Schema.Array(PermissionRule),
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  steps: Schema.optional(Schema.Number),
  color: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  options: Schema.Record(Schema.String, Schema.Unknown),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type AgentInfo = typeof AgentInfo.Type

const SkillResource = Schema.Struct({
  path: Schema.String,
  type: Schema.String,
  content: Schema.String,
  size: Schema.optional(Schema.Number),
})

export const SkillInput = SaasProject.SkillInput
export type SkillInput = SaasProject.SkillInput

export const SkillInfo = Schema.Struct({
  id: Schema.String,
  taskID: ID,
  name: ResourceName,
  description: Schema.String,
  content: Schema.String,
  resources: Schema.Array(SkillResource),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type SkillInfo = typeof SkillInfo.Type

export const McpInput = SaasProject.McpInput
export type McpInput = SaasProject.McpInput

export const McpInfo = Schema.Struct({
  id: Schema.String,
  taskID: ID,
  name: ResourceName,
  type: Schema.Literals(["local", "remote"]),
  command: Schema.optional(Schema.Array(Schema.String)),
  url: Schema.optional(Schema.String),
  enabled: Schema.Boolean,
  timeout: Schema.optional(Schema.Number),
  environmentKeys: Schema.Array(Schema.String),
  headerKeys: Schema.Array(Schema.String),
  hasSecrets: Schema.Boolean,
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type McpInfo = typeof McpInfo.Type

export const CommandInput = SaasProject.CommandInput
export type CommandInput = SaasProject.CommandInput

export const CommandInfo = Schema.Struct({
  id: Schema.String,
  taskID: ID,
  name: ResourceName,
  description: Schema.optional(Schema.String),
  template: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.Array(Schema.String),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type CommandInfo = typeof CommandInfo.Type

export const ToolInput = SaasProject.ToolInput
export type ToolInput = SaasProject.ToolInput

export const ToolInfo = Schema.Struct({
  id: Schema.String,
  taskID: ID,
  name: ResourceName,
  description: Schema.String,
  code: Schema.String,
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type ToolInfo = typeof ToolInfo.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SaasTask.NotFound", {
  taskID: ID,
}) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("SaasTask.StorageError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (input: CreateInput) => Effect.Effect<Info, StorageError>
  readonly list: () => Effect.Effect<Info[], StorageError>
  readonly get: (taskID: ID) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly update: (taskID: ID, input: UpdateInput) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly remove: (taskID: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly purge: (taskID: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly cleanupOrphans: () => Effect.Effect<number, StorageError>
  readonly listAgents: (taskID: ID) => Effect.Effect<AgentInfo[], NotFoundError | StorageError>
  readonly upsertAgent: (
    taskID: ID,
    name: string,
    input: AgentInput,
  ) => Effect.Effect<AgentInfo, NotFoundError | StorageError>
  readonly removeAgent: (taskID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listSkills: (taskID: ID) => Effect.Effect<SkillInfo[], NotFoundError | StorageError>
  readonly upsertSkill: (
    taskID: ID,
    name: string,
    input: SkillInput,
  ) => Effect.Effect<SkillInfo, NotFoundError | StorageError>
  readonly removeSkill: (taskID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listMcps: (taskID: ID) => Effect.Effect<McpInfo[], NotFoundError | StorageError>
  readonly listMcpsWithSecrets: (
    taskID: ID,
  ) => Effect.Effect<
    Array<{ info: McpInfo; environment: Record<string, string>; headers: Record<string, string> }>,
    NotFoundError | ProjectSecret.SecretError | StorageError
  >
  readonly upsertMcp: (
    taskID: ID,
    name: string,
    input: McpInput,
  ) => Effect.Effect<McpInfo, NotFoundError | ProjectSecret.SecretError | StorageError>
  readonly removeMcp: (taskID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly getAgentsMd: (taskID: ID) => Effect.Effect<{ content: string } | undefined, NotFoundError | StorageError>
  readonly upsertAgentsMd: (
    taskID: ID,
    content: string,
  ) => Effect.Effect<{ content: string }, NotFoundError | StorageError>
  readonly removeAgentsMd: (taskID: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listCommands: (taskID: ID) => Effect.Effect<CommandInfo[], NotFoundError | StorageError>
  readonly upsertCommand: (
    taskID: ID,
    name: string,
    input: CommandInput,
  ) => Effect.Effect<CommandInfo, NotFoundError | StorageError>
  readonly removeCommand: (taskID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listTools: (taskID: ID) => Effect.Effect<ToolInfo[], NotFoundError | StorageError>
  readonly upsertTool: (
    taskID: ID,
    name: string,
    input: ToolInput,
  ) => Effect.Effect<ToolInfo, NotFoundError | StorageError>
  readonly removeTool: (taskID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SaasTask") {}

type Sql = ReturnType<typeof postgres>
type Row = Record<string, unknown>

const client = () => (Database.Client() as unknown as { $client: Sql }).$client
const asRows = (value: unknown) => value as Row[]
const json = <A>(value: unknown, fallback: A): A => {
  if (value === null || value === undefined) return fallback
  return (typeof value === "string" ? JSON.parse(value) : value) as A
}
const optional = <A>(value: A | null | undefined) => value ?? undefined
const toJson = (value: unknown) => JSON.parse(JSON.stringify(value)) as Schema.Json
const pgJson = (value: unknown) => JSON.stringify(value)

function taskID() {
  return ID.make(Identifier.create("task", "ascending"))
}

function resourceID(prefix: string) {
  return Identifier.create(prefix, "ascending")
}

function taskFromRow(row: Row): Info {
  return Info.make({
    id: ID.make(String(row.id)),
    title: String(row.title),
    description: String(row.description),
    projectIds: json(row.project_ids, []),
    metadata: json(row.metadata, {}),
    time: { created: Number(row.time_created), updated: Number(row.time_updated) },
  })
}

function agentFromRow(row: Row): AgentInfo {
  return AgentInfo.make({
    id: String(row.id),
    taskID: ID.make(String(row.task_id)),
    name: ResourceName.make(String(row.name)),
    description: optional(row.description as string | null),
    mode: row.mode as (typeof AgentInfo.Type)["mode"],
    prompt: optional(row.prompt as string | null),
    permission: json(row.permission, []),
    model: optional(json(row.model, undefined)),
    temperature: optional(row.temperature === null ? undefined : Number(row.temperature)),
    topP: optional(row.top_p === null ? undefined : Number(row.top_p)),
    steps: optional(row.steps === null ? undefined : Number(row.steps)),
    color: optional(row.color as string | null),
    variant: optional(row.variant as string | null),
    options: json(row.options, {}),
    time: { created: Number(row.time_created), updated: Number(row.time_updated) },
  })
}

function skillFromRow(row: Row): SkillInfo {
  return SkillInfo.make({
    id: String(row.id),
    taskID: ID.make(String(row.task_id)),
    name: ResourceName.make(String(row.name)),
    description: String(row.description),
    content: String(row.content),
    resources: json(row.resources, []),
    time: { created: Number(row.time_created), updated: Number(row.time_updated) },
  })
}

function mcpFromRow(row: Row): McpInfo {
  return McpInfo.make({
    id: String(row.id),
    taskID: ID.make(String(row.task_id)),
    name: ResourceName.make(String(row.name)),
    type: row.type as (typeof McpInfo.Type)["type"],
    command: optional(json(row.command, undefined)),
    url: optional(row.url as string | null),
    enabled: Boolean(row.enabled),
    timeout: optional(row.timeout === null ? undefined : Number(row.timeout)),
    environmentKeys: json(row.environment_keys, []),
    headerKeys: json(row.header_keys, []),
    hasSecrets: row.secrets !== null,
    time: { created: Number(row.time_created), updated: Number(row.time_updated) },
  })
}

function commandFromRow(row: Row): CommandInfo {
  return CommandInfo.make({
    id: String(row.id),
    taskID: ID.make(String(row.task_id)),
    name: ResourceName.make(String(row.name)),
    description: optional(row.description as string | null),
    template: String(row.template),
    agent: optional(row.agent as string | null),
    model: optional(row.model as string | null),
    subtask: optional(row.subtask as boolean | null),
    hints: json(row.hints, []),
    time: { created: Number(row.time_created), updated: Number(row.time_updated) },
  })
}

function toolFromRow(row: Row): ToolInfo {
  return ToolInfo.make({
    id: String(row.id),
    taskID: ID.make(String(row.task_id)),
    name: ResourceName.make(String(row.name)),
    description: String(row.description),
    code: String(row.code),
    time: { created: Number(row.time_created), updated: Number(row.time_updated) },
  })
}

function storage<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: () => new StorageError({ message: "Task storage operation failed" }),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const secrets = yield* ProjectSecret.Service

    const find = Effect.fn("SaasTask.find")(function* (id: ID) {
      const rows = yield* storage(() => client()`SELECT * FROM saas_task WHERE id = ${id}`)
      return asRows(rows)[0]
    })

    const requireTask = Effect.fn("SaasTask.require")(function* (id: ID) {
      const row = yield* find(id)
      if (!row) return yield* new NotFoundError({ taskID: id })
      return taskFromRow(row)
    })

    const get = Effect.fn("SaasTask.get")(function* (id: ID) {
      const row = yield* find(id)
      if (!row) return yield* new NotFoundError({ taskID: id })
      return taskFromRow(row)
    })

    const create = Effect.fn("SaasTask.create")(function* (input: CreateInput) {
      const id = taskID()
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        INSERT INTO saas_task (id, title, description, project_ids, metadata, time_created, time_updated)
        VALUES (${id}, ${input.title}, ${input.description ?? ""}, ${pgJson(input.projectIds ?? [])}::jsonb,
          ${pgJson(input.metadata ?? {})}::jsonb, ${now}, ${now})
        RETURNING *
      `,
      )
      return taskFromRow(asRows(rows)[0])
    })

    const list = Effect.fn("SaasTask.list")(function* () {
      const rows = yield* storage(() => client()`SELECT * FROM saas_task ORDER BY time_created DESC, id DESC`)
      return asRows(rows).map(taskFromRow)
    })

    const update = Effect.fn("SaasTask.update")(function* (id: ID, input: UpdateInput) {
      const current = yield* get(id)
      const rows = yield* storage(
        () => client()`
        UPDATE saas_task SET
          title = ${input.title ?? current.title},
          description = ${input.description ?? current.description},
          project_ids = ${pgJson(input.projectIds ?? current.projectIds)}::jsonb,
          metadata = ${pgJson(input.metadata ?? current.metadata)}::jsonb,
          time_updated = ${Date.now()}
        WHERE id = ${id}
        RETURNING *
      `,
      )
      return taskFromRow(asRows(rows)[0])
    })

    const purge = Effect.fn("SaasTask.purge")(function* (id: ID) {
      yield* get(id)
      yield* storage(() =>
        client().begin(async (tx) => {
          await tx`DELETE FROM project_tool WHERE task_id = ${id}`
          await tx`DELETE FROM project_command WHERE task_id = ${id}`
          await tx`DELETE FROM project_agents_md WHERE task_id = ${id}`
          await tx`DELETE FROM mcp WHERE task_id = ${id}`
          await tx`DELETE FROM skill WHERE task_id = ${id}`
          await tx`DELETE FROM agent WHERE task_id = ${id}`
          await tx`DELETE FROM saas_task WHERE id = ${id}`
        }),
      )
    })

    const remove = purge

    const cleanupOrphans = Effect.fn("SaasTask.cleanupOrphans")(function* () {
      const rows = yield* storage(
        () => client()`
        WITH deleted_agent AS (
          DELETE FROM agent WHERE task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM saas_task WHERE saas_task.id = agent.task_id)
          RETURNING 1
        ), deleted_skill AS (
          DELETE FROM skill WHERE task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM saas_task WHERE saas_task.id = skill.task_id)
          RETURNING 1
        ), deleted_mcp AS (
          DELETE FROM mcp WHERE task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM saas_task WHERE saas_task.id = mcp.task_id)
          RETURNING 1
        ), deleted_agents_md AS (
          DELETE FROM project_agents_md WHERE task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM saas_task WHERE saas_task.id = project_agents_md.task_id)
          RETURNING 1
        ), deleted_command AS (
          DELETE FROM project_command WHERE task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM saas_task WHERE saas_task.id = project_command.task_id)
          RETURNING 1
        ), deleted_tool AS (
          DELETE FROM project_tool WHERE task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM saas_task WHERE saas_task.id = project_tool.task_id)
          RETURNING 1
        )
        SELECT
          (SELECT count(*) FROM deleted_agent) +
          (SELECT count(*) FROM deleted_skill) +
          (SELECT count(*) FROM deleted_mcp) +
          (SELECT count(*) FROM deleted_agents_md) +
          (SELECT count(*) FROM deleted_command) +
          (SELECT count(*) FROM deleted_tool) AS count
      `,
      )
      return Number(asRows(rows)[0]?.count ?? 0)
    })

    const listAgents = Effect.fn("SaasTask.listAgents")(function* (id: ID) {
      yield* requireTask(id)
      const rows = yield* storage(() => client()`SELECT * FROM agent WHERE task_id = ${id} ORDER BY name`)
      return asRows(rows).map(agentFromRow)
    })

    const upsertAgent = Effect.fn("SaasTask.upsertAgent")(function* (id: ID, name: string, input: AgentInput) {
      yield* requireTask(id)
      const validName = ResourceName.make(name)
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        INSERT INTO agent (id, project_id, task_id, name, description, mode, prompt, permission, model, temperature, top_p, steps, color, variant, options, time_created, time_updated)
        VALUES (${resourceID("agt")}, null, ${id}, ${validName}, ${input.description ?? null}, ${input.mode ?? "all"},
          ${input.prompt ?? null}, ${pgJson(input.permission ?? [])}::jsonb, ${input.model ? pgJson(input.model) : null}::jsonb,
          ${input.temperature ?? null}, ${input.topP ?? null}, ${input.steps ?? null}, ${input.color ?? null},
          ${input.variant ?? null}, ${pgJson(input.options ?? {})}::jsonb, ${now}, ${now})
        ON CONFLICT (task_id, name) WHERE task_id IS NOT NULL DO UPDATE SET description = EXCLUDED.description, mode = EXCLUDED.mode,
          prompt = EXCLUDED.prompt, permission = EXCLUDED.permission, model = EXCLUDED.model,
          temperature = EXCLUDED.temperature, top_p = EXCLUDED.top_p, steps = EXCLUDED.steps,
          color = EXCLUDED.color, variant = EXCLUDED.variant, options = EXCLUDED.options, time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return agentFromRow(asRows(rows)[0])
    })

    const removeAgent = Effect.fn("SaasTask.removeAgent")(function* (id: ID, name: string) {
      yield* requireTask(id)
      yield* storage(() => client()`DELETE FROM agent WHERE task_id = ${id} AND name = ${name}`)
    })

    const listSkills = Effect.fn("SaasTask.listSkills")(function* (id: ID) {
      yield* requireTask(id)
      const rows = yield* storage(() => client()`SELECT * FROM skill WHERE task_id = ${id} ORDER BY name`)
      return asRows(rows).map(skillFromRow)
    })

    const upsertSkill = Effect.fn("SaasTask.upsertSkill")(function* (id: ID, name: string, input: SkillInput) {
      yield* requireTask(id)
      const validName = ResourceName.make(name)
      const now = Date.now()
      const resources = (input.resources ?? []).map((r) => ({
        path: r.path,
        type: r.type,
        content: r.content,
        size: r.size ?? Buffer.byteLength(r.content, "utf8"),
      }))
      const rows = yield* storage(
        () => client()`
        INSERT INTO skill (id, project_id, task_id, name, description, content, resources, time_created, time_updated)
        VALUES (${resourceID("skl")}, null, ${id}, ${validName}, ${input.description}, ${input.content},
          ${pgJson(resources)}::jsonb, ${now}, ${now})
        ON CONFLICT (task_id, name) WHERE task_id IS NOT NULL DO UPDATE SET description = EXCLUDED.description, content = EXCLUDED.content,
          resources = EXCLUDED.resources, time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return skillFromRow(asRows(rows)[0])
    })

    const removeSkill = Effect.fn("SaasTask.removeSkill")(function* (id: ID, name: string) {
      yield* requireTask(id)
      yield* storage(() => client()`DELETE FROM skill WHERE task_id = ${id} AND name = ${name}`)
    })

    const listMcps = Effect.fn("SaasTask.listMcps")(function* (id: ID) {
      yield* requireTask(id)
      const rows = yield* storage(() => client()`SELECT * FROM mcp WHERE task_id = ${id} ORDER BY name`)
      return asRows(rows).map(mcpFromRow)
    })

    const listMcpsWithSecrets = Effect.fn("SaasTask.listMcpsWithSecrets")(function* (id: ID) {
      yield* requireTask(id)
      const rows = yield* storage(() => client()`SELECT * FROM mcp WHERE task_id = ${id} ORDER BY name`)
      const result: Array<{
        info: McpInfo
        environment: Record<string, string>
        headers: Record<string, string>
      }> = []
      for (const row of asRows(rows)) {
        const info = mcpFromRow(row)
        let environment: Record<string, string> = {}
        let headers: Record<string, string> = {}
        const envelope = optional(json<ProjectSecret.Envelope | undefined>(row.secrets, undefined))
        if (envelope) {
          const decrypted = yield* secrets.decrypt(envelope, `task:${id}:mcp:${row.id}`)
          const decoded = decrypted as { environment?: Record<string, string>; headers?: Record<string, string> }
          environment = decoded.environment ?? {}
          headers = decoded.headers ?? {}
        }
        result.push({ info, environment, headers })
      }
      return result
    })

    const upsertMcp = Effect.fn("SaasTask.upsertMcp")(function* (id: ID, name: string, input: McpInput) {
      yield* requireTask(id)
      const validName = ResourceName.make(name)
      const existingRows = yield* storage(
        () => client()`
          SELECT id, type, environment_keys, header_keys, secrets
          FROM mcp WHERE task_id = ${id} AND name = ${validName}
        `,
      )
      const existing = asRows(existingRows)[0]
      const resource = String(existing?.id ?? resourceID("mcp"))
      const values = input.type === "local" ? (input.environment ?? {}) : (input.headers ?? {})
      const supplied = input.type === "local" ? input.environment !== undefined : input.headers !== undefined
      const preserve = !supplied && existing?.type === input.type
      const encrypted = supplied
        ? Object.keys(values).length
          ? yield* secrets.encrypt(
              toJson(
                input.type === "local" ? { environment: values, headers: {} } : { environment: {}, headers: values },
              ),
              `task:${id}:mcp:${resource}`,
            )
          : null
        : preserve
          ? json<ProjectSecret.Envelope | null>(existing?.secrets, null)
          : null
      const environmentKeys = supplied
        ? input.type === "local"
          ? Object.keys(values)
          : []
        : preserve
          ? json<string[]>(existing?.environment_keys, [])
          : []
      const headerKeys = supplied
        ? input.type === "remote"
          ? Object.keys(values)
          : []
        : preserve
          ? json<string[]>(existing?.header_keys, [])
          : []
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        INSERT INTO mcp (id, project_id, task_id, name, type, command, url, enabled, timeout, environment_keys, header_keys, secrets, time_created, time_updated)
        VALUES (${resource}, null, ${id}, ${validName}, ${input.type},
          ${input.type === "local" ? pgJson(input.command) : null}::jsonb, ${input.type === "remote" ? input.url : null},
          ${input.enabled ?? true}, ${input.timeout ?? null},
          ${pgJson(environmentKeys)}::jsonb,
          ${pgJson(headerKeys)}::jsonb,
          ${encrypted ? pgJson(encrypted) : null}::jsonb, ${now}, ${now})
        ON CONFLICT (task_id, name) WHERE task_id IS NOT NULL DO UPDATE SET type = EXCLUDED.type, command = EXCLUDED.command,
          url = EXCLUDED.url, enabled = EXCLUDED.enabled, timeout = EXCLUDED.timeout,
          environment_keys = EXCLUDED.environment_keys, header_keys = EXCLUDED.header_keys,
          secrets = EXCLUDED.secrets, time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return mcpFromRow(asRows(rows)[0])
    })

    const removeMcp = Effect.fn("SaasTask.removeMcp")(function* (id: ID, name: string) {
      yield* requireTask(id)
      yield* storage(() => client()`DELETE FROM mcp WHERE task_id = ${id} AND name = ${name}`)
    })

    const getAgentsMd = Effect.fn("SaasTask.getAgentsMd")(function* (id: ID) {
      yield* requireTask(id)
      const rows = yield* storage(() => client()`SELECT content FROM project_agents_md WHERE task_id = ${id}`)
      const row = asRows(rows)[0]
      return row ? { content: String(row.content) } : undefined
    })

    const upsertAgentsMd = Effect.fn("SaasTask.upsertAgentsMd")(function* (id: ID, content: string) {
      yield* requireTask(id)
      const now = Date.now()
      yield* storage(
        () => client()`
        INSERT INTO project_agents_md (id, project_id, task_id, content, time_created, time_updated)
        VALUES (${resourceID("pam")}, null, ${id}, ${content}, ${now}, ${now})
        ON CONFLICT (task_id) WHERE task_id IS NOT NULL DO UPDATE SET content = EXCLUDED.content, time_updated = EXCLUDED.time_updated
      `,
      )
      return { content }
    })

    const removeAgentsMd = Effect.fn("SaasTask.removeAgentsMd")(function* (id: ID) {
      yield* requireTask(id)
      yield* storage(() => client()`DELETE FROM project_agents_md WHERE task_id = ${id}`)
    })

    const listCommands = Effect.fn("SaasTask.listCommands")(function* (id: ID) {
      yield* requireTask(id)
      const rows = yield* storage(() => client()`SELECT * FROM project_command WHERE task_id = ${id} ORDER BY name`)
      return asRows(rows).map(commandFromRow)
    })

    const upsertCommand = Effect.fn("SaasTask.upsertCommand")(function* (id: ID, name: string, input: CommandInput) {
      yield* requireTask(id)
      const validName = ResourceName.make(name)
      const now = Date.now()
      const hints = input.hints ?? []
      const rows = yield* storage(
        () => client()`
        INSERT INTO project_command (id, project_id, task_id, name, description, template, agent, model, subtask, hints, time_created, time_updated)
        VALUES (${resourceID("cmd")}, null, ${id}, ${validName}, ${input.description ?? null}, ${input.template},
          ${input.agent ?? null}, ${input.model ?? null}, ${input.subtask ?? null},
          ${pgJson(hints)}::jsonb, ${now}, ${now})
        ON CONFLICT (task_id, name) WHERE task_id IS NOT NULL DO UPDATE SET description = EXCLUDED.description, template = EXCLUDED.template,
          agent = EXCLUDED.agent, model = EXCLUDED.model, subtask = EXCLUDED.subtask, hints = EXCLUDED.hints,
          time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return commandFromRow(asRows(rows)[0])
    })

    const removeCommand = Effect.fn("SaasTask.removeCommand")(function* (id: ID, name: string) {
      yield* requireTask(id)
      yield* storage(() => client()`DELETE FROM project_command WHERE task_id = ${id} AND name = ${name}`)
    })

    const listTools = Effect.fn("SaasTask.listTools")(function* (id: ID) {
      yield* requireTask(id)
      const rows = yield* storage(() => client()`SELECT * FROM project_tool WHERE task_id = ${id} ORDER BY name`)
      return asRows(rows).map(toolFromRow)
    })

    const upsertTool = Effect.fn("SaasTask.upsertTool")(function* (id: ID, name: string, input: ToolInput) {
      yield* requireTask(id)
      const validName = ResourceName.make(name)
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        INSERT INTO project_tool (id, project_id, task_id, name, description, code, time_created, time_updated)
        VALUES (${resourceID("tl")}, null, ${id}, ${validName}, ${input.description}, ${input.code}, ${now}, ${now})
        ON CONFLICT (task_id, name) WHERE task_id IS NOT NULL DO UPDATE SET description = EXCLUDED.description, code = EXCLUDED.code,
          time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return toolFromRow(asRows(rows)[0])
    })

    const removeTool = Effect.fn("SaasTask.removeTool")(function* (id: ID, name: string) {
      yield* requireTask(id)
      yield* storage(() => client()`DELETE FROM project_tool WHERE task_id = ${id} AND name = ${name}`)
    })

    return Service.of({
      create,
      list,
      get,
      update,
      remove,
      purge,
      cleanupOrphans,
      listAgents,
      upsertAgent,
      removeAgent,
      listSkills,
      upsertSkill,
      removeSkill,
      listMcps,
      listMcpsWithSecrets,
      upsertMcp,
      removeMcp,
      getAgentsMd,
      upsertAgentsMd,
      removeAgentsMd,
      listCommands,
      upsertCommand,
      removeCommand,
      listTools,
      upsertTool,
      removeTool,
    })
  }),
)

export const live = layer.pipe(Layer.provide([ProjectSecret.live]))
