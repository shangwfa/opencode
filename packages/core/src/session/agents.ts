export * as SessionAgents from "./agents.js"

import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer, Option, Schema, Types } from "effect"
import path from "path"
import { SessionAgent as SessionAgentSchema } from "@opencode/schema/session-agent"
import { Agent } from "../agent.js"
import { ConfigAgent } from "@opencode/schema/config/agent"
import { ConfigMarkdown } from "../config/markdown.js"
import { Database } from "../database/database.js"
import { SandboxProvider } from "../sandbox/provider.js"
import { Global } from "@opencode/util/global"
import { Session } from "../session.js"
import {
  SandboxDefinitionCache,
  scanSandboxMarkdown,
  scanSandboxMarkdownBestEffort,
  type SandboxMarkdownScan,
  type ScannedFile,
  validName,
} from "./scan.js"
import { SessionAgentTable } from "./sql.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { SessionResourceOwner } from "./resource-owner.js"

export { validName }

export type Info = SessionAgentSchema.Info
export type Payload = SessionAgentSchema.Payload
export const ContentTooLargeError = SessionAgentSchema.ContentTooLargeError
export type ContentTooLargeError = SessionAgentSchema.ContentTooLargeError
const decodeConfig = Schema.decodeUnknownOption(ConfigAgent.Info)

export class SandboxScanError extends Schema.TaggedError<SandboxScanError>()("SessionAgent.SandboxScanError", {
  message: Schema.String,
}) {}

export interface Interface {
  /**
   * Read the effective agents. Sandbox discovery failures degrade to configured and
   * session definitions, because prompt and permission resolution read agents on every
   * request; use `refresh` for an explicit scan that reports failure.
   */
  readonly list: (session: Session.Info) => Effect.Effect<Info[]>
  readonly get: (session: Session.Info, id: Agent.ID) => Effect.Effect<Info | undefined>
  readonly select: (session: Session.Info, id?: Agent.ID) => Effect.Effect<Agent.Selection>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info, ContentTooLargeError>
  readonly setPermissions: (
    sessionID: Session.ID,
    id: Agent.ID,
    permissions: ConfigAgent.Info["permissions"] & {},
  ) => Effect.Effect<Info, ContentTooLargeError>
  readonly remove: (sessionID: Session.ID, id: Agent.ID) => Effect.Effect<void>
  readonly clear: (sessionID: Session.ID) => Effect.Effect<void>
  readonly refresh: (session: Session.Info) => Effect.Effect<Info[], SandboxScanError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionAgents") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const agents = yield* Agent.Service
    const sandbox = yield* SandboxProvider.Service
    const global = yield* Global.Service

    const loadLevels = Effect.fn("SessionAgents.loadLevels")(function* (session: Session.Info) {
      const base = yield* agents.list()
      const stored = yield* listStored(db, session.id)
      return { base, stored }
    })
    const listStrict = Effect.fn("SessionAgents.listStrict")(function* (session: Session.Info, force: boolean) {
      const { base, stored } = yield* loadLevels(session)
      const sandboxAgents = yield* scanSandbox(session.id, session.location.directory, sandbox, { force })
      return mergeAgents(base, stored, sandboxAgents, global.home)
    })
    const list = Effect.fn("SessionAgents.list")(function* (session: Session.Info) {
      const { base, stored } = yield* loadLevels(session)
      const sandboxAgents = yield* scanSandboxBestEffort(session.id, session.location.directory, sandbox)
      return mergeAgents(base, stored, sandboxAgents, global.home)
    })
    const get = Effect.fn("SessionAgents.get")(function* (session: Session.Info, id: Agent.ID) {
      return (yield* list(session)).find((item) => item.agent.id === id)
    })
    const select = Effect.fn("SessionAgents.select")(function* (session: Session.Info, id?: Agent.ID) {
      // One merged read covers both lookups; `get` would rescan the sandbox per call.
      const merged = yield* list(session)
      const find = (agentID: Agent.ID) => merged.find((item) => item.agent.id === agentID)
      if (id !== undefined) {
        const effective = find(id)
        if (effective) return { id, info: effective.agent }
      }
      const selected = yield* agents.select(id)
      return { id: selected.id, info: find(selected.id)?.agent }
    })
    const create = Effect.fn("SessionAgents.create")(function* (requestedSessionID: Session.ID, input: Payload) {
      const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
      const encoded = JSON.stringify(input.config)
      const actualBytes = Buffer.byteLength(encoded, "utf8")
      if (actualBytes > SessionAgentSchema.MaxContentBytes)
        return yield* new ContentTooLargeError({
          actualBytes,
          maxBytes: SessionAgentSchema.MaxContentBytes,
          message: `Session Agent config is ${actualBytes} bytes; the limit is ${SessionAgentSchema.MaxContentBytes} bytes`,
        })
      const now = Date.now()
      yield* db
        .insert(SessionAgentTable)
        .values({
          id: SessionAgentSchema.ID.create(),
          session_id: sessionID,
          agent_id: input.id,
          config: input.config,
          time_created: now,
          time_updated: now,
        })
        .onConflictDoUpdate({
          target: [SessionAgentTable.session_id, SessionAgentTable.agent_id],
          // Monotonic update stamp: computed against the stored row inside the conflict
          // branch, so a same-millisecond rewrite and concurrent upserts cannot leave an
          // equal or older `time_updated` behind (same rule as Session AGENTS.md).
          set: { config: input.config, time_updated: sql`max(${now}, ${SessionAgentTable.time_updated} + 1)` },
        })
        .run()
        .pipe(Effect.orDie)
      const row = yield* db
        .select()
        .from(SessionAgentTable)
        .where(and(eq(SessionAgentTable.session_id, sessionID), eq(SessionAgentTable.agent_id, input.id)))
        .get()
        .pipe(Effect.orDie)
      if (!row) return yield* Effect.die(new Error(`Session Agent upsert disappeared: ${input.id}`))
      return fromRow(row)
    })

