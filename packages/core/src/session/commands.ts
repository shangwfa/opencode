export * as SessionCommands from "./commands.js"

import { and, eq } from "drizzle-orm"
import { Effect } from "effect"
import { SessionCommand } from "@opencode/schema/session-command"
import { Database } from "../database/database.js"
import { SandboxProvider } from "../sandbox/provider.js"
import { Session } from "../session.js"
import { SessionCommandTable } from "./sql.js"
import { Instance } from "../instance/service.js"
import { Plugin } from "../plugin/service.js"
import { Command } from "../command.js"
import { Agent } from "../agent.js"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { ConfigCommand } from "@opencode/schema/config/command"
import { ConfigMarkdown } from "../config/markdown.js"
import { Option, Schema } from "effect"

export type Definition = SessionCommand.Definition
export type CreateInput = SessionCommand.CreatePayload
export interface RuntimeActions extends Pick<Session.Interface, "prompt" | "switchAgent" | "switchModel"> {
  readonly subagent: (input: {
    readonly definition: Definition
    readonly text: string
    readonly prompt: Command.Invocation["prompt"]
  }) => Effect.Effect<void, unknown>
}
const decodeCommand = Schema.decodeUnknownOption(ConfigCommand.Info)

export function validName(name: string) {
  return name.length > 0 && /^[\p{L}\p{N}._/-]+$/u.test(name) && name.split("/").every((part) => part && part !== "." && part !== "..")
}

function inferHints(template: string) {
  const positional = [...template.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]))
  if (template.includes("$ARGUMENTS")) return ["$ARGUMENTS"]
  return [...new Set(positional)].sort((a, b) => a - b).map((position) => `$${position}`)
}

export const list = Effect.fn("SessionCommands.list")(function* (session: Session.Info) {
  const builtin = yield* baseCommands(session)
  const stored = yield* listStored(session.id)
  const scanned = yield* scan(session)
  return mergeCommands(builtin, stored, scanned)
})

export const get = Effect.fn("SessionCommands.get")(function* (session: Session.Info, name: string) {
  const definitions = yield* list(session)
  return definitions.find((item) => item.name === name)
})

export const create = Effect.fn("SessionCommands.create")(function* (sessionID: Session.ID, input: CreateInput) {
  const { db } = yield* Database.Service
  const now = Date.now()
  const id = `scmd_${crypto.randomUUID().replaceAll("-", "")}`
  const subagent = input.subagent ?? input.subtask ?? null
  const hints = input.hints ?? inferHints(input.template)
  const [row] = yield* db
    .insert(SessionCommandTable)
    .values({
      id,
      session_id: sessionID,
      name: input.name,
      description: input.description ?? null,
      template: input.template,
      agent: input.agent ?? null,
      model: input.model,
      subagent,
      hints: [...hints],
      time_created: now,
      time_updated: now,
    })
    .onConflictDoUpdate({
      target: [SessionCommandTable.session_id, SessionCommandTable.name],
      set: {
        description: input.description ?? null,
        template: input.template,
        agent: input.agent ?? null,
        model: input.model,
        subagent,
        hints: [...hints],
        time_updated: now,
      },
    })
    .returning()
    .pipe(Effect.orDie)
  return fromRow(row, "session")
})

export const remove = Effect.fn("SessionCommands.remove")(function* (sessionID: Session.ID, name: string) {
  const { db } = yield* Database.Service
  yield* db
    .delete(SessionCommandTable)
    .where(and(eq(SessionCommandTable.session_id, sessionID), eq(SessionCommandTable.name, name)))
    .pipe(Effect.orDie)
})

export const clear = Effect.fn("SessionCommands.clear")(function* (sessionID: Session.ID) {
  const { db } = yield* Database.Service
  yield* db.delete(SessionCommandTable).where(eq(SessionCommandTable.session_id, sessionID)).pipe(Effect.orDie)
})

