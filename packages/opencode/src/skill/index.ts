import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import z from "zod"
import { Effect, Layer, Context, Ref } from "effect"
import { NamedError } from "@opencode-ai/shared/util/error"
import type { Agent } from "@/agent/agent"
import { Bus } from "@/bus"
import { InstanceState } from "@/effect/instance-state"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import { Permission } from "@/permission"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import { Config } from "../config/config"
import { ConfigMarkdown } from "../config/markdown"
import { Glob } from "@opencode-ai/shared/util/glob"
import { Log } from "../util/log"
import { Discovery } from "./discovery"
import { SessionSkill } from "./session-skill"
import type { SessionID } from "../session/schema"
import { Database } from "../storage/db"

export namespace Skill {
  const log = Log.create({ service: "skill" })
  const EXTERNAL_DIRS = [".claude", ".agents"]
  const EXTERNAL_SKILL_PATTERN = "skills/**/SKILL.md"
  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"
  const RESOURCE_MAX = 256 * 1024
  const BUNDLE_MAX = 1024 * 1024
  const RESOURCE_COUNT_MAX = 64

  export const Resource = z.object({
    path: z.string(),
    type: z.enum(["doc", "script", "template", "asset"]),
    content: z.string(),
  })
  export type Resource = z.infer<typeof Resource>

  export const CreateInput = z.object({
    name: z.string(),
    description: z.string(),
    content: z.string(),
    resources: Resource.array().optional(),
  })
  export type CreateInput = z.infer<typeof CreateInput>

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
    resources: Resource.array().default([]),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  type State = {
    skills: Record<string, Info>
    dirs: Set<string>
    sessions: Record<string, Record<string, Info>>
  }

  export interface Interface {
    readonly get: (name: string, session?: string) => Effect.Effect<Info | undefined>
    readonly all: (session?: string) => Effect.Effect<Info[]>
    readonly dirs: () => Effect.Effect<string[]>
    readonly available: (agent?: Agent.Info, session?: string) => Effect.Effect<Info[]>
    readonly load: (path: string) => Effect.Effect<Info[]>
    readonly loadFromURL: (url: string) => Effect.Effect<Info[]>
    readonly create: (info: CreateInput) => Effect.Effect<Info>
    readonly unload: (name: string) => Effect.Effect<void>
    readonly sessionLoad: (session: string, dir: string) => Effect.Effect<Info[]>
    readonly sessionList: (session: string) => Effect.Effect<Info[]>
    readonly sessionUnload: (session: string, name: string) => Effect.Effect<void>
    readonly sessionCreate: (session: string, input: CreateInput) => Effect.Effect<Info>
    readonly sessionClear: (session: string) => Effect.Effect<void>
  }

