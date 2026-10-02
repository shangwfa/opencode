export * as SessionSkills from "./skills.js"

import { createHash } from "crypto"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import path from "path"
import { SessionSkill } from "@opencode/schema/session-skill"
import { Skill } from "@opencode/schema/skill"
import { ConfigMarkdown } from "../config/markdown.js"
import { SkillFile } from "../config/plugin/skill-file.js"
import { Database } from "../database/database.js"
import { SandboxProvider } from "../sandbox/provider.js"
import { Skill as SkillService } from "../skill.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Session } from "../session.js"
import {
  SandboxDefinitionCache,
  scanSandboxMarkdown,
  scanSandboxMarkdownBestEffort,
  type SandboxMarkdownScan,
  type ScannedFile,
} from "./scan.js"
import { SessionSkillTable } from "./sql.js"
import { SessionResourceOwner } from "./resource-owner.js"

export type Info = SessionSkill.Info
export type Payload = SessionSkill.Payload
export type Resource = SessionSkill.Resource

export class SandboxScanError extends Error {}

export interface Interface {
  readonly list: (session: Session.Info) => Effect.Effect<Info[]>
  readonly get: (session: Session.Info, id: Skill.ID) => Effect.Effect<Info | undefined>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info, SessionSkill.ResourceError>
  readonly remove: (sessionID: Session.ID, id: Skill.ID) => Effect.Effect<void>
  readonly clear: (sessionID: Session.ID) => Effect.Effect<void>
  readonly refresh: (session: Session.Info) => Effect.Effect<Info[], SandboxScanError>
  /** Materialize durable resource snapshots only; sandbox skills already own their files. */
  readonly materialize: (session: Session.Info, skill: Info) => Effect.Effect<string | undefined, Error>
  /** Restore durable resources after a sandbox recreation without creating a sandbox just for this check. */
  readonly rematerialize: (session: Session.Info) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSkills") {}

const prefixes = ["/workspace/.opencode/skill/", "/workspace/.opencode/skills/"]
const cache = new SandboxDefinitionCache<Info>()

const digest = (value: string) => createHash("sha256").update(value).digest("hex")
const metadata = (items: readonly SessionSkill.ResourceInput[]): Resource[] =>
  items.map((item) =>
    SessionSkill.Resource.make({
      path: item.path,
      type: item.type,
      size: Buffer.byteLength(item.content),
      digest: digest(item.content),
    }),
  )

const resourceDirectory = (sessionID: Session.ID, content: string, resources: readonly SessionSkill.ResourceInput[]) =>
  `/workspace/.opencode/.session-skills/${sessionID}/${digest(JSON.stringify({ content, resources: resources.map((item) => [item.path, digest(item.content)]) }))}`

export function validateResources(items: readonly SessionSkill.ResourceInput[]) {
  if (items.length > SessionSkill.MaxResources)
    throw new SessionSkill.ResourceError({ message: `Skill has more than ${SessionSkill.MaxResources} resources` })
  let total = 0
  const seen = new Set<string>()
  for (const item of items) {
    if (
      !item.path ||
      item.path.includes("\0") ||
      item.path.includes("\\") ||
      path.posix.isAbsolute(item.path) ||
      item.path.split("/").some((x) => !x || x === "." || x === "..")
    )
      throw new SessionSkill.ResourceError({ message: "Invalid skill resource path", path: item.path })
    if (seen.has(item.path))
      throw new SessionSkill.ResourceError({ message: "Duplicate skill resource path", path: item.path })
    seen.add(item.path)
    const size = Buffer.byteLength(item.content)
    if (size > SessionSkill.MaxResourceBytes)
      throw new SessionSkill.ResourceError({
        message: `Skill resource exceeds ${SessionSkill.MaxResourceBytes} bytes`,
        path: item.path,
      })
    total += size
  }
  if (total > SessionSkill.MaxResourcesBytes)
    throw new SessionSkill.ResourceError({ message: `Skill resources exceed ${SessionSkill.MaxResourcesBytes} bytes` })
}

function fromRow(row: typeof SessionSkillTable.$inferSelect): Info {
  const resources = row.resources ?? []
  return SessionSkill.Info.make({
    skill: Skill.Info.make({
      id: row.skill_id,
      name: Skill.Name.make(row.name),
      ...(row.description === null ? {} : { description: row.description }),
      ...(row.autoinvoke === null ? {} : { autoinvoke: row.autoinvoke }),
      path: `/session/${row.session_id}/skills/${row.skill_id}` as Skill.Info["path"],
      content: row.content,
    }),
    source: "session",
    resources: metadata(resources),
  })
}

function scanInput(
  sessionID: Session.ID,
  directory: string,
  sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">,
  force = false,
): SandboxMarkdownScan<Info> {
  return {
    sessionID,
    directory,
    sandbox,
    label: "Skill",
    prefixes,
    cache,
    force,
    decode: (file, content) => decodeSandbox(file, content),
  }
}

function decodeSandbox(file: ScannedFile, content: string): Info | undefined {
  const parsed = SkillFile.parse(path.dirname(file.path), file.path, content)
  if (parsed._tag !== "Parsed") return undefined
  return SessionSkill.Info.make({ skill: parsed.skill, source: "sandbox", sourcePath: file.relative, resources: [] })
}

export function mergeSkills(global: Skill.Info[], stored: Info[], sandbox: Info[]) {
  const result = new Map<string, Info>()
  for (const item of global)
    result.set(item.id, SessionSkill.Info.make({ skill: item, source: "global", resources: [] }))
  for (const item of stored) result.set(item.skill.id, item)
  for (const item of sandbox) result.set(item.skill.id, item)
  return [...result.values()].toSorted((a, b) => a.skill.id.localeCompare(b.skill.id))
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const skills = yield* SkillService.Service
    const sandbox = yield* SandboxProvider.Service
    const stored = (sessionID: Session.ID) =>
      SessionResourceOwner.id(db, sessionID).pipe(
        Effect.flatMap((ownerID) =>
          db
            .select()
            .from(SessionSkillTable)
            .where(eq(SessionSkillTable.session_id, ownerID))
            .all()
            .pipe(
              Effect.map((rows) => rows.map(fromRow)),
              Effect.orDie,
            ),
        ),
      )
    const collect = (session: Session.Info, force: boolean) =>
      Effect.gen(function* () {
        const scanned = yield* scanSandboxMarkdownBestEffort(
          scanInput(session.id, session.location.directory, sandbox, force),
        )
        return mergeSkills(yield* skills.list(), yield* stored(session.id), scanned)
      })
    const materialize = (session: Session.Info, info: Info) =>
      Effect.gen(function* () {
        if (info.source !== "session" || info.resources.length === 0) return undefined
        const ownerID = yield* SessionResourceOwner.id(db, session.id)
        const row = yield* db
          .select()
          .from(SessionSkillTable)
          .where(and(eq(SessionSkillTable.session_id, ownerID), eq(SessionSkillTable.skill_id, info.skill.id)))
          .get()
          .pipe(Effect.orDie)
        if (!row) return undefined
        const resources = row.resources ?? []
        const root = resourceDirectory(ownerID, row.content, resources)
        yield* sandbox.fileWrite(session.id, `${root}/SKILL.md`, row.content)
        yield* sandbox.fileWrite(
          session.id,
          `${root}/resources.json`,
          JSON.stringify({ id: row.skill_id, resources: metadata(resources) }, null, 2),
        )
        yield* Effect.forEach(
          resources,
          (resource) => sandbox.fileWrite(session.id, `${root}/${resource.path}`, resource.content),
          { concurrency: 8, discard: true },
        )
        return root
      })
    const rematerialize = (session: Session.Info) =>
      Effect.gen(function* () {
        if (!sandbox.enabled || !(yield* sandbox.isReady(session.id))) return
        const ownerID = yield* SessionResourceOwner.id(db, session.id)
        const rows = yield* db
          .select()
          .from(SessionSkillTable)
          .where(eq(SessionSkillTable.session_id, ownerID))
          .all()
          .pipe(Effect.orDie)
        for (const row of rows) {
          const resources = row.resources ?? []
          if (resources.length === 0) continue
          const root = resourceDirectory(ownerID, row.content, resources)
          const marker = yield* sandbox
            .fileStat(session.id, `${root}/resources.json`)
            .pipe(Effect.catch(() => Effect.succeed(null)))
          if (marker) continue
          yield* materialize(session, fromRow(row)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("failed to rematerialize session skill resources", {
                sessionID: session.id,
                skillID: row.skill_id,
                cause,
              }),
            ),
          )
        }
      })
    return Service.of({
      list: (session) => collect(session, false),
      get: (session, id) =>
        collect(session, false).pipe(Effect.map((items) => items.find((item) => item.skill.id === id))),
      create: (requestedSessionID, input) =>
        Effect.try({
          try: () => validateResources(input.resources ?? []),
          catch: (e) => e as SessionSkill.ResourceError,
        }).pipe(
          Effect.andThen(() =>
            Effect.gen(function* () {
              const sessionID = yield* SessionResourceOwner.id(db, requestedSessionID)
              const now = Date.now()
              const resources = input.resources ?? []
              yield* db
                .insert(SessionSkillTable)
                .values({
                  id: SessionSkill.ID.create(),
                  session_id: sessionID,
                  skill_id: input.id,
                  name: input.name ?? Skill.Name.make(input.id),
                  description: input.description ?? null,
                  autoinvoke: input.autoinvoke ?? null,
                  content: input.content,
                  resources: [...resources],
                  time_created: now,
                  time_updated: now,
                })
                .onConflictDoUpdate({
                  target: [SessionSkillTable.session_id, SessionSkillTable.skill_id],
                  set: {
                    name: input.name ?? Skill.Name.make(input.id),
                    description: input.description ?? null,
                    autoinvoke: input.autoinvoke ?? null,
                    content: input.content,
                    resources: [...resources],
                    time_updated: sql`max(${now}, ${SessionSkillTable.time_updated} + 1)`,
                  },
                })
                .run()
                .pipe(Effect.orDie)
              const row = yield* db
                .select()
                .from(SessionSkillTable)
                .where(and(eq(SessionSkillTable.session_id, sessionID), eq(SessionSkillTable.skill_id, input.id)))
                .get()
                .pipe(Effect.orDie)
              if (!row) return yield* Effect.die(new Error(`Session Skill upsert disappeared: ${input.id}`))
              return fromRow(row)
            }),
          ),
        ),
      remove: (sessionID, id) =>
        SessionResourceOwner.id(db, sessionID).pipe(
          Effect.flatMap((ownerID) =>
            db
              .delete(SessionSkillTable)
              .where(and(eq(SessionSkillTable.session_id, ownerID), eq(SessionSkillTable.skill_id, id)))
              .run()
              .pipe(Effect.orDie),
          ),
        ),
      clear: (sessionID) =>
        SessionResourceOwner.id(db, sessionID).pipe(
          Effect.flatMap((ownerID) =>
            db.delete(SessionSkillTable).where(eq(SessionSkillTable.session_id, ownerID)).run().pipe(Effect.orDie),
          ),
        ),
      refresh: (session) =>
        Effect.gen(function* () {
          const scanned = yield* scanSandboxMarkdown(
            scanInput(session.id, session.location.directory, sandbox, true),
          ).pipe(Effect.mapError((e) => new SandboxScanError(e.message)))
          return mergeSkills(yield* skills.list(), yield* stored(session.id), scanned)
        }),
      materialize,
      rematerialize,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Database.node, SkillService.node, SandboxProvider.node],
})