    const setPermissions = Effect.fn("SessionAgents.setPermissions")(function* (
      requestedSessionID: Session.ID,
      id: Agent.ID,
      permissions: ConfigAgent.Info["permissions"] & {},
    ) {
      const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
      const existing = yield* db
        .select({ config: SessionAgentTable.config })
        .from(SessionAgentTable)
        .where(and(eq(SessionAgentTable.session_id, sessionID), eq(SessionAgentTable.agent_id, id)))
        .get()
        .pipe(Effect.orDie)
      const config = ConfigAgent.Info.make({ ...(existing?.config ?? {}), permissions })
      return yield* create(sessionID, { id, config })
    })

    const remove = Effect.fn("SessionAgents.remove")(function* (requestedSessionID: Session.ID, id: Agent.ID) {
      const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
      yield* db
        .delete(SessionAgentTable)
        .where(and(eq(SessionAgentTable.session_id, sessionID), eq(SessionAgentTable.agent_id, id)))
        .run()
        .pipe(Effect.orDie)
    })

    const clear = Effect.fn("SessionAgents.clear")(function* (requestedSessionID: Session.ID) {
      const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
      yield* db.delete(SessionAgentTable).where(eq(SessionAgentTable.session_id, sessionID)).run().pipe(Effect.orDie)
    })

    const refresh = Effect.fn("SessionAgents.refresh")(function* (session: Session.Info) {
      // Explicit refresh bypasses the fingerprint cache, so it can recover from a change the
      // fingerprint missed and always reports what is on disk right now.
      return yield* listStrict(session, true)
    })

    return Service.of({ list, get, select, create, setPermissions, remove, clear, refresh })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, Agent.node, SandboxProvider.node, Global.node],
})

