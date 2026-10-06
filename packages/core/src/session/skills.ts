export * as SessionSkills from "./skills.js"

import { createHash } from "crypto"
import { and, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import path from "path"
import { SessionSkill } from "@opencode/schema/session-skill"
import { Skill } from "@opencode/schema/skill"
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
import { Permission } from "../permission.js"
import * as SkillResource from "./skill-resource.js"

export type Info = SessionSkill.Info
export type Payload = SessionSkill.Payload
export type Resource = SessionSkill.Resource

export class SandboxScanError extends Error {}

export interface Interface {
  /** Sandbox resource root owned by this session or its parent resource owner. */
  readonly resourceRoot: (sessionID: Session.ID) => Effect.Effect<string>
  readonly list: (session: Session.Info) => Effect.Effect<Info[]>
  readonly get: (session: Session.Info, id: Skill.ID) => Effect.Effect<Info | undefined>
  readonly create: (sessionID: Session.ID, input: Payload) => Effect.Effect<Info, SessionSkill.ResourceError>
  readonly remove: (sessionID: Session.ID, id: Skill.ID) => Effect.Effect<void>
  readonly clear: (sessionID: Session.ID) => Effect.Effect<void>
  readonly refresh: (session: Session.Info) => Effect.Effect<Info[], SandboxScanError>
  /** Sample model-visible files for sandbox skills; durable Session bundles use their resource paths. */
  readonly files: (session: Session.Info, skill: Info) => Effect.Effect<string[]>
  /** Materialize the exact captured durable bundle; sandbox skills already own their files. */
  readonly materialize: (session: Session.Info, skill: Info) => Effect.Effect<string | undefined, Error>
  /** Restore only allow-authorized resources in model context; omission is for explicit repair callers. */
  readonly rematerialize: (session: Session.Info, permissions?: Permission.Ruleset) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionSkills") {}

const prefixes = ["/workspace/.opencode/skill/", "/workspace/.opencode/skills/"]
const cache = new SandboxDefinitionCache<Info>()
// Keep resource contents private, but bind them to the exact definition returned
// by get/create. A later upsert must not mix new resources with old instructions.
const snapshots = new WeakMap<Info, { ownerID: Session.ID; resources: SessionSkill.ResourceInput[] }>()

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

const resourceDirectory = (
  sessionID: Session.ID,
  skill: Skill.Info,
  resources: readonly SessionSkill.ResourceInput[],
) => SkillResource.directory(sessionID, skill.id, skill.content, resources)

export function sandboxSkillFiles(
  directory: string,
  entries: ReadonlyArray<{ readonly path: string; readonly isDirectory: boolean }>,
) {
  return entries
    .filter((entry) => !entry.isDirectory && path.posix.basename(entry.path) !== "SKILL.md")
    .flatMap((entry) => {
      const relative = path.posix.relative(directory, entry.path)
      return relative && relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative)
        ? [relative]
        : []
    })
    .toSorted()
    .slice(0, 10)
}

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
    if (
      ["SKILL.md", "resources.json"].some((reserved) => item.path === reserved || item.path.startsWith(`${reserved}/`))
    )
      throw new SessionSkill.ResourceError({ message: "Reserved skill resource path", path: item.path })
    if (
      items.some(
        (other) =>
          other.path !== item.path &&
          (other.path.startsWith(`${item.path}/`) || item.path.startsWith(`${other.path}/`)),
      )
    )
      throw new SessionSkill.ResourceError({
        message: "Conflicting skill resource file and directory",
        path: item.path,
      })
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
  const resources = (row.resources ?? []).map((resource) => ({ ...resource }))
  const info = SessionSkill.Info.make({
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
  snapshots.set(info, { ownerID: row.session_id, resources })
  return info
}

function scanInput(
  sessionID: Session.ID,
  directory: string,
  sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">,
  force = false,
  sandboxID?: string,
): SandboxMarkdownScan<Info> {
  return {
    sessionID,
    directory,
    sandbox,
    label: "Skill",
    prefixes,
    cache,
    force,
    layout: "skills",
    cacheKey: JSON.stringify([sessionID, sandboxID]),
    acceptFile: (file) => !file.relative.includes("/") || path.posix.basename(file.relative) === "SKILL.md",
    decode: (file, content) => decodeSandbox(file, content),
  }
}

function decodeSandbox(file: ScannedFile, content: string): Info | undefined {
  const directory = prefixes.find((prefix) => file.path.startsWith(prefix))
  if (!directory) return undefined
  const parsed = SkillFile.parse(directory.replace(/\/$/, ""), file.path, content)
  if (parsed._tag !== "Parsed") return undefined
  return SessionSkill.Info.make({ skill: parsed.skill, source: "sandbox", sourcePath: file.relative, resources: [] })
}

export function mergeSkills(global: Skill.Info[], stored: Info[], sandbox: Info[]) {
  const result = new Map<string, Info>()
  for (const item of global)
    result.set(item.id, SessionSkill.Info.make({ skill: item, source: "global", resources: [] }))
  // Priority is sandbox > session > global (confirmed product contract): the
  // workspace's own SKILL.md is authoritative for execution, a session-private
  // snapshot shadows only global definitions, and removing the sandbox file
  // makes the session snapshot effective again.
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
        const sandboxID = sandbox.enabled ? yield* sandbox.sandboxId(session.id) : null
        const scanned = sandboxID
          ? yield* scanSandboxMarkdownBestEffort(
              scanInput(session.id, session.location.directory, sandbox, force, sandboxID),
            )
          : []
        return mergeSkills(yield* skills.list(), yield* stored(session.id), scanned)
      })
    const materialize = (session: Session.Info, info: Info) =>
      Effect.gen(function* () {
        if (info.source !== "session" || info.resources.length === 0) return undefined
        const ownerID = yield* SessionResourceOwner.id(db, session.id)
        const snapshot = snapshots.get(info)
        if (!snapshot || snapshot.ownerID !== ownerID)
          return yield* Effect.fail(
            new Error("Session skill resource snapshot is unavailable or belongs to another owner"),
          )
        const resources = snapshot.resources
        yield* Effect.try({
          try: () => validateResources(resources),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        })
        const root = resourceDirectory(ownerID, info.skill, resources)
        const marker = JSON.stringify(
          { version: 2, id: info.skill.id, contentDigest: digest(info.skill.content), resources: metadata(resources) },
          null,
          2,
        )
        const complete = yield* Effect.gen(function* () {
          if ((yield* sandbox.fileRead(session.id, `${root}/resources.json`)) !== marker) return false
          const content = yield* sandbox.fileRead(session.id, `${root}/SKILL.md`)
          if (content === null || digest(content) !== digest(info.skill.content)) return false
          const valid = yield* Effect.forEach(
            resources,
            (resource) =>
              sandbox
                .fileRead(session.id, `${root}/${resource.path}`)
                .pipe(Effect.map((content) => content !== null && digest(content) === digest(resource.content))),
            { concurrency: 8 },
          )
          return valid.every(Boolean)
        }).pipe(Effect.catch(() => Effect.succeed(false)))
        if (complete) return root
        yield* sandbox.fileWrite(session.id, `${root}/SKILL.md`, info.skill.content)
        yield* Effect.forEach(
          resources,
          (resource) => sandbox.fileWrite(session.id, `${root}/${resource.path}`, resource.content),
          { concurrency: 8, discard: true },
        )
        // The marker is a completion record, never an intent record. Verification
        // above also repairs legacy/partial bundles and same-size corruption.
        yield* sandbox.fileWrite(session.id, `${root}/resources.json`, marker)
        return root
      })
    const rematerialize = (session: Session.Info, permissions?: Permission.Ruleset) =>
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
          // Recovery must not prompt for, or pre-write, denied/ask-only skills.
          // Explicit diagnostic callers may omit the policy; model context may not.
          if (permissions && Permission.evaluate("skill", row.skill_id, permissions).effect !== "allow") continue
          const resources = row.resources ?? []
          if (resources.length === 0) continue
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
      resourceRoot: (sessionID) => SessionResourceOwner.id(db, sessionID).pipe(Effect.map(SkillResource.ownerRoot)),
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
          const sandboxID = sandbox.enabled ? yield* sandbox.sandboxId(session.id) : null
          const scanned = yield* scanSandboxMarkdown(
            scanInput(session.id, session.location.directory, sandbox, true, sandboxID ?? undefined),
          ).pipe(Effect.mapError((e) => new SandboxScanError(e.message)))
          return mergeSkills(yield* skills.list(), yield* stored(session.id), scanned)
        }),
      files: (session, info) =>
        Effect.gen(function* () {
          if (info.source === "session") return info.resources.map((resource) => resource.path).slice(0, 10)
          if (info.source !== "sandbox") return []
          const directory = path.posix.dirname(info.skill.path)
          return yield* sandbox.fileFind(session.id, directory, "**/*").pipe(
            Effect.map((entries) => sandboxSkillFiles(directory, entries)),
            Effect.tapError((error) =>
              Effect.logWarning("failed to list sandbox skill files", {
                sessionID: session.id,
                skillID: info.skill.id,
                error,
              }),
            ),
            Effect.catch(() => Effect.succeed([] as string[])),
          )
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
