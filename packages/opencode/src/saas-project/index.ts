export * as SaasProject from "."

import postgres from "postgres"
import { Context, Effect, Layer, Schema } from "effect"
import { Identifier } from "@/id/id"
import { Database } from "@/storage/db"
import { ProjectGit } from "./git"
import { ProjectSecret } from "./secret"

export const ID = Schema.String.check(Schema.isPattern(/^prj_[0-9A-Za-z]+$/)).pipe(Schema.brand("SaasProject.ID"))
export type ID = typeof ID.Type

export const ResourceName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/),
  Schema.isMaxLength(128),
)

export const Status = Schema.Literals(["active", "archived"])
export const ConnectionStatus = Schema.Literals(["verified", "unreachable", "unauthorized"])

export const Repository = Schema.Struct({
  provider: ProjectGit.Provider,
  url: Schema.String,
  host: Schema.String,
  path: Schema.String,
  defaultBranch: Schema.optional(Schema.String),
  authType: Schema.Literals(["none", "oauth", "token", "basic", "ssh"]),
  hasCredential: Schema.Boolean,
  connectionStatus: ConnectionStatus,
  verifiedAt: Schema.Number,
  lastCheckedAt: Schema.Number,
})

export const Info = Schema.Struct({
  id: ID,
  name: Schema.String,
  description: Schema.String,
  status: Status,
  repository: Repository,
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number, archived: Schema.optional(Schema.Number) }),
})
export type Info = typeof Info.Type

export const RepositoryInput = Schema.Struct({
  provider: ProjectGit.Provider,
  url: Schema.String,
  defaultBranch: Schema.optional(Schema.String),
  auth: ProjectGit.Auth,
})
export type RepositoryInput = typeof RepositoryInput.Type

export const CreateInput = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  repository: RepositoryInput,
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type CreateInput = typeof CreateInput.Type

export const UpdateInput = Schema.Struct({
  name: Schema.optional(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255))),
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
  metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type UpdateInput = typeof UpdateInput.Type

const PermissionRule = Schema.Struct({
  permission: Schema.String,
  pattern: Schema.String,
  action: Schema.Literals(["allow", "deny", "ask"]),
})