function listStored(db: Database.Interface["db"], requestedSessionID: Session.ID) {
  return Effect.gen(function* () {
    const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
    const rows = yield* db
      .select()
      .from(SessionAgentTable)
      .where(eq(SessionAgentTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => ({ id: row.agent_id, config: row.config }))
  })
}

/**
 * Discovery directories under the Session sandbox. The scan command itself is built by the
 * shared scanner, which emits `path`, nanosecond `mtime`, and `size` per markdown file so a
 * scan can decide what changed without reading anything.
 */
const SCAN_PREFIXES = ["/workspace/.opencode/agent/", "/workspace/.opencode/agents/"]

/**
 * Module-level by design: definitions are derived from sandbox files, and Session IDs are
 * globally unique, so a shared cache is correct across Locations and bounded by `SandboxDefinitionCache`.
 */
const definitionCache = new SandboxDefinitionCache<SourceConfig>()

function scanInput(
  sessionID: Session.ID,
  directory: string,
  sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">,
  options: { readonly force?: boolean; readonly cache?: SandboxDefinitionCache<SourceConfig> } = {},
): SandboxMarkdownScan<SourceConfig> {
  return {
    sessionID,
    directory,
    sandbox,
    label: "Agent",
    prefixes: SCAN_PREFIXES,
    cache: options.cache ?? definitionCache,
    decode: decodeSandboxAgent,
    force: options.force,
  }
}

export function scanSandbox(
  sessionID: Session.ID,
  directory: string,
  sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">,
  options: { readonly force?: boolean; readonly cache?: SandboxDefinitionCache<SourceConfig> } = {},
) {
  return scanSandboxMarkdown(scanInput(sessionID, directory, sandbox, options)).pipe(
    Effect.mapError((error) => new SandboxScanError({ message: error.message })),
  )
}

/**
 * Sandbox discovery for the read path. A sandbox hiccup must not fail prompt admission
 * or permission resolution, so the scan degrades to no sandbox definitions and logs why.
 * `refresh` and `scanSandbox` keep the typed failure for explicit, user-facing scans.
 */
export function scanSandboxBestEffort(
  sessionID: Session.ID,
  directory: string,
  sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">,
  options: { readonly force?: boolean; readonly cache?: SandboxDefinitionCache<SourceConfig> } = {},
) {
  return scanSandboxMarkdownBestEffort(scanInput(sessionID, directory, sandbox, options))
}

function decodeSandboxAgent(file: ScannedFile, content: string): SourceConfig | undefined {
  const config = decodeMarkdown(file.id, content)
  if (!config) return undefined
  return { id: Agent.ID.make(file.id), config, source: "sandbox" as const, sourcePath: file.relative }
}

export function decodeMarkdown(id: string, content: string) {
  if (!validName(id)) return undefined
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return undefined
  return Option.getOrUndefined(decodeConfig({ ...markdown.data, system: markdown.content.trim() }))
}

function fromRow(row: typeof SessionAgentTable.$inferSelect): Info {
  return SessionAgentSchema.Info.make({
    agent: applyConfig(Agent.Info.default(row.agent_id), row.config) ?? Agent.Info.default(row.agent_id),
    source: "session",
  })
}

type StoredConfig = { readonly id: Agent.ID; readonly config: ConfigAgent.Info }
export type SourceConfig = {
  readonly id: Agent.ID
  readonly config: ConfigAgent.Info
  readonly source: "session" | "sandbox"
  readonly sourcePath?: string
}

function applyConfig(base: Agent.Info, config: ConfigAgent.Info, home = ""): Agent.Info | undefined {
  const agent = {
    ...base,
    request: { ...base.request, headers: { ...base.request.headers }, body: { ...base.request.body } },
    permissions: [...base.permissions],
  } as Types.DeepMutable<Agent.Info>
  if (config.disabled) return undefined
  if (config.model !== undefined)
    agent.model = {
      id: config.model.model,
      providerID: config.model.providerID,
      ...(config.model.variant === undefined ? {} : { variant: config.model.variant }),
    }
  if (config.request !== undefined) {
    Object.assign(agent.request.headers, config.request.headers ?? {})
    Object.assign(agent.request.body, config.request.body ?? {})
  }
  if (config.system !== undefined) agent.system = config.system
  if (config.description !== undefined) agent.description = config.description
  if (config.mode !== undefined) agent.mode = config.mode
  if (config.hidden !== undefined) agent.hidden = config.hidden
  if (config.color !== undefined) agent.color = config.color
  if (config.steps !== undefined) agent.steps = config.steps
  if (config.permissions !== undefined) agent.permissions.push(...expandPermissions(config.permissions, home))
  return Agent.Info.make(agent)
}

export function mergeAgents(global: Agent.Info[], stored: StoredConfig[], sandbox: SourceConfig[], home = "") {
  const result = new Map<Agent.ID, Info>(
    global.map((agent) => [agent.id, SessionAgentSchema.Info.make({ agent, source: "global" })]),
  )
  const apply = (item: SourceConfig) => {
    const base = result.get(item.id)?.agent ?? Agent.Info.default(item.id)
    const agent = applyConfig(base, item.config, home)
    if (!agent) {
      result.delete(item.id)
      return
    }
    result.set(
      item.id,
      SessionAgentSchema.Info.make({
        agent,
        source: item.source,
        ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
      }),
    )
  }
  for (const item of stored) apply({ ...item, source: "session" })
  for (const item of sandbox) apply(item)
  return [...result.values()].sort((a, b) => a.agent.id.localeCompare(b.agent.id))
}

const pathActions = new Set(["external_directory", "read", "edit"])

function expandPermissions(rules: ConfigAgent.Info["permissions"] & {}, home: string) {
  return rules.map((rule) => {
    if (!pathActions.has(rule.action)) return rule
    const resource = rule.resource
    if (resource === "~" || resource === "$HOME") return { ...rule, resource: home }
    const relative = resource.startsWith("~/")
      ? resource.slice(2)
      : resource.startsWith("$HOME/") || resource.startsWith("$HOME\\")
        ? resource.slice(6)
        : undefined
    return relative === undefined
      ? rule
      : { ...rule, resource: (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative) }
  })
}
