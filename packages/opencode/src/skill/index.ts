import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer, Context, Schema } from "effect"
import { NamedError } from "@opencode-ai/core/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Global } from "@opencode-ai/core/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Config } from "@/config/config"
import { ConfigMarkdown } from "@/config/markdown"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Glob } from "@opencode-ai/core/util/glob"
import * as Log from "@opencode-ai/core/util/log"
import { Discovery } from "./discovery"
import CUSTOMIZE_OPENCODE_SKILL_BODY from "./prompt/customize-opencode.md" with { type: "text" }
import { isRecord } from "@/util/record"

const log = Log.create({ service: "skill" })
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

const add = Effect.fnUntraced(function* (state: State, match: string, bus: Bus.Interface) {
  const md = yield* Effect.tryPromise({
    try: () => ConfigMarkdown.parse(match),
    catch: (err) => err,
  }).pipe(
    Effect.catch(
      Effect.fnUntraced(function* (err) {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        const { Session } = yield* Effect.promise(() => import("@/session/session"))
        yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      }),
    ),
  )

  if (!md) return

  if (!isSkillFrontmatter(md.data)) return

  if (state.skills[md.data.name]) {
    log.warn("duplicate skill name", {
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
      log.error(`failed to scan ${opts.scope} skills`, { dir: root, error })
      return Effect.succeed([] as string[])
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
  fsys: AppFileSystem.Interface,
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
      log.warn("skill path not found", { path: dir })
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

const loadSkills = Effect.fnUntraced(function* (state: State, discovered: DiscoveryState, bus: Bus.Interface) {
  yield* Effect.forEach(discovered.matches, (match) => add(state, match, bus), {
    concurrency: "unbounded",
    discard: true,
  })

  log.info("init", { count: Object.keys(state.skills).length })
})

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const discovery = yield* Discovery.Service
    const config = yield* Config.Service
    const bus = yield* Bus.Service
    const fsys = yield* AppFileSystem.Service
    const global = yield* Global.Service
    const flags = yield* RuntimeFlags.Service
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
        yield* loadSkills(s, yield* InstanceState.get(discovered), bus)
        return s
      }),
    )

    const get = Effect.fn("Skill.get")(function* (name: string, session?: string) {
      const s = yield* InstanceState.get(state)
      if (session && s.sessions[session]?.[name]) return s.sessions[session][name]
      return s.skills[name]
    })

    const require = Effect.fn("Skill.require")(function* (name: string, session?: string) {
      const s = yield* InstanceState.get(state)
      const info = session ? (s.sessions[session]?.[name] ?? s.skills[name]) : s.skills[name]
      if (info) return info
      return yield* new NotFoundError({ name, available: Object.keys(s.skills).toSorted() })
    })

    const all = Effect.fn("Skill.all")(function* (session?: string) {
      const s = yield* InstanceState.get(state)
      if (!session) return Object.values(s.skills)
      const merged = { ...s.skills }
      for (const [name, skill] of Object.entries(s.sessions[session] ?? {})) {
        merged[name] = skill
      }
      return Object.values(merged)
    })

    const dirs = Effect.fn("Skill.dirs")(function* () {
      return (yield* InstanceState.get(discovered)).dirs
    })

    const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info, session?: string) {
      const s = yield* InstanceState.get(state)
      let list = session
        ? [...Object.values(s.sessions[session] ?? {}), ...Object.values(s.skills)]
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
      const s = yield* InstanceState.get(state)
      return Object.values(s.sessions[session] ?? {})
    })

    const sessionCreate = Effect.fn("Skill.sessionCreate")(function* (session: string, value: CreateInput) {
      const info: Info = {
        name: value.name,
        description: value.description,
        location: `memory://${value.name}`,
        content: value.content,
        resources: value.resources,
      }
      const s = yield* InstanceState.get(state)
      if (!s.sessions[session]) s.sessions[session] = {}
      s.sessions[session][value.name] = info
      return info
    })

    const sessionLoad = Effect.fn("Skill.sessionLoad")(function* (session: string, dir: string) {
      const isDir = yield* fsys.isDir(dir).pipe(Effect.catch(() => Effect.succeed(false)))
      if (!isDir) return []
      const scanState: ScanState = { matches: new Set(), dirs: new Set() }
      yield* scan(scanState, dir, SKILL_PATTERN)
      const tmp: State = { skills: {}, dirs: new Set(), sessions: {} }
      yield* Effect.forEach([...scanState.matches], (match) => add(tmp, match, bus), {
        concurrency: "unbounded",
        discard: true,
      })
      const loaded = Object.values(tmp.skills)
      const s = yield* InstanceState.get(state)
      if (!s.sessions[session]) s.sessions[session] = {}
      for (const skill of loaded) s.sessions[session][skill.name] = skill
      return loaded
    })

    const sessionUnload = Effect.fn("Skill.sessionUnload")(function* (session: string, name: string) {
      const s = yield* InstanceState.get(state)
      if (s.sessions[session]) {
        delete s.sessions[session][name]
        if (Object.keys(s.sessions[session]).length === 0) delete s.sessions[session]
      }
    })

    const sessionClear = Effect.fn("Skill.sessionClear")(function* (session: string) {
      const s = yield* InstanceState.get(state)
      delete s.sessions[session]
    })

    return Service.of({ get, require, all, dirs, available, sessionList, sessionCreate, sessionLoad, sessionUnload, sessionClear })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Discovery.defaultLayer),
  Layer.provide(Config.defaultLayer),
  Layer.provide(Bus.layer),
  Layer.provide(AppFileSystem.defaultLayer),
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
          `    <location>${pathToFileURL(skill.location).href}</location>`,
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

export * as Skill from "."