export const refresh = Effect.fn("SessionCommands.refresh")(function* (session: Session.Info) {
  return yield* list(session)
})

export function executable(
  session: Session.Info,
  definition: Definition,
  actions: RuntimeActions,
  sandbox: Pick<SandboxProvider.Interface, "run">,
): Command.Definition {
  return {
    name: definition.name,
    description: definition.description,
    execute: (input) =>
      Effect.gen(function* () {
        const text = yield* expandTemplate(definition.template ?? "", input.prompt.text, session, sandbox)
        const model = definition.model
          ? typeof definition.model === "string"
            ? Model.Ref.parse(definition.model)
            : Model.Ref.make({
                id: Model.ID.make(definition.model.model),
                providerID: Provider.ID.make(definition.model.providerID),
                ...(definition.model.variant ? { variant: Model.VariantID.make(definition.model.variant) } : {}),
              })
          : undefined
        if (definition.subagent) {
          yield* actions.subagent({ definition, text, prompt: input.prompt })
          return
        }
        if (definition.agent) yield* actions.switchAgent({ sessionID: session.id, agent: Agent.ID.make(definition.agent) })
        if (model) yield* actions.switchModel({ sessionID: session.id, model })
        yield* actions.prompt({
          ...input.prompt,
          sessionID: session.id,
          text,
          delivery: input.delivery,
        })
      }).pipe(Effect.asVoid),
  }
}

function listStored(sessionID: Session.ID) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const rows = yield* db
      .select()
      .from(SessionCommandTable)
      .where(eq(SessionCommandTable.session_id, sessionID))
      .all()
      .pipe(Effect.orDie)
    return rows.map((row) => fromRow(row, "session"))
  })
}

function baseCommands(session: Session.Info) {
  return Effect.gen(function* () {
    const instances = yield* Instance.Service
    const commands = yield* Plugin.awaitActivation.pipe(
      Effect.andThen(Command.Service),
      instances.provide(session),
    )
    return (yield* commands.list()).map((item) =>
      SessionCommand.Definition.make({ name: item.name, description: item.description, hints: [], source: "builtin" }),
    )
  })
}

function scan(session: Session.Info) {
  return Effect.gen(function* () {
    const sandbox = yield* SandboxProvider.Service
    return yield* scanSandbox(session.id, session.location.directory, sandbox)
  })
}

export const scanSandbox = Effect.fn("SessionCommands.scanSandbox")(
  function* (sessionID: Session.ID, directory: string, sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">) {
    if (!sandbox.enabled) return []
    const startedAt = Date.now()
    const command = `for d in /workspace/.opencode/command /workspace/.opencode/commands; do [ ! -d "$d" ] || find "$d" -type f -name '*.md' -print; done`
    const result = yield* sandbox.run({ sessionID, command, cwd: "/workspace", hostWorkdir: directory, timeoutMs: 10_000 })
    if (result.exitCode !== 0) return yield* Effect.fail(new Error(`Sandbox command scan failed: ${result.output}`))
    const files = [...new Set(result.output.split("\n").map((item) => item.trim()).filter(Boolean))]
      .filter((file) => file.startsWith("/workspace/.opencode/command/") || file.startsWith("/workspace/.opencode/commands/"))
      .filter((file) => file.endsWith(".md"))
      .sort()
    const definitions = yield* Effect.forEach(files, (file) => readCommand(sandbox, sessionID, file), { concurrency: 8 }).pipe(
      Effect.map((items) => items.filter((item): item is Definition => item !== undefined)),
    )
    // Names and counts only; template bodies, user arguments, and file contents stay out of logs.
    yield* Effect.logInfo("Sandbox command scan completed", {
      sessionID,
      source: "sandbox" as const,
      discovered: files.length,
      loaded: definitions.length,
      durationMs: Date.now() - startedAt,
    })
    return definitions
  },
)

