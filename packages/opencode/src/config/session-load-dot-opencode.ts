export * as SessionLoadDotOpencode from "./session-load-dot-opencode"

import path from "path"
import { realpath, lstat } from "fs/promises"
import { Effect, Context, Layer, Option, Schema, Exit } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ConfigAgentV1 } from "@opencode-ai/core/v1/config/agent"
import { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"
import { ConfigMCPV1 } from "@opencode-ai/core/v1/config/mcp"
import type { SessionID } from "@/session/schema"
import { Filesystem } from "@/util/filesystem"
import { Permission } from "@/permission"
import { Provider } from "@/provider/provider"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { ConfigMarkdown as ConfigMarkdownCore } from "@opencode-ai/core/config/markdown"
import { ConfigParse } from "./parse"
import { configEntryNameFromPath } from "./entry-name"
import { SessionAgentsMd } from "@/session/agents-md"
import { SessionAgent } from "@/agent/session-agent"
import { SessionSkill } from "@/skill/session-skill"
import { SessionMcp } from "@/mcp/session-mcp"
import { SessionTool } from "@/tool/session-tool"
import { SessionCommand } from "@/command/session-command"
import { SessionPlugin } from "@/plugin/session-plugin"

export type Diagnostic = { path: string; reason: string }

export type Result = { loaded: string[]; skipped: Diagnostic[] }

export interface Interface {
  readonly load: (sessionID: SessionID, directory: string) => Effect.Effect<Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLoadDotOpencode") {}

const INTERNAL_AGENTS = new Set(["compaction", "title", "summary"])

const RESOURCE_MAX = 256 * 1024
const BUNDLE_MAX = 1024 * 1024
const RESOURCE_COUNT_MAX = 64
const SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store", "__pycache__", ".cache"])

// ── FileSource: abstracts local FS vs sandbox file access ──

interface FileSource {
  exists(p: string): Effect.Effect<boolean>
  readText(p: string): Effect.Effect<string>
  scan(pattern: string, cwd: string): Effect.Effect<string[]>
  validateFile(worktree: string, file: string): Effect.Effect<string | undefined>
  size(p: string): Effect.Effect<number>
}

function localSource(): FileSource {
  const resolveReal = (p: string) => realpath(p).catch(() => undefined)

  const validate = async (worktree: string, file: string): Promise<string | undefined> => {
    const [resolvedFile, resolvedWorktree] = await Promise.all([
      resolveReal(file),
      resolveReal(worktree).catch(() => worktree),
    ])
    if (!resolvedFile || !resolvedWorktree) return undefined
    if (!Filesystem.contains(resolvedWorktree, resolvedFile)) return undefined
    const info = await lstat(resolvedFile).catch(() => undefined)
    if (!info?.isFile()) return undefined
    return resolvedFile
  }

  return {
    exists: (p) => Effect.promise(() => Filesystem.exists(p)),
    readText: (p) => Effect.promise(() => Filesystem.readText(p).catch(() => "")),
    scan: (pattern, cwd) =>
      Effect.tryPromise({
        try: () => Glob.scan(pattern, { cwd, absolute: true, include: "file", symlink: true, dot: true }),
        catch: () => new Error("scan failed"),
      }).pipe(Effect.catch(() => Effect.succeed([] as string[]))),
    validateFile: (worktree, file) => Effect.promise(() => validate(worktree, file)),
    size: (p) => Effect.promise(() => Filesystem.size(p)),
  }
}

function sandboxSource(sp: NonNullable<SandboxProvider.Interface>, sessionID: SessionID): FileSource {
  const stdout = (r: { logs: { stdout: Array<{ text: string } | string> } }) =>
    r.logs.stdout.map((l) => (typeof l === "string" ? l : l.text)).join("\n")

  const run = (cmd: string, timeoutSeconds = 10) =>
    sp.runInSession(sessionID, cmd, { timeoutSeconds }).pipe(
      Effect.catch(() => Effect.succeed({ logs: { stdout: [] as any[], stderr: [] }, exitCode: 1 } as any)),
    )

  return {
    exists: (p) =>
      Effect.gen(function* () {
        const r = yield* run(`test -e "${p}" && echo YES`, 5)
        return stdout(r).includes("YES")
      }),

    readText: (p) =>
      Effect.gen(function* () {
        const sb = yield* sp.getOrCreate(sessionID).pipe(
          Effect.catch(() => Effect.succeed(null as any)),
        )
        if (!sb) return ""
        return yield* Effect.promise(() => sb.files.readFile(p).catch(() => "") as Promise<string>)
      }),

    scan: (pattern, cwd) =>
      Effect.gen(function* () {
        const r = yield* run(
          `find '${cwd}' -type f -not -path '*/.git/*' -not -path '*/node_modules/*' -not -name '._*' 2>/dev/null`,
          15,
        )
        return stdout(r)
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .filter((file) => Glob.match(pattern, path.relative(cwd, file).split(path.sep).join("/")))
      }),

    validateFile: (worktree, file) =>
      Effect.gen(function* () {
        const r = yield* run(`rp=$(realpath "${file}" 2>/dev/null) && wt=$(realpath "${worktree}" 2>/dev/null) && test -f "$rp" && echo "OK $rp $wt"`, 5)
        const out = stdout(r).trim()
        if (!out.startsWith("OK ")) return undefined
        const [, real, realWt] = out.split(" ")
        if (!Filesystem.contains(realWt || worktree, real)) return undefined
        return file
      }),

    size: (p) =>
      Effect.gen(function* () {
        const r = yield* run(`wc -c < "${p}" 2>/dev/null`, 5)
        return parseInt(stdout(r).trim()) || 0
      }),
  }
}

// ── Helpers ──

type SkillResource = { path: string; type: "doc" | "script" | "template" | "asset"; content: string }

function resourceKind(file: string): SkillResource["type"] {
  if (file.startsWith("templates/")) return "template"
  if (file.startsWith("references/")) return "doc"
  const ext = path.extname(file)
  if ([".md", ".mdx", ".txt"].includes(ext)) return "doc"
  if ([".sh", ".bash", ".zsh", ".py", ".js", ".ts"].includes(ext)) return "script"
  return "asset"
}

const isSkipPath = (rel: string) => rel.split("/").some((seg) => SKIP_DIRS.has(seg))

function collectSkillResources(fs: FileSource, worktree: string, skillRoot: string): Effect.Effect<SkillResource[]> {
  return Effect.gen(function* () {
    const files = yield* fs.scan("**/*", skillRoot).pipe(Effect.catch(() => Effect.succeed([] as string[])))

    const candidates = files
      .filter((file) => path.basename(file) !== "SKILL.md")
      .map((file) => path.relative(skillRoot, file).split(path.sep).join("/"))
      .filter((rel) => !isSkipPath(rel))
      .toSorted()

    const resources: SkillResource[] = []
    let total = 0
    for (const rel of candidates) {
      const absolute = path.join(skillRoot, rel)
      const validPath = yield* fs.validateFile(worktree, absolute)
      if (!validPath) continue
      const size = yield* fs.size(validPath)
      if (size > RESOURCE_MAX) continue
      const content = yield* fs.readText(validPath)
      if (!content) continue
      resources.push({ path: rel, type: resourceKind(rel), content })
      total += Buffer.byteLength(content)
      if (total > BUNDLE_MAX || resources.length >= RESOURCE_COUNT_MAX) break
    }
    return resources
  })
}

function toAgentInput(name: string, value: ConfigAgentV1.Info): SessionAgent.Input {
  return {
    name,
    description: value.description,
    mode: value.mode ?? "all",
    prompt: value.prompt,
    permission: Permission.fromConfig(value.permission ?? {}),
    model: value.model ? Provider.parseModel(value.model) : undefined,
    temperature: value.temperature,
    topP: value.top_p,
    steps: value.steps,
    color: value.color,
    variant: value.variant,
    options: value.options,
  }
}

function toCommandInput(name: string, value: ConfigCommandV1.Info): SessionCommand.Input {
  return {
    name,
    description: value.description,
    template: value.template,
    agent: value.agent,
    model: value.model,
    subtask: value.subtask,
  }
}

function toMcpInput(name: string, value: ConfigMCPV1.Info): SessionMcp.Input {
  if (value.type === "local") {
    return { name, type: "local", command: value.command, environment: value.environment, enabled: value.enabled }
  }
  return { name, type: "remote", url: value.url, headers: value.headers, enabled: value.enabled }
}

// ── Layer ──

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const load = Effect.fn("SessionLoadDotOpencode.load")(function* (sessionID: SessionID, directory: string) {
      const sp = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
      const fs = sp ? sandboxSource(sp, sessionID) : localSource()
      return yield* loadFromDirectory(sessionID, directory, fs)
    })

    const loadFromDirectory = Effect.fn("SessionLoadDotOpencode.loadFromDirectory")(function* (
      sessionID: SessionID,
      directory: string,
      fs: FileSource,
    ) {
      const agentsMdSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionAgentsMd.Service))
      const agentSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionAgent.Service))
      const skillSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionSkill.Service))
      const mcpSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionMcp.Service))
      const toolSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionTool.Service))
      const commandSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionCommand.Service))
      const pluginSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionPlugin.Service))

      const dotDir = path.join(directory, ".opencode")
      const hasDotDir = yield* fs.exists(dotDir)
      const loaded: string[] = []
      const skipped: Diagnostic[] = []

      if (!hasDotDir && !(yield* fs.exists(path.join(directory, "AGENTS.md"))) && !(yield* fs.exists(path.join(directory, "opencode.json"))) && !(yield* fs.exists(path.join(directory, "opencode.jsonc")))) return { loaded, skipped }

      for (const [service, resource] of [
        [agentsMdSvc, "AGENTS.md"],
        [agentSvc, "agents"],
        [skillSvc, "skills"],
        [mcpSvc, "mcp"],
        [toolSvc, "tools"],
        [commandSvc, "commands"],
        [pluginSvc, "plugins"],
      ] as const) {
        if (!service) skipped.push({ path: resource, reason: "Session service unavailable" })
      }

      // AGENTS.md — check .opencode/AGENTS.md first, then project root AGENTS.md
      if (agentsMdSvc) {
        let agentsMdPath = path.join(dotDir, "AGENTS.md")
        let validPath = hasDotDir ? yield* fs.validateFile(directory, agentsMdPath) : undefined
        if (!validPath) {
          agentsMdPath = path.join(directory, "AGENTS.md")
          validPath = yield* fs.validateFile(directory, agentsMdPath)
        }
        if (validPath) {
          const content = yield* fs.readText(validPath)
          if (content.trim()) {
            yield* agentsMdSvc.upsert(sessionID, { content })
            loaded.push("AGENTS.md")
          }
        }
      }

      // agents — only scan .opencode/ subdirectory
      if (agentSvc && hasDotDir) {
        const agentFiles = yield* fs.scan("{agent,agents}/**/*.md", dotDir).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              skipped.push({ path: "agents", reason: `failed to scan agents: ${String(error)}` })
              return [] as string[]
            }),
          ),
        )
        for (const agentFile of agentFiles) {
          const rel = path.relative(dotDir, agentFile)
          const validPath = yield* fs.validateFile(directory, agentFile)
          if (!validPath) {
            skipped.push({ path: rel, reason: "path outside worktree or not a regular file" })
            continue
          }
          const raw = yield* fs.readText(validPath)
          const md = yield* Effect.try({ try: () => ConfigMarkdownCore.parse(raw), catch: () => undefined as any }).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!md) {
            skipped.push({ path: rel, reason: "invalid markdown" })
            continue
          }
          const name = configEntryNameFromPath(rel, ["agent/", "agents/"])
          const parsed = yield* Effect.try({
            try: () => ConfigParse.schema(ConfigAgentV1.Info, { name, ...md.data, prompt: md.content.trim() }, validPath),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                skipped.push({ path: rel, reason: `invalid agent config: ${String(error)}` })
                return undefined
              }),
            ),
          )
          if (!parsed) continue
          if (parsed.disable) {
            skipped.push({ path: `agents/${name}`, reason: "disabled" })
            continue
          }
          if (INTERNAL_AGENTS.has(name)) {
            skipped.push({ path: `agents/${name}`, reason: "internal agent" })
            continue
          }
          yield* agentSvc.upsert(sessionID, toAgentInput(name, parsed))
          loaded.push(`agents/${name}`)
        }
      }

      // skills
      if (skillSvc && hasDotDir) {
        const skillFiles = yield* fs.scan("{skill,skills}/**/SKILL.md", dotDir).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              skipped.push({ path: "skills", reason: `failed to scan skills: ${String(error)}` })
              return [] as string[]
            }),
          ),
        )
        for (const skillFile of skillFiles) {
          const rel = path.relative(dotDir, skillFile)
          const validPath = yield* fs.validateFile(directory, skillFile)
          if (!validPath) {
            skipped.push({ path: rel, reason: "path outside worktree or not a regular file" })
            continue
          }
          const raw = yield* fs.readText(validPath)
          const md = yield* Effect.try({ try: () => ConfigMarkdownCore.parse(raw), catch: () => undefined as any }).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!md || typeof md.data !== "object" || md.data === null || typeof (md.data as { name?: unknown }).name !== "string") {
            skipped.push({ path: rel, reason: "invalid skill frontmatter" })
            continue
          }
          const data = md.data as { name: string; description?: string }
          const resources = yield* collectSkillResources(fs, directory, path.dirname(validPath))
          yield* skillSvc.upsert(sessionID, {
            name: data.name,
            description: data.description ?? "",
            content: md.content,
            resources,
          })
          loaded.push(`skills/${data.name}`)
        }
      }

      // MCP (from opencode.json / opencode.jsonc) — check .opencode/ first, then project root
      if (mcpSvc) {
        for (const file of ["opencode.json", "opencode.jsonc"]) {
          let mcpPath = path.join(dotDir, file)
          let validPath = hasDotDir ? yield* fs.validateFile(directory, mcpPath) : undefined
          if (!validPath) {
            mcpPath = path.join(directory, file)
            validPath = yield* fs.validateFile(directory, mcpPath)
          }
          if (!validPath) continue
          const raw = yield* fs.readText(validPath)
          if (!raw) continue
          const data = yield* Effect.try({ try: () => ConfigParse.jsonc(raw, validPath), catch: (error) => error }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                skipped.push({ path: file, reason: `invalid JSON: ${String(error)}` })
                return null
              }),
            ),
          )
          if (!data || typeof data !== "object") continue
          const mcpMap = (data as { mcp?: Record<string, unknown> }).mcp
          if (!mcpMap) continue
          for (const [name, value] of Object.entries(mcpMap)) {
            const decoded = Schema.decodeUnknownExit(ConfigMCPV1.Info)(value)
            if (!Exit.isSuccess(decoded)) {
              skipped.push({ path: `${file}:mcp.${name}`, reason: "invalid MCP config" })
              continue
            }
            yield* mcpSvc.upsert(sessionID, toMcpInput(name, decoded.value))
            loaded.push(`mcp/${name}`)
          }
        }
      }

      // tools
      if (toolSvc && hasDotDir) {
        const toolFiles = yield* fs.scan("tool/*.{ts,js}", dotDir).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              skipped.push({ path: "tools", reason: `failed to scan tools: ${String(error)}` })
              return [] as string[]
            }),
          ),
        )
        for (const toolFile of toolFiles) {
          const rel = path.relative(dotDir, toolFile)
          const validPath = yield* fs.validateFile(directory, toolFile)
          if (!validPath) {
            skipped.push({ path: rel, reason: "path outside worktree or not a regular file" })
            continue
          }
          const name = path.basename(validPath, path.extname(validPath))
          const raw = yield* fs.readText(validPath)
          if (!raw.trim()) {
            skipped.push({ path: rel, reason: "empty tool file" })
            continue
          }
          yield* toolSvc.upsert(sessionID, { name, description: "", code: raw })
          loaded.push(`tool/${name}`)
        }
      }

      // commands
      if (commandSvc && hasDotDir) {
        const commandFiles = yield* fs.scan("{command,commands}/**/*.md", dotDir).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              skipped.push({ path: "commands", reason: `failed to scan commands: ${String(error)}` })
              return [] as string[]
            }),
          ),
        )
        for (const commandFile of commandFiles) {
          const rel = path.relative(dotDir, commandFile)
          const validPath = yield* fs.validateFile(directory, commandFile)
          if (!validPath) {
            skipped.push({ path: rel, reason: "path outside worktree or not a regular file" })
            continue
          }
          const raw = yield* fs.readText(validPath)
          const md = yield* Effect.try({ try: () => ConfigMarkdownCore.parse(raw), catch: () => undefined as any }).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          )
          if (!md) {
            skipped.push({ path: rel, reason: "invalid markdown" })
            continue
          }
          const name = configEntryNameFromPath(rel, ["command/", "commands/"])
          const parsed = yield* Effect.try({
            try: () => ConfigParse.schema(ConfigCommandV1.Info, { ...md.data, template: md.content.trim() }, validPath),
            catch: (error) => error,
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                skipped.push({ path: rel, reason: `invalid command config: ${String(error)}` })
                return undefined
              }),
            ),
          )
          if (!parsed) continue
          yield* commandSvc.upsert(sessionID, toCommandInput(name, parsed))
          loaded.push(`commands/${name}`)
        }
      }

      // plugins
      if (pluginSvc && hasDotDir) {
        const pluginFiles = yield* fs.scan("{plugin,plugins}/*.{ts,js}", dotDir).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              skipped.push({ path: "plugins", reason: `failed to scan plugins: ${String(error)}` })
              return [] as string[]
            }),
          ),
        )
        for (const pluginFile of pluginFiles) {
          const rel = path.relative(dotDir, pluginFile)
          const validPath = yield* fs.validateFile(directory, pluginFile)
          if (!validPath) {
            skipped.push({ path: rel, reason: "path outside worktree or not a regular file" })
            continue
          }
          const name = path.basename(validPath, path.extname(validPath))
          const code = yield* fs.readText(validPath)
          if (!code.trim()) {
            skipped.push({ path: rel, reason: "empty plugin file" })
            continue
          }
          yield* pluginSvc.upsert(sessionID, { name, code, source: "code" })
          loaded.push(`plugins/${name}`)
        }
      }

      return { loaded, skipped }
    })

    return Service.of({ load })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [],
})
