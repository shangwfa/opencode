import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import path from "path"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { EventV2Bridge } from "@/event-v2-bridge"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { SkillPlugin } from "@opencode-ai/core/plugin/skill"
import { Permission } from "@/permission"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Config } from "@/config/config"
import { FrontmatterError } from "@opencode-ai/core/v1/config/error"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import { Discovery } from "./discovery"
import { SessionSkill } from "./session-skill"
import type { SessionID } from "@/session/schema"
import { isRecord } from "@/util/record"
import { escapeHtml } from "@/util/html"

const CLAUDE_EXTERNAL_DIR = ".claude"
const AGENTS_EXTERNAL_DIR = ".agents"
const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
const SKILL_PATTERN = "**/SKILL.md"

// Built-in skill that ships with opencode. The model's intuition for what an
// opencode.json should look like is often wrong, and opencode hard-fails on
// invalid config, so users hit cryptic startup errors. Loading this skill
// when the model is asked to touch opencode's own config files gives it the
// actual schemas instead of guesses.
const CUSTOMIZE_OPENCODE_SKILL_NAME = "customize-opencode"
const CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION =
  "Use ONLY when the user is editing or creating opencode's own configuration: opencode.json, opencode.jsonc, files under .opencode/, or files under ~/.config/opencode/. Also use when creating or fixing opencode agents, subagents, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring opencode itself."
const CUSTOMIZE_OPENCODE_SKILL_BODY = SkillPlugin.CustomizeOpencodeContent

export const Resource = Schema.Struct({
  path: Schema.String,
  type: Schema.Literals(["doc", "script", "template", "asset"]),
  content: Schema.String,
})
export type Resource = Schema.Schema.Type<typeof Resource>

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
  resources: Schema.optional(Schema.Array(Resource)),
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

function isSkillFrontmatter(data: unknown): data is { name: string; description?: string } {
  return (
    isRecord(data) &&
    typeof data.name === "string" &&
    (data.description === undefined || typeof data.description === "string")
  )
}

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

type State = {
  skills: Record<string, Info>
  dirs: Set<string>
  sessions: Record<string, Record<string, Info>>
}

type DiscoveryState = {
  matches: string[]
  dirs: string[]
}

type ScanState = {
  matches: Set<string>
  dirs: Set<string>
}

export const CreateInput = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  content: Schema.String,
  resources: Schema.optional(Schema.Array(Resource)),
})
export type CreateInput = Schema.Schema.Type<typeof CreateInput>

export interface Interface {
  readonly get: (name: string, session?: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string, session?: string) => Effect.Effect<Info, NotFoundError>
  readonly all: (session?: string) => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info, session?: string) => Effect.Effect<Info[]>
  readonly sessionList: (session: string) => Effect.Effect<Info[]>
  readonly sessionCreate: (session: string, input: CreateInput) => Effect.Effect<Info>
  readonly sessionLoad: (session: string, dir: string) => Effect.Effect<Info[]>
  readonly sessionUnload: (session: string, name: string) => Effect.Effect<void>
  readonly sessionClear: (session: string) => Effect.Effect<void>
}

const add = Effect.fnUntraced(function* (state: State, match: string, events: EventV2Bridge.Service["Service"]) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = FrontmatterError.isInstance(err) ? err.data.message : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* events.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        yield* Effect.logError("failed to load skill", { skill: match, error: err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    yield* Effect.logWarning("duplicate skill name", {
      name: md.data.name,
      existing: state.skills[md.data.name].location,
      duplicate: match,
    })
  }

  state.dirs.add(path.dirname(match))
  state.skills[md.data.name] = {
    name: md.data.name,
    description: md.data.description,
    location: match,
    content: md.content,
  }
})

const scan = Effect.fnUntraced(function* (
  state: ScanState,
  root: string,
  pattern: string,
  opts?: { dot?: boolean; scope?: string },
) {
  const matches = yield* Effect.tryPromise({
    try: () =>
      Glob.scan(pattern, {
        cwd: root,
        absolute: true,
        include: "file",
        symlink: true,
        dot: opts?.dot,
      }),
    catch: (error) => error,
  }).pipe(
    Effect.catch((error) => {
      if (!opts?.scope) return Effect.die(error)
      return Effect.logError(`failed to scan ${opts.scope} skills`, { dir: root, error: error }).pipe(
        Effect.as([] as string[]),
      )
    }),
  )

  for (const match of matches) {
    state.matches.add(match)
    state.dirs.add(path.dirname(match))
  }
})