function readCommand(sandbox: Pick<SandboxProvider.Interface, "fileRead">, sessionID: Session.ID, file: string) {
  return Effect.gen(function* () {
    const relative = file.replace(/^\/workspace\/\.opencode\/(?:command|commands)\//, "").replaceAll("\\", "/")
    const name = relative.replace(/\.md$/i, "")
    if (!validName(name)) return undefined
    const raw = yield* sandbox.fileRead(sessionID, file).pipe(
      Effect.tapError(() => Effect.logWarning("Failed to read sandbox command file", { sessionID, sourcePath: relative })),
      Effect.catch(() => Effect.succeed(null)),
    )
    if (raw === null) return undefined
    const parsed = decodeMarkdown(raw)
    if (!parsed) return undefined
    const decoded = SessionCommand.CreatePayload.make({ name, ...parsed })
    return SessionCommand.Definition.make({
      ...decoded,
      hints: decoded.hints ?? inferHints(decoded.template),
      source: "sandbox",
      sourcePath: relative,
    })
  })
}

export function decodeMarkdown(content: string): Omit<CreateInput, "name"> | undefined {
  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown || !markdown.content.trim()) return undefined
  const command = Option.getOrUndefined(decodeCommand({ ...markdown.data, template: markdown.content.trim() }))
  if (!command) return undefined
  return {
    template: command.template,
    description: command.description,
    agent: command.agent,
    model: command.model,
    subagent: command.subagent ?? command.subtask,
  }
}

export function interpolateArguments(template: string, input: string) {
  const args = (input.match(/(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi) ?? []).map((arg) =>
    arg.replace(/^['"]|['"]$/g, ""),
  )
  const placeholders = template.match(/\$(\d+)/g) ?? []
  const last = Math.max(0, ...placeholders.map((item) => Number(item.slice(1))))
  let text = template.replace(/\$(\d+)/g, (_, raw: string) => {
    const position = Number(raw)
    const index = position - 1
    if (index < 0 || index >= args.length) return ""
    return position === last ? args.slice(index).join(" ") : args[index]!
  })
  const usesArguments = template.includes("$ARGUMENTS")
  text = text.replaceAll("$ARGUMENTS", () => input)
  if (placeholders.length === 0 && !usesArguments && input.trim()) text = `${text}\n\n${input}`
  return text
}

function expandTemplate(template: string, input: string, session: Session.Info, sandbox: Pick<SandboxProvider.Interface, "run">) {
  return Effect.gen(function* () {
    const matches = [...template.matchAll(/!`([^`]+)`/g)]
    if (matches.length === 0) return interpolateArguments(template, input).trim()
    const output: string[] = []
    for (const match of matches) {
      const result = yield* sandbox.run({
        sessionID: session.id,
        command: match[1]!,
        cwd: "/workspace",
        hostWorkdir: session.location.directory,
        timeoutMs: 30_000,
      })
      if (result.exitCode !== 0) return yield* Effect.fail(new Error(`Shell interpolation failed: ${result.output}`))
      output.push(result.output)
    }
    let index = 0
    const expanded = template.replace(/!`([^`]+)`/g, () => output[index++] ?? "")
    return interpolateArguments(expanded, input).trim()
  })
}

function fromRow(row: typeof SessionCommandTable.$inferSelect, source: "session"): Definition {
  return SessionCommand.Definition.make({
    name: row.name,
    description: row.description ?? undefined,
    template: row.template,
    agent: row.agent ?? undefined,
    model: row.model ?? undefined,
    subagent: row.subagent ?? undefined,
    subtask: row.subagent ?? undefined,
    hints: row.hints ?? [],
    source,
  })
}

export function mergeCommands(builtin: Definition[], stored: Definition[], scanned: Definition[]) {
  const result = new Map<string, Definition>()
  for (const item of builtin) result.set(item.name, item)
  for (const item of stored) result.set(item.name, item)
  for (const item of scanned) result.set(item.name, item)
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name))
}