export const AgentInput = Schema.Struct({
  description: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Literals(["primary", "subagent", "all"])),
  prompt: Schema.optional(Schema.String),
  permission: Schema.optional(Schema.Array(PermissionRule)),
  model: Schema.optional(Schema.Struct({ providerID: Schema.String, modelID: Schema.String })),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  steps: Schema.optional(Schema.Number),
  color: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type AgentInput = typeof AgentInput.Type

export const AgentInfo = Schema.Struct({
  id: Schema.String,
  projectID: ID,
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

export const SkillInput = Schema.Struct({
  description: Schema.String,
  content: Schema.String,
  resources: Schema.optional(Schema.Array(SkillResource)),
})
export type SkillInput = typeof SkillInput.Type

export const SkillInfo = Schema.Struct({
  id: Schema.String,
  projectID: ID,
  name: ResourceName,
  description: Schema.String,
  content: Schema.String,
  resources: Schema.Array(SkillResource),
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type SkillInfo = typeof SkillInfo.Type

export const McpInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("local"),
    command: Schema.Array(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Schema.Number),
    environment: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("remote"),
    url: Schema.String,
    enabled: Schema.optional(Schema.Boolean),
    timeout: Schema.optional(Schema.Number),
    headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  }),
])
export type McpInput = typeof McpInput.Type

export const McpInfo = Schema.Struct({
  id: Schema.String,
  projectID: ID,
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

export const CommandInput = Schema.Struct({
  description: Schema.optional(Schema.String),
  template: Schema.String,
  agent: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  subtask: Schema.optional(Schema.Boolean),
  hints: Schema.optional(Schema.Array(Schema.String)),
})
export type CommandInput = typeof CommandInput.Type

export const CommandInfo = Schema.Struct({
  id: Schema.String,
  projectID: ID,
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

export const ToolInput = Schema.Struct({
  description: Schema.String,
  code: Schema.String,
})
export type ToolInput = typeof ToolInput.Type

export const ToolInfo = Schema.Struct({
  id: Schema.String,
  projectID: ID,
  name: ResourceName,
  description: Schema.String,
  code: Schema.String,
  time: Schema.Struct({ created: Schema.Number, updated: Schema.Number }),
})
export type ToolInfo = typeof ToolInfo.Type

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SaasProject.NotFound", {
  projectID: ID,
}) {}

export class ArchivedError extends Schema.TaggedErrorClass<ArchivedError>()("SaasProject.Archived", {
  projectID: ID,
}) {}

export class ResourceNotFoundError extends Schema.TaggedErrorClass<ResourceNotFoundError>()(
  "SaasProject.ResourceNotFound",
  {
    projectID: ID,
    kind: Schema.Literals(["agent", "skill", "mcp"]),
    name: Schema.String,
  },
) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("SaasProject.StorageError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly create: (
    input: CreateInput,
  ) => Effect.Effect<
    Info,
    ProjectGit.InvalidRemoteError | ProjectGit.VerificationError | ProjectSecret.SecretError | StorageError
  >
  readonly list: () => Effect.Effect<Info[], StorageError>
  readonly get: (projectID: ID) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly update: (projectID: ID, input: UpdateInput) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly archive: (projectID: ID) => Effect.Effect<Info, NotFoundError | StorageError>
  readonly updateRepository: (
    projectID: ID,
    input: RepositoryInput,
  ) => Effect.Effect<
    Info,
    | NotFoundError
    | ArchivedError
    | ProjectGit.InvalidRemoteError
    | ProjectGit.VerificationError
    | ProjectSecret.SecretError
    | StorageError
  >
  readonly verifyRepository: (
    projectID: ID,
  ) => Effect.Effect<Info, NotFoundError | ProjectSecret.SecretError | ProjectGit.VerificationError | StorageError>
  readonly purge: (projectID: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly cleanupOrphans: () => Effect.Effect<number, StorageError>
  readonly listAgents: (projectID: ID) => Effect.Effect<AgentInfo[], NotFoundError | StorageError>
  readonly upsertAgent: (
    projectID: ID,
    name: string,
    input: AgentInput,
  ) => Effect.Effect<AgentInfo, NotFoundError | ArchivedError | StorageError>
  readonly removeAgent: (projectID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listSkills: (projectID: ID) => Effect.Effect<SkillInfo[], NotFoundError | StorageError>
  readonly upsertSkill: (
    projectID: ID,
    name: string,
    input: SkillInput,
  ) => Effect.Effect<SkillInfo, NotFoundError | ArchivedError | StorageError>
  readonly removeSkill: (projectID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listMcps: (projectID: ID) => Effect.Effect<McpInfo[], NotFoundError | StorageError>
  readonly listMcpsWithSecrets: (
    projectID: ID,
  ) => Effect.Effect<
    Array<{ info: McpInfo; environment: Record<string, string>; headers: Record<string, string> }>,
    NotFoundError | ProjectSecret.SecretError | StorageError
  >
  readonly upsertMcp: (
    projectID: ID,
    name: string,
    input: McpInput,
  ) => Effect.Effect<McpInfo, NotFoundError | ArchivedError | ProjectSecret.SecretError | StorageError>
  readonly removeMcp: (projectID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly getAgentsMd: (projectID: ID) => Effect.Effect<{ content: string } | undefined, NotFoundError | StorageError>
  readonly upsertAgentsMd: (
    projectID: ID,
    content: string,
  ) => Effect.Effect<{ content: string }, NotFoundError | ArchivedError | StorageError>
  readonly removeAgentsMd: (projectID: ID) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listCommands: (projectID: ID) => Effect.Effect<CommandInfo[], NotFoundError | StorageError>
  readonly upsertCommand: (
    projectID: ID,
    name: string,
    input: CommandInput,
  ) => Effect.Effect<CommandInfo, NotFoundError | ArchivedError | StorageError>
  readonly removeCommand: (projectID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
  readonly listTools: (projectID: ID) => Effect.Effect<ToolInfo[], NotFoundError | StorageError>
  readonly upsertTool: (
    projectID: ID,
    name: string,
    input: ToolInput,
  ) => Effect.Effect<ToolInfo, NotFoundError | ArchivedError | StorageError>
  readonly removeTool: (projectID: ID, name: string) => Effect.Effect<void, NotFoundError | StorageError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SaasProject") {}

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

function projectID() {
  return ID.make(Identifier.create("prj", "ascending"))
}

function resourceID(prefix: string) {
  return Identifier.create(prefix, "ascending")
}

function projectFromRow(row: Row): Info {
  return Info.make({
    id: ID.make(String(row.id)),
    name: String(row.name),
    description: String(row.description),
    status: row.status as typeof Status.Type,
    repository: {
      provider: row.repository_provider as ProjectGit.Provider,
      url: String(row.repository_url),
      host: String(row.repository_host),
      path: String(row.repository_path),
      defaultBranch: optional(row.repository_default_branch as string | null),
      authType: row.repository_auth_type as (typeof Repository.Type)["authType"],
      hasCredential: row.repository_credential !== null,
      connectionStatus: row.repository_connection_status as typeof ConnectionStatus.Type,
      verifiedAt: Number(row.repository_verified_at),
      lastCheckedAt: Number(row.repository_last_checked_at),
    },
    metadata: json(row.metadata, {}),
    time: {
      created: Number(row.time_created),
      updated: Number(row.time_updated),
      archived: optional(row.time_archived === null ? undefined : Number(row.time_archived)),
    },
  })
}

function agentFromRow(row: Row): AgentInfo {
  return AgentInfo.make({
    id: String(row.id),
    projectID: ID.make(String(row.project_id)),
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
    projectID: ID.make(String(row.project_id)),
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
    projectID: ID.make(String(row.project_id)),
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

function storage<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: () => new StorageError({ message: "Project storage operation failed" }),
  })
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const secrets = yield* ProjectSecret.Service
    const git = yield* ProjectGit.Service

    const find = Effect.fn("SaasProject.find")(function* (id: ID) {
      const rows = yield* storage(() => client()`SELECT * FROM saas_project WHERE id = ${id}`)
      return asRows(rows)[0]
    })

    const requireProject = Effect.fn("SaasProject.require")(function* (id: ID) {
      const row = yield* find(id)
      if (!row) return yield* new NotFoundError({ projectID: id })
      return projectFromRow(row)
    })

    const requireWritableProject = Effect.fn("SaasProject.requireWritable")(function* (id: ID) {
      const info = yield* requireProject(id)
      if (info.status === "archived") return yield* new ArchivedError({ projectID: id })
      return info
    })

    const get = Effect.fn("SaasProject.get")(function* (id: ID) {
      const row = yield* find(id)
      if (!row) return yield* new NotFoundError({ projectID: id })
      return projectFromRow(row)
    })

    const create = Effect.fn("SaasProject.create")(function* (input: CreateInput) {
      const id = projectID()
      const remote = yield* ProjectGit.parse(input.repository.provider, input.repository.url)
      yield* git.verify(remote, input.repository.auth)
      const now = Date.now()
      const credential =
        input.repository.auth.type === "none"
          ? null
          : yield* secrets.encrypt(toJson(input.repository.auth), `project:${id}:repository`)
      const rows = yield* storage(
        () => client()`
        INSERT INTO saas_project (
          id, name, description, status, repository_provider, repository_url, repository_host,
          repository_path, repository_default_branch, repository_auth_type, repository_credential,
          repository_verified_at, repository_last_checked_at, repository_connection_status,
          metadata, time_created, time_updated
        ) VALUES (
          ${id}, ${input.name}, ${input.description ?? ""}, 'active', ${remote.provider}, ${remote.url},
          ${remote.host}, ${remote.path}, ${input.repository.defaultBranch ?? null}, ${input.repository.auth.type},
          ${credential ? pgJson(credential) : null}::jsonb, ${now}, ${now}, 'verified',
          ${pgJson(input.metadata ?? {})}::jsonb, ${now}, ${now}
        ) RETURNING *
      `,
      )
      return projectFromRow(asRows(rows)[0])
    })

    const list = Effect.fn("SaasProject.list")(function* () {
      const rows = yield* storage(() => client()`SELECT * FROM saas_project ORDER BY time_created DESC, id DESC`)
      return asRows(rows).map(projectFromRow)
    })

    const update = Effect.fn("SaasProject.update")(function* (id: ID, input: UpdateInput) {
      const current = yield* get(id)
      const rows = yield* storage(
        () => client()`
        UPDATE saas_project SET
          name = ${input.name ?? current.name},
          description = ${input.description ?? current.description},
          metadata = ${pgJson(input.metadata ?? current.metadata)}::jsonb,
          time_updated = ${Date.now()}
        WHERE id = ${id}
        RETURNING *
      `,
      )
      return projectFromRow(asRows(rows)[0])
    })

    const archive = Effect.fn("SaasProject.archive")(function* (id: ID) {
      yield* get(id)
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        UPDATE saas_project SET status = 'archived', time_archived = ${now}, time_updated = ${now}
        WHERE id = ${id} RETURNING *
      `,
      )
      return projectFromRow(asRows(rows)[0])
    })

    const updateRepository = Effect.fn("SaasProject.updateRepository")(function* (id: ID, input: RepositoryInput) {
      yield* requireWritableProject(id)
      const remote = yield* ProjectGit.parse(input.provider, input.url)
      yield* git.verify(remote, input.auth)
      const now = Date.now()
      const credential =
        input.auth.type === "none" ? null : yield* secrets.encrypt(toJson(input.auth), `project:${id}:repository`)
      const rows = yield* storage(
        () => client()`
        UPDATE saas_project SET
          repository_provider = ${remote.provider}, repository_url = ${remote.url},
          repository_host = ${remote.host}, repository_path = ${remote.path},
          repository_default_branch = ${input.defaultBranch ?? null}, repository_auth_type = ${input.auth.type},
          repository_credential = ${credential ? pgJson(credential) : null}::jsonb,
          repository_verified_at = ${now}, repository_last_checked_at = ${now},
          repository_connection_status = 'verified', time_updated = ${now}
        WHERE id = ${id} RETURNING *
      `,
      )
      return projectFromRow(asRows(rows)[0])
    })

    const verifyRepository = Effect.fn("SaasProject.verifyRepository")(function* (id: ID) {
      const row = yield* find(id)
      if (!row) return yield* new NotFoundError({ projectID: id })
      const info = projectFromRow(row)
      const envelope = optional(json<ProjectSecret.Envelope | undefined>(row.repository_credential, undefined))
      const auth = envelope
        ? yield* secrets.decrypt(envelope, `project:${id}:repository`).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(ProjectGit.Auth)),
            Effect.mapError(
              () => new ProjectSecret.SecretError({ message: "Stored repository credential is invalid" }),
            ),
          )
        : ProjectGit.Auth.make({ type: "none" })
      yield* git
        .verify(
          ProjectGit.Remote.make({
            provider: info.repository.provider,
            url: info.repository.url,
            host: info.repository.host,
            path: info.repository.path,
          }),
          auth,
        )
        .pipe(
          Effect.tapError((error) =>
            storage(
              () => client()`
          UPDATE saas_project SET
            repository_connection_status = ${error.reason === "unauthorized" ? "unauthorized" : "unreachable"},
            repository_last_checked_at = ${Date.now()}, time_updated = ${Date.now()}
          WHERE id = ${id}
        `,
            ),
          ),
        )
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        UPDATE saas_project SET repository_connection_status = 'verified', repository_verified_at = ${now},
          repository_last_checked_at = ${now}, time_updated = ${now}
        WHERE id = ${id} RETURNING *
      `,
      )
      return projectFromRow(asRows(rows)[0])
    })

    const purge = Effect.fn("SaasProject.purge")(function* (id: ID) {
      yield* get(id)
      yield* storage(() =>
        client().begin(async (tx) => {
          await tx`DELETE FROM project_tool WHERE project_id = ${id}`
          await tx`DELETE FROM project_command WHERE project_id = ${id}`
          await tx`DELETE FROM project_agents_md WHERE project_id = ${id}`
          await tx`DELETE FROM mcp WHERE project_id = ${id}`
          await tx`DELETE FROM skill WHERE project_id = ${id}`
          await tx`DELETE FROM agent WHERE project_id = ${id}`
          await tx`DELETE FROM saas_project WHERE id = ${id}`
        }),
      )
    })

    const cleanupOrphans = Effect.fn("SaasProject.cleanupOrphans")(function* () {
      const rows = yield* storage(
        () => client()`
        WITH deleted_mcp AS (
          DELETE FROM mcp WHERE NOT EXISTS (SELECT 1 FROM saas_project WHERE saas_project.id = mcp.project_id)
          RETURNING 1
        ), deleted_tool AS (
          DELETE FROM project_tool WHERE NOT EXISTS (SELECT 1 FROM saas_project WHERE saas_project.id = project_tool.project_id)
          RETURNING 1
        ), deleted_command AS (
          DELETE FROM project_command WHERE NOT EXISTS (SELECT 1 FROM saas_project WHERE saas_project.id = project_command.project_id)
          RETURNING 1
        ), deleted_agents_md AS (
          DELETE FROM project_agents_md WHERE NOT EXISTS (SELECT 1 FROM saas_project WHERE saas_project.id = project_agents_md.project_id)
          RETURNING 1
        ), deleted_skill AS (
          DELETE FROM skill WHERE NOT EXISTS (SELECT 1 FROM saas_project WHERE saas_project.id = skill.project_id)
          RETURNING 1
        ), deleted_agent AS (
          DELETE FROM agent WHERE NOT EXISTS (SELECT 1 FROM saas_project WHERE saas_project.id = agent.project_id)
          RETURNING 1
        )
        SELECT
          (SELECT count(*) FROM deleted_mcp) +
          (SELECT count(*) FROM deleted_tool) +
          (SELECT count(*) FROM deleted_command) +
          (SELECT count(*) FROM deleted_agents_md) +
          (SELECT count(*) FROM deleted_skill) +
          (SELECT count(*) FROM deleted_agent) AS count
      `,
      )
      return Number(asRows(rows)[0]?.count ?? 0)
    })

    const listAgents = Effect.fn("SaasProject.listAgents")(function* (id: ID) {
      yield* requireProject(id)
      const rows = yield* storage(() => client()`SELECT * FROM agent WHERE project_id = ${id} ORDER BY name`)
      return asRows(rows).map(agentFromRow)
    })

    const upsertAgent = Effect.fn("SaasProject.upsertAgent")(function* (id: ID, name: string, input: AgentInput) {
      yield* requireWritableProject(id)
      const validName = ResourceName.make(name)
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        INSERT INTO agent (id, project_id, name, description, mode, prompt, permission, model, temperature, top_p, steps, color, variant, options, time_created, time_updated)
        VALUES (${resourceID("agt")}, ${id}, ${validName}, ${input.description ?? null}, ${input.mode ?? "all"},
          ${input.prompt ?? null}, ${pgJson(input.permission ?? [])}::jsonb, ${input.model ? pgJson(input.model) : null}::jsonb,
          ${input.temperature ?? null}, ${input.topP ?? null}, ${input.steps ?? null}, ${input.color ?? null},
          ${input.variant ?? null}, ${pgJson(input.options ?? {})}::jsonb, ${now}, ${now})
        ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description, mode = EXCLUDED.mode,
          prompt = EXCLUDED.prompt, permission = EXCLUDED.permission, model = EXCLUDED.model,
          temperature = EXCLUDED.temperature, top_p = EXCLUDED.top_p, steps = EXCLUDED.steps,
          color = EXCLUDED.color, variant = EXCLUDED.variant, options = EXCLUDED.options, time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return agentFromRow(asRows(rows)[0])
    })

    const removeAgent = Effect.fn("SaasProject.removeAgent")(function* (id: ID, name: string) {
      yield* requireProject(id)
      yield* storage(() => client()`DELETE FROM agent WHERE project_id = ${id} AND name = ${name}`)
    })

    const listSkills = Effect.fn("SaasProject.listSkills")(function* (id: ID) {
      yield* requireProject(id)
      const rows = yield* storage(() => client()`SELECT * FROM skill WHERE project_id = ${id} ORDER BY name`)
      return asRows(rows).map(skillFromRow)
    })

    const upsertSkill = Effect.fn("SaasProject.upsertSkill")(function* (id: ID, name: string, input: SkillInput) {
      yield* requireWritableProject(id)
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
        INSERT INTO skill (id, project_id, name, description, content, resources, time_created, time_updated)
        VALUES (${resourceID("skl")}, ${id}, ${validName}, ${input.description}, ${input.content},
          ${pgJson(resources)}::jsonb, ${now}, ${now})
        ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description, content = EXCLUDED.content,
          resources = EXCLUDED.resources, time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return skillFromRow(asRows(rows)[0])
    })

    const removeSkill = Effect.fn("SaasProject.removeSkill")(function* (id: ID, name: string) {
      yield* requireProject(id)
      yield* storage(() => client()`DELETE FROM skill WHERE project_id = ${id} AND name = ${name}`)
    })

    const listMcps = Effect.fn("SaasProject.listMcps")(function* (id: ID) {
      yield* requireProject(id)
      const rows = yield* storage(() => client()`SELECT * FROM mcp WHERE project_id = ${id} ORDER BY name`)
      return asRows(rows).map(mcpFromRow)
    })

    const listMcpsWithSecrets = Effect.fn("SaasProject.listMcpsWithSecrets")(function* (id: ID) {
      yield* requireProject(id)
      const rows = yield* storage(() => client()`SELECT * FROM mcp WHERE project_id = ${id} ORDER BY name`)
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
          const decrypted = yield* secrets.decrypt(envelope, `project:${id}:mcp:${row.id}`)
          const decoded = decrypted as { environment?: Record<string, string>; headers?: Record<string, string> }
          environment = decoded.environment ?? {}
          headers = decoded.headers ?? {}
        }
        result.push({ info, environment, headers })
      }
      return result
    })

    const upsertMcp = Effect.fn("SaasProject.upsertMcp")(function* (id: ID, name: string, input: McpInput) {
      yield* requireWritableProject(id)
      const validName = ResourceName.make(name)
      const existingRows = yield* storage(
        () => client()`
          SELECT id, type, environment_keys, header_keys, secrets
          FROM mcp WHERE project_id = ${id} AND name = ${validName}
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
              `project:${id}:mcp:${resource}`,
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
        INSERT INTO mcp (id, project_id, name, type, command, url, enabled, timeout, environment_keys, header_keys, secrets, time_created, time_updated)
        VALUES (${resource}, ${id}, ${validName}, ${input.type},
          ${input.type === "local" ? pgJson(input.command) : null}::jsonb, ${input.type === "remote" ? input.url : null},
          ${input.enabled ?? true}, ${input.timeout ?? null},
          ${pgJson(environmentKeys)}::jsonb,
          ${pgJson(headerKeys)}::jsonb,
          ${encrypted ? pgJson(encrypted) : null}::jsonb, ${now}, ${now})
        ON CONFLICT (project_id, name) DO UPDATE SET type = EXCLUDED.type, command = EXCLUDED.command,
          url = EXCLUDED.url, enabled = EXCLUDED.enabled, timeout = EXCLUDED.timeout,
          environment_keys = EXCLUDED.environment_keys, header_keys = EXCLUDED.header_keys,
          secrets = EXCLUDED.secrets, time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return mcpFromRow(asRows(rows)[0])
    })

    const removeMcp = Effect.fn("SaasProject.removeMcp")(function* (id: ID, name: string) {
      yield* requireProject(id)
      yield* storage(() => client()`DELETE FROM mcp WHERE project_id = ${id} AND name = ${name}`)
    })

    const getAgentsMd = Effect.fn("SaasProject.getAgentsMd")(function* (id: ID) {
      yield* requireProject(id)
      const rows = yield* storage(() => client()`SELECT content FROM project_agents_md WHERE project_id = ${id}`)
      const row = asRows(rows)[0]
      return row ? { content: String(row.content) } : undefined
    })

    const upsertAgentsMd = Effect.fn("SaasProject.upsertAgentsMd")(function* (id: ID, content: string) {
      yield* requireWritableProject(id)
      const now = Date.now()
      yield* storage(
        () => client()`
        INSERT INTO project_agents_md (id, project_id, content, time_created, time_updated)
        VALUES (${resourceID("pam")}, ${id}, ${content}, ${now}, ${now})
        ON CONFLICT (project_id) DO UPDATE SET content = EXCLUDED.content, time_updated = EXCLUDED.time_updated
      `,
      )
      return { content }
    })

    const removeAgentsMd = Effect.fn("SaasProject.removeAgentsMd")(function* (id: ID) {
      yield* requireProject(id)
      yield* storage(() => client()`DELETE FROM project_agents_md WHERE project_id = ${id}`)
    })

    function commandFromRow(row: Row): CommandInfo {
      return CommandInfo.make({
        id: String(row.id),
        projectID: ID.make(String(row.project_id)),
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

    const listCommands = Effect.fn("SaasProject.listCommands")(function* (id: ID) {
      yield* requireProject(id)
      const rows = yield* storage(() => client()`SELECT * FROM project_command WHERE project_id = ${id} ORDER BY name`)
      return asRows(rows).map(commandFromRow)
    })

    const upsertCommand = Effect.fn("SaasProject.upsertCommand")(function* (id: ID, name: string, input: CommandInput) {
      yield* requireWritableProject(id)
      const validName = ResourceName.make(name)
      const now = Date.now()
      const hints = input.hints ?? []
      const rows = yield* storage(
        () => client()`
        INSERT INTO project_command (id, project_id, name, description, template, agent, model, subtask, hints, time_created, time_updated)
        VALUES (${resourceID("cmd")}, ${id}, ${validName}, ${input.description ?? null}, ${input.template},
          ${input.agent ?? null}, ${input.model ?? null}, ${input.subtask ?? null},
          ${pgJson(hints)}::jsonb, ${now}, ${now})
        ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description, template = EXCLUDED.template,
          agent = EXCLUDED.agent, model = EXCLUDED.model, subtask = EXCLUDED.subtask, hints = EXCLUDED.hints,
          time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return commandFromRow(asRows(rows)[0])
    })

    const removeCommand = Effect.fn("SaasProject.removeCommand")(function* (id: ID, name: string) {
      yield* requireProject(id)
      yield* storage(() => client()`DELETE FROM project_command WHERE project_id = ${id} AND name = ${name}`)
    })

    function toolFromRow(row: Row): ToolInfo {
      return ToolInfo.make({
        id: String(row.id),
        projectID: ID.make(String(row.project_id)),
        name: ResourceName.make(String(row.name)),
        description: String(row.description),
        code: String(row.code),
        time: { created: Number(row.time_created), updated: Number(row.time_updated) },
      })
    }

    const listTools = Effect.fn("SaasProject.listTools")(function* (id: ID) {
      yield* requireProject(id)
      const rows = yield* storage(() => client()`SELECT * FROM project_tool WHERE project_id = ${id} ORDER BY name`)
      return asRows(rows).map(toolFromRow)
    })

    const upsertTool = Effect.fn("SaasProject.upsertTool")(function* (id: ID, name: string, input: ToolInput) {
      yield* requireWritableProject(id)
      const validName = ResourceName.make(name)
      const now = Date.now()
      const rows = yield* storage(
        () => client()`
        INSERT INTO project_tool (id, project_id, name, description, code, time_created, time_updated)
        VALUES (${resourceID("tl")}, ${id}, ${validName}, ${input.description}, ${input.code}, ${now}, ${now})
        ON CONFLICT (project_id, name) DO UPDATE SET description = EXCLUDED.description, code = EXCLUDED.code,
          time_updated = EXCLUDED.time_updated
        RETURNING *
      `,
      )
      return toolFromRow(asRows(rows)[0])
    })

    const removeTool = Effect.fn("SaasProject.removeTool")(function* (id: ID, name: string) {
      yield* requireProject(id)
      yield* storage(() => client()`DELETE FROM project_tool WHERE project_id = ${id} AND name = ${name}`)
    })

    return Service.of({
      create,
      list,
      get,
      update,
      archive,
      updateRepository,
      verifyRepository,
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

export const live = layer.pipe(Layer.provide([ProjectSecret.live, ProjectGit.live]))