const discoverSkills = Effect.fnUntraced(function* (
  config: Config.Interface,
  discovery: Discovery.Interface,
  fsys: FSUtil.Interface,
  global: Global.Interface,
  disableExternalSkills: boolean,
  disableClaudeCodeSkills: boolean,
  directory: string,
  worktree: string,
) {
  const state: ScanState = { matches: new Set(), dirs: new Set() }

  const externalDirs: string[] = []
  if (!disableExternalSkills) {
    if (!disableClaudeCodeSkills) externalDirs.push(CLAUDE_EXTERNAL_DIR)
    externalDirs.push(AGENTS_EXTERNAL_DIR)

    for (const dir of externalDirs) {
      const root = path.join(global.home, dir)
      if (!(yield* fsys.isDir(root))) continue
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
    }

    const upDirs = yield* fsys
      .up({ targets: externalDirs, start: directory, stop: worktree })
      .pipe(Effect.catch(() => Effect.succeed([] as string[])))

    for (const root of upDirs) {
      yield* scan(state, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
    }
  }

  const configDirs = yield* config.directories()
  for (const dir of configDirs) {
    yield* scan(state, dir, OPENCODE_SKILL_PATTERN)
  }

  const cfg = yield* config.get()
  for (const item of cfg.skills?.paths ?? []) {
    const expanded = item.startsWith("~/") ? path.join(global.home, item.slice(2)) : item
    const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
    if (!(yield* fsys.isDir(dir))) {
      yield* Effect.logWarning("skill path not found", { path: dir })
      continue
    }

    yield* scan(state, dir, SKILL_PATTERN)
  }

  for (const url of cfg.skills?.urls ?? []) {
    const pulledDirs = yield* discovery.pull(url)
    for (const dir of pulledDirs) {
      yield* scan(state, dir, SKILL_PATTERN)
    }
  }

  return {
    matches: Array.from(state.matches),
    dirs: Array.from(state.dirs),
  }
})

const loadSkills = Effect.fnUntraced(function* (
  state: State,
  discovered: DiscoveryState,
  events: EventV2Bridge.Service["Service"],
) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, events), {
    concurrency: "unbounded",
    discard: true,
  })

  yield* Effect.logInfo("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layerImpl = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const events = yield* EventV2Bridge.Service
    const fsys = yield* FSUtil.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
    const sessionSkill = yield* SessionSkill.Service

    const discovered = yield* InstanceState.make(
      Effect.fn("Skill.discovery")(function* (ctx) {
        return yield* discoverSkills(
          config,
          discovery,
          fsys,
          global,
          flags.disableExternalSkills,
          flags.disableClaudeCodeSkills,
          ctx.directory,
          ctx.worktree,
        )
      }),
    )
    const state = yield* InstanceState.make(
      Effect.fn("Skill.state")(function* () {
        const s: State = { skills: {}, dirs: new Set(), sessions: {} }
        // Register the built-in skill BEFORE disk discovery so a user-disk
        // skill with the same name can override it.
        s.skills[CUSTOMIZE_OPENCODE_SKILL_NAME] = {
          name: CUSTOMIZE_OPENCODE_SKILL_NAME,
          description: CUSTOMIZE_OPENCODE_SKILL_DESCRIPTION,
          location: "<built-in>",
          content: CUSTOMIZE_OPENCODE_SKILL_BODY,
        }
        yield* loadSkills(s, yield* InstanceState.get(discovered), events)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string, session?: string) {
      if (session) {
        const row = yield* sessionSkill.get(session as SessionID, name).pipe(Effect.orDie)
        if (row) return {
          name: row.name,
          description: row.description,
          location: `session://${session}/${row.name}`,
          content: row.content,
          resources: row.resources ?? [],
        }
      }
      const s = yield* InstanceState.get(state)
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string, session?: string) {
      if (session) {
        const row = yield* sessionSkill.get(session as SessionID, name).pipe(Effect.orDie)
        if (row) return {
          name: row.name,
          description: row.description,
          location: `session://${session}/${row.name}`,
          content: row.content,
          resources: row.resources ?? [],
        }
      }
      const s = yield* InstanceState.get(state)
      const info = s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* (session?: string) {
      const s = yield* InstanceState.get(state)
      if (!session) return Object.values(s.skills)
      const merged = { ...s.skills }
      const rows = yield* sessionSkill.list(session as SessionID).pipe(Effect.orDie)
      for (const row of rows) {
        merged[row.name] = {
          name: row.name,
          description: row.description,
          location: `session://${session}/${row.name}`,
          content: row.content,
          resources: row.resources ?? [],
        }
      }
      return Object.values(merged)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info, session?: string) {
      const s = yield* InstanceState.get(state)
      let sessionSkills: Info[] = []
      if (session) {
        const rows = yield* sessionSkill.list(session as SessionID).pipe(Effect.orDie)
        sessionSkills = rows.map((row) => ({
          name: row.name,
          description: row.description,
          location: `session://${session}/${row.name}`,
          content: row.content,
          resources: row.resources ?? [],
        }))
      }
      let list = session
        ? [...sessionSkills, ...Object.values(s.skills)]
        : Object.values(s.skills)
      const seen = new Set<string>()
      list = list.filter((skill) => {
        if (seen.has(skill.name)) return false
        seen.add(skill.name)
        return true
      }).toSorted((a, b) => a.name.localeCompare(b.name))
      if (!agent) return list
      return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
    })

    const sessionList = Effect.fn("Skill.sessionList")(function* (session: string) {
      const rows = yield* sessionSkill.list(session as SessionID).pipe(Effect.orDie)
      return rows.map((row: any) => ({
        name: row.name,
        description: row.description,
        location: `session://${session}/${row.name}`,
        content: row.content,
        resources: row.resources ?? [],
      }))
    })

    const sessionCreate = Effect.fn("Skill.sessionCreate")(function* (session: string, value: CreateInput) {
      const row = yield* sessionSkill.upsert(session as SessionID, {
        name: value.name,
        description: value.description ?? "",
        content: value.content,
        resources: value.resources as any,
      }).pipe(Effect.orDie)
      return {
        name: row.name,
        description: row.description,
        location: `session://${session}/${row.name}`,
        content: row.content,
        resources: row.resources ?? [],
      }
    })

    const RESOURCE_MAX = 256 * 1024
    const BUNDLE_MAX = 1024 * 1024
    const RESOURCE_COUNT_MAX = 64
    const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".cache"])
    const isSkipPath = (rel: string) => rel.split("/").some((seg) => SKIP_DIRS.has(seg))
    const resourceKind = (file: string): Resource["type"] => {
      if (file.startsWith("templates/")) return "template"
      if (file.startsWith("references/")) return "doc"
      const ext = path.extname(file)
      if ([".md", ".mdx", ".txt"].includes(ext)) return "doc"
      if ([".sh", ".bash", ".zsh", ".py", ".js", ".ts"].includes(ext)) return "script"
      return "asset"
    }

    const attachResources = (skills: Info[]) =>
      Effect.forEach(skills, (skill) =>
        Effect.gen(function* () {
          if (skill.location.startsWith("session://") || skill.location.startsWith("memory://")) return skill
          if (skill.resources && skill.resources.length > 0) return skill
          const root = path.dirname(skill.location)
          const files = yield* fsys
            .glob("**/*", { cwd: root, absolute: true, include: "file", dot: true })
            .pipe(Effect.catch(Effect.die))
          const candidates = files
            .filter((file) => path.basename(file) !== "SKILL.md")
            .map((file) => path.relative(root, file).split(path.sep).join("/"))
            .filter((rel) => !isSkipPath(rel))
            .toSorted()
          const resources: Resource[] = []
          for (const rel of candidates) {
            const stat = yield* fsys.stat(path.join(root, rel)).pipe(Effect.option)
            const size = stat._tag === "Some" ? Number((stat.value as any).size ?? 0) : 0
            if (size > RESOURCE_MAX) continue
            const content = yield* fsys.readFileString(path.join(root, rel)).pipe(Effect.catch(Effect.die))
            if (!content) continue
            resources.push({ path: rel, type: resourceKind(rel), content })
            const total = Buffer.byteLength(skill.content)
              + resources.reduce((sum, r) => sum + Buffer.byteLength(r.content), 0)
            if (total > BUNDLE_MAX || resources.length >= RESOURCE_COUNT_MAX) break
          }
          return { ...skill, resources } satisfies Info
        }),
      )

    const sessionLoad = Effect.fn("Skill.sessionLoad")(function* (session: string, dir: string) {
      const isDir = yield* fsys.isDir(dir).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!isDir) return []
      const scanState: ScanState = { matches: new Set(), dirs: new Set() }
      yield* scan(scanState, dir, SKILL_PATTERN)
      const tmp: State = { skills: {}, dirs: new Set(), sessions: {} }
      yield* Effect.forEach([...scanState.matches], (match) => add(tmp, match, events), {
        concurrency: "unbounded",
        discard: true,
      })
      const loaded = yield* attachResources(Object.values(tmp.skills))
      const results: Info[] = []
      for (const skill of loaded) {
        const row = yield* sessionSkill.upsert(session as SessionID, {
          name: skill.name,
          description: skill.description ?? "",
          content: skill.content,
          resources: skill.resources as any,
        }).pipe(Effect.orDie)
        results.push({
          name: row.name,
          description: row.description,
          location: `session://${session}/${row.name}`,
          content: row.content,
          resources: row.resources ?? [],
        })
      }
      return results
    })

    const sessionUnload = Effect.fn("Skill.sessionUnload")(function* (session: string, name: string) {
      yield* sessionSkill.remove(session as SessionID, name).pipe(Effect.orDie)
    })

    const sessionClear = Effect.fn("Skill.sessionClear")(function* (session: string) {
      yield* sessionSkill.removeAll(session as SessionID).pipe(Effect.orDie)
    })

    return Service.of({ get, require, all, dirs, available, sessionList, sessionCreate, sessionLoad, sessionUnload, sessionClear })
  }),
)

export const layer = layerImpl.pipe(Layer.provide(SessionSkill.layer))

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.layer),
  Layer.provide(RuntimeFlags.defaultLayer),
)

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Discovery.node, Config.node, EventV2Bridge.node, FSUtil.node, Global.node, RuntimeFlags.node],
})

export * as Skill from "."