  function check(info: CreateInput) {
    const resources = info.resources ?? []
    if (resources.length > RESOURCE_COUNT_MAX) return `Too many resources: ${resources.length}`
    const total = Buffer.byteLength(info.content)
      + resources.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0)
    if (total > BUNDLE_MAX) return `Skill bundle is too large: ${total} bytes`
    for (const item of resources) {
      if (!item.path || path.isAbsolute(item.path) || item.path.split("/").includes("..")) return `Invalid resource path: ${item.path}`
      const size = Buffer.byteLength(item.content)
      if (size > RESOURCE_MAX) return `Resource is too large: ${item.path}`
    }
  }

  function normalize(info: CreateInput) {
    const message = check(info)
    if (message) throw new InvalidError({ path: info.name, message })
    return { ...info, resources: info.resources ?? [] }
  }

  function kind(file: string): Resource["type"] {
    if (file.startsWith("templates/")) return "template"
    if (file.startsWith("references/")) return "doc"
    const ext = path.extname(file)
    if ([".md", ".mdx", ".txt"].includes(ext)) return "doc"
    if ([".sh", ".bash", ".zsh", ".py", ".js", ".ts"].includes(ext)) return "script"
    return "asset"
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
          const { Session } = yield* Effect.promise(() => import("@/session"))
          yield* bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
          log.error("failed to load skill", { skill: match, err })
          return undefined
        }),
      ),
    )

    if (!md) return

    const parsed = Info.pick({ name: true, description: true }).safeParse(md.data)
    if (!parsed.success) return

    if (state.skills[parsed.data.name]) {
      log.warn("duplicate skill name", {
        name: parsed.data.name,
        existing: state.skills[parsed.data.name].location,
        duplicate: match,
      })
    }

    state.dirs.add(path.dirname(match))
    state.skills[parsed.data.name] = {
      name: parsed.data.name,
      description: parsed.data.description,
      location: match,
      content: md.content,
      resources: [],
    }
  })

  const scan = Effect.fnUntraced(function* (
    state: State,
    bus: Bus.Interface,
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

    yield* Effect.forEach(matches, (match) => add(state, match, bus), {
      concurrency: "unbounded",
      discard: true,
    })
  })

  const loadSkills = Effect.fnUntraced(function* (
    state: State,
    config: Config.Interface,
    discovery: Discovery.Interface,
    bus: Bus.Interface,
    fsys: AppFileSystem.Interface,
    directory: string,
    worktree: string,
  ) {
    if (!Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) {
      for (const dir of EXTERNAL_DIRS) {
        const root = path.join(Global.Path.home, dir)
        if (!(yield* fsys.isDir(root))) continue
        yield* scan(state, bus, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "global" })
      }

      const upDirs = yield* fsys
        .up({ targets: EXTERNAL_DIRS, start: directory, stop: worktree })
        .pipe(Effect.catch(() => Effect.succeed([] as string[])))

      for (const root of upDirs) {
        yield* scan(state, bus, root, EXTERNAL_SKILL_PATTERN, { dot: true, scope: "project" })
      }
    }

    const configDirs = yield* config.directories()
    for (const dir of configDirs) {
      yield* scan(state, bus, dir, OPENCODE_SKILL_PATTERN)
    }

    const cfg = yield* config.get()
    for (const item of cfg.skills?.paths ?? []) {
      const expanded = item.startsWith("~/") ? path.join(os.homedir(), item.slice(2)) : item
      const dir = path.isAbsolute(expanded) ? expanded : path.join(directory, expanded)
      if (!(yield* fsys.isDir(dir))) {
        log.warn("skill path not found", { path: dir })
        continue
      }

      yield* scan(state, bus, dir, SKILL_PATTERN)
    }

    for (const url of cfg.skills?.urls ?? []) {
      const pulledDirs = yield* discovery.pull(url)
      for (const dir of pulledDirs) {
        state.dirs.add(dir)
        yield* scan(state, bus, dir, SKILL_PATTERN)
      }
    }

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
      const sessionSkill = yield* SessionSkill.Service
      const istate = yield* InstanceState.make(
        Effect.fn("Skill.state")(function* (ctx) {
          const s: State = { skills: {}, dirs: new Set(), sessions: {} }
          yield* loadSkills(s, config, discovery, bus, fsys, ctx.directory, ctx.worktree)
          return yield* Ref.make(s)
        }),
      )

      const state = () => Effect.flatMap(InstanceState.get(istate), Ref.get)

      const isPg = Database.dialect === "pg"

      const merged = Effect.fn("Skill.merged")(function* (s: State, session?: string) {
        if (!session) return s.skills
        if (isPg) {
          const rows = yield* sessionSkill.list(session as SessionID)
          const overlay = Object.fromEntries(rows.map((row) => [row.name, {
            name: row.name,
            description: row.description,
            location: `session://${session}/${row.name}`,
            content: row.content,
            resources: row.resources ?? [],
          } satisfies Info]))
          return { ...s.skills, ...overlay }
        }
        return { ...s.skills, ...(s.sessions[session] || {}) }
      })

      const get = Effect.fn("Skill.get")(function* (name: string, session?: string) {
        const s = yield* state()
        return (yield* merged(s, session))[name]
      })

      const all = Effect.fn("Skill.all")(function* (session?: string) {
        const s = yield* state()
        return Object.values(yield* merged(s, session))
      })

      const dirs = Effect.fn("Skill.dirs")(function* () {
        const s = yield* state()
        return Array.from(s.dirs)
      })

      const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info, session?: string) {
        const s = yield* state()
        const list = Object.values(yield* merged(s, session)).toSorted((a, b) => a.name.localeCompare(b.name))
        if (!agent) return list
        return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
      })

      const load = Effect.fn("Skill.load")(function* (dir: string) {
        if (!(yield* fsys.isDir(dir))) return []
        const ref = yield* InstanceState.get(istate)
        const before = new Set(Object.keys((yield* Ref.get(ref)).skills))
        yield* scan(yield* Ref.get(ref), bus, dir, SKILL_PATTERN)
        const after = (yield* Ref.get(ref)).skills
        return Object.values(after).filter((s) => !before.has(s.name))
      })

      const loadFromURL = Effect.fn("Skill.loadFromURL")(function* (url: string) {
        const pulled = yield* discovery.pull(url)
        if (pulled.length === 0) return []
        const ref = yield* InstanceState.get(istate)
        const before = new Set(Object.keys((yield* Ref.get(ref)).skills))
        for (const dir of pulled) {
          yield* Ref.update(ref, (s) => { s.dirs.add(dir); return s })
          yield* scan(yield* Ref.get(ref), bus, dir, SKILL_PATTERN)
        }
        const after = (yield* Ref.get(ref)).skills
        return Object.values(after).filter((s) => !before.has(s.name))
      })

      const unload = Effect.fn("Skill.unload")(function* (name: string) {
        const ref = yield* InstanceState.get(istate)
        yield* Ref.update(ref, (s) => { delete s.skills[name]; return s })
      })

      const create = Effect.fn("Skill.create")(function* (value: CreateInput) {
        const input = normalize(value)
        const ref = yield* InstanceState.get(istate)
        const info: Info = {
          name: input.name,
          description: input.description,
          location: `memory://${input.name}`,
          content: input.content,
          resources: input.resources,
        }
        yield* Ref.update(ref, (s) => { s.skills[input.name] = info; return s })
        return info
      })

      const sessionLoad = Effect.fn("Skill.sessionLoad")(function* (session: string, dir: string) {
        if (!(yield* fsys.isDir(dir))) return []
        const tmp: State = { skills: {}, dirs: new Set(), sessions: {} }
        yield* scan(tmp, bus, dir, SKILL_PATTERN)
        const loaded = yield* Effect.forEach(Object.values(tmp.skills), (skill) =>
          Effect.gen(function* () {
            if (skill.location.startsWith("session://") || skill.location.startsWith("memory://")) return skill
            const root = path.dirname(skill.location)
            const files = yield* fsys.glob("**/*", { cwd: root, absolute: true, include: "file", dot: true }).pipe(Effect.catch(Effect.die))
            const resources = yield* Effect.forEach(
              files
                .filter((file) => path.basename(file) !== "SKILL.md")
                .map((file) => path.relative(root, file).split(path.sep).join("/"))
                .toSorted(),
              (rel) =>
                Effect.gen(function* () {
                  return {
                    path: rel,
                    type: kind(rel),
                    content: yield* fsys.readFileString(path.join(root, rel)).pipe(Effect.catch(Effect.die)),
                  } satisfies Resource
                }),
            )
            const next = normalize({
              name: skill.name,
              description: skill.description,
              content: skill.content,
              resources,
            })
            return { ...skill, resources: next.resources } satisfies Info
          }),
        )
        if (isPg) {
          return yield* Effect.forEach(loaded, (skill) =>
            sessionSkill.upsert(session as SessionID, {
              name: skill.name,
              description: skill.description,
              content: skill.content,
              resources: skill.resources,
            }).pipe(Effect.map((row) => ({
              name: row.name,
              description: row.description,
              location: `session://${session}/${row.name}`,
              content: row.content,
              resources: row.resources ?? [],
            }))),
          )
        }
        const ref = yield* InstanceState.get(istate)
        yield* Ref.update(ref, (s) => {
          if (!s.sessions[session]) s.sessions[session] = {}
          for (const skill of loaded) s.sessions[session][skill.name] = skill
          return s
        })
        return loaded
      })

      const sessionList = Effect.fn("Skill.sessionList")(function* (session: string) {
        if (isPg) {
          const rows = yield* sessionSkill.list(session as SessionID)
          return rows.map((row) => ({
            name: row.name,
            description: row.description,
            location: `session://${session}/${row.name}`,
            content: row.content,
            resources: row.resources ?? [],
          }))
        }
        const s = yield* state()
        return Object.values(s.sessions[session] || {})
      })

      const sessionUnload = Effect.fn("Skill.sessionUnload")(function* (session: string, name: string) {
        if (isPg) {
          yield* sessionSkill.remove(session as SessionID, name)
        } else {
          const ref = yield* InstanceState.get(istate)
          yield* Ref.update(ref, (s) => {
            if (s.sessions[session]) {
              delete s.sessions[session][name]
              if (Object.keys(s.sessions[session]).length === 0) delete s.sessions[session]
            }
            return s
          })
        }
      })

      const sessionCreate = Effect.fn("Skill.sessionCreate")(function* (session: string, value: CreateInput) {
        const input = normalize(value)
        if (isPg) {
          const row = yield* sessionSkill.upsert(session as SessionID, input)
          return {
            name: row.name,
            description: row.description,
            location: `session://${session}/${row.name}`,
            content: row.content,
            resources: row.resources ?? [],
          }
        }
        const info: Info = {
          name: input.name,
          description: input.description,
          location: `memory://${input.name}`,
          content: input.content,
          resources: input.resources,
        }
        const ref = yield* InstanceState.get(istate)
        yield* Ref.update(ref, (s) => {
          if (!s.sessions[session]) s.sessions[session] = {}
          s.sessions[session][input.name] = info
          return s
        })
        return info
      })

      const sessionClear = Effect.fn("Skill.sessionClear")(function* (session: string) {
        if (isPg) {
          yield* sessionSkill.removeAll(session as SessionID)
        } else {
          const ref = yield* InstanceState.get(istate)
          yield* Ref.update(ref, (s) => { delete s.sessions[session]; return s })
        }
      })

      return Service.of({ get, all, dirs, available, load, loadFromURL, create, unload, sessionLoad, sessionList, sessionUnload, sessionCreate, sessionClear })
    }),
  )

  export const defaultLayer = layer.pipe(
    Layer.provide(Discovery.defaultLayer),
    Layer.provide(Config.defaultLayer),
    Layer.provide(Bus.layer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(Database.dialect === "pg" ? SessionSkill.layer : SessionSkill.noopLayer),
  )

  export function fmt(list: Info[], opts: { verbose: boolean }) {
    if (list.length === 0) return "No skills are currently available."
    if (opts.verbose) {
      return [
        "<available_skills>",
        ...list
          .sort((a, b) => a.name.localeCompare(b.name))
          .flatMap((skill) => [
            "  <skill>",
            `    <name>${skill.name}</name>`,
            `    <description>${skill.description}</description>`,
            `    <location>${skill.location.includes("://") ? skill.location : pathToFileURL(skill.location).href}</location>`,
            "  </skill>",
          ]),
        "</available_skills>",
      ].join("\n")
    }

    return [
      "## Available Skills",
      ...list
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((skill) => `- **${skill.name}**: ${skill.description}`),
    ].join("\n")
  }
}
