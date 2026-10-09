import { Session } from "@opencode/core/session"
import { PermissionPreset } from "@opencode/core/permission/preset"
import { Agent } from "@opencode/core/agent"
import { clearProxyTargets } from "./session-proxy.js"
import { SessionCommands } from "@opencode/core/session/commands"
import { SessionAgents } from "@opencode/core/session/agents"
import { SessionSkills } from "@opencode/core/session/skills"
import { SessionMcps } from "@opencode/core/session/mcps"
import { SessionTools } from "@opencode/core/session/tools"
import { SessionAgentsMd } from "@opencode/core/session/agents-md"
import { Log } from "@opencode/core/log"

/** Record one audit entry after a mutating control-plane operation completed. */
const audit = Effect.fn("session.audit")(
  function* (sessionID: Log.RecordInput["sessionID"], source: Log.Source, detail?: Record<string, unknown>) {
    const logs = yield* Log.Service
    yield* logs.record({ sessionID, source, ...(detail === undefined ? {} : { detail }) })
  },
)
import { SandboxProvider } from "@opencode/core/sandbox/provider"
import { SessionStats } from "@opencode/core/session/stats"
import { SessionTitle } from "@opencode/core/session/title"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { Form } from "@opencode/core/form"
import { DateTime, Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Api } from "../api"
import { SessionPromptStreamPayload, SessionsCursor } from "@opencode/protocol/groups/session"
import {
  AgentNotFoundError,
  ConflictError,
  CommandExecutionError,
  CommandNotFoundError,
  FormAlreadySettledError,
  FormInvalidAnswerError,
  FormNotFoundError,
  InvalidRequestError,
  InvalidCursorError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionBusyError,
  SkillNotFoundError,
  UnknownError,
} from "@opencode/protocol/errors"
import { AbsolutePath } from "@opencode/core/schema"
import { failedMessageDecode, failedSnapshot, missingMessage, missingSession } from "./session-error"
import { defaultDirectory } from "../location"
import { Event } from "@opencode/schema/event"
import { EventFeed } from "../event-feed"
import { makePromptStreamTakeUntil, sessionEventFilter } from "../session-stream"

const DefaultSessionsLimit = 50
const validSandboxResource = (value: { cpu: string; memory: string }) =>
  /^\d+(\.\d+)?m?$/.test(value.cpu) && /^\d+(Ki|Mi|Gi|Ti|K|M|G|T)$/.test(value.memory)

/** App-scope PVC sessions share one volume prefix, so the appId must arrive with the mode. */
const validPvcConfig = (pvcMode: string | undefined, appId: string | undefined) =>
  !(pvcMode === "app" && !appId?.trim())

function missingForm(id: Form.ID) {
  return new FormNotFoundError({ id, message: `Form not found: ${id}` })
}

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const transfer = yield* SessionTransfer.Service
    const feed = yield* EventFeed.Service
    const eventResponse = (stream: Stream.Stream<string, EventFeed.Error>) =>
      HttpServerResponse.stream(
        stream.pipe(
          Stream.merge(Stream.tick("15 seconds").pipe(Stream.map(() => ": heartbeat\n\n")), {
            haltStrategy: "left",
          }),
          Stream.encodeText,
        ),
        {
          contentType: "text/event-stream",
          headers: {
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "X-Content-Type-Options": "nosniff",
          },
        },
      )
    const requireOwnedForm = Effect.fnUntraced(function* (sessionID: Form.Info["sessionID"], formID: Form.ID) {
      const form = yield* Form.Service
      const info = yield* form.get(formID).pipe(Effect.catchTag("Form.NotFoundError", () => missingForm(formID)))
      if (info.sessionID !== sessionID) return yield* missingForm(formID)
      return { form, info }
    })
    const busySession = (error: Session.BusyError) =>
      new SessionBusyError({
        sessionID: error.sessionID,
        message: `Session is busy: ${error.sessionID}`,
      })
    const pendingMutation = (effect: ReturnType<typeof session.cancelInbox>, conflict: string) =>
      effect.pipe(
        Effect.catchTag("Session.NotFoundError", missingSession),
        Effect.catchTag(
          "Session.InboxConflictError",
          (error) => new ConflictError({ resource: error.inboxID, message: `${conflict}: ${error.inboxID}` }),
        ),
        Effect.as(HttpApiSchema.NoContent.make()),
      )

    return handlers
      .handle(
        "session.list",
        Effect.fn(function* (ctx) {
          const query =
            ctx.query.cursor !== undefined
              ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                  Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                )
              : ctx.query
          const page = yield* session.list({
            ...query,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
          const sessions = page.data
          const first = sessions[0]
          const last = sessions.at(-1)
          return {
            data: sessions,
            cursor: {
              previous: first
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: first.id,
                      time: DateTime.toEpochMillis(first.time.updated),
                      direction: "previous",
                    },
                  })
                : undefined,
              next: last
                ? SessionsCursor.make({
                    ...query,
                    anchor: {
                      id: last.id,
                      time: DateTime.toEpochMillis(last.time.updated),
                      direction: "next",
                    },
                  })
                : undefined,
            },
          }
        }),
      )
      .handle(
        "session.stats",
        Effect.fn(function* (ctx) {
          const timezone = ctx.query.timezone ?? "UTC"
          yield* Effect.try({
            try: () => new Intl.DateTimeFormat("en-US", { timeZone: timezone }),
            catch: () => new InvalidRequestError({ message: `Invalid time zone: ${timezone}` }),
          })
          return {
            data: yield* SessionStats.get({
              from: ctx.query.from,
              to: ctx.query.to,
              projectID: ctx.query.project,
              timezone,
              tools: ctx.query.tools,
            }).pipe(
              Effect.mapError(() => new InvalidRequestError({ message: "Stats range must end after it starts" })),
            ),
          }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          if (ctx.payload.sandbox && !validSandboxResource(ctx.payload.sandbox))
            return yield* new InvalidRequestError({ message: "Invalid sandbox resource format", field: "sandbox" })
          if (!validPvcConfig(ctx.payload.pvcMode, ctx.payload.appId))
            return yield* new InvalidRequestError({
              message: "appId is required when pvcMode is app",
              field: "appId",
            })
          const createInput = {
            id: ctx.payload.id,
            appId: ctx.payload.appId,
            pvcMode: ctx.payload.pvcMode,
            title: ctx.payload.title,
            agent: ctx.payload.agent,
            model: ctx.payload.model,
            metadata: ctx.payload.metadata,
            permissions: ctx.payload.permissions,
            sandbox: ctx.payload.sandbox,
            summaryFrom: ctx.payload.summaryFrom,
          }
          const created = yield* session
            .create(
              ctx.payload.parentID
                ? { ...createInput, parentID: ctx.payload.parentID }
                : {
                    ...createInput,
                    location: ctx.payload.location ?? { directory: AbsolutePath.make(defaultDirectory()) },
                  },
            )
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: created.id,
            source: "session.create",
            detail: {
              ...(ctx.payload.title === undefined ? {} : { title: ctx.payload.title }),
              ...(ctx.payload.parentID === undefined ? {} : { parentID: ctx.payload.parentID }),
              ...(ctx.payload.agent === undefined ? {} : { agent: ctx.payload.agent }),
              ...(ctx.payload.model === undefined ? {} : { model: ctx.payload.model }),
            },
          })
          return { data: created }
        }),
      )
      .handle(
        "session.import",
        Effect.fn(function* (ctx) {
          const imported = yield* transfer
            .import({
              data: { info: ctx.payload.info, messages: ctx.payload.messages },
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag(
                "SessionTransfer.ImportConflictError",
                (error) =>
                  new ConflictError({
                    message: `Session already exists: ${error.sessionID}`,
                    resource: error.sessionID,
                  }),
              ),
            )
          yield* audit(imported.id, "session.import")
          return { data: imported }
        }),
      )
      .handle(
        "session.export",
        Effect.fn(function* (ctx) {
          return {
            data: yield* transfer
              .export({ sessionID: ctx.params.sessionID, sanitize: ctx.query.sanitize })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
              ),
          }
        }),
      )
      .handle(
        "session.active",
        Effect.fn(function* () {
          const active = yield* session.active
          return {
            data: Object.fromEntries(Array.from(active, (sessionID) => [sessionID, { type: "running" as const }])),
          }
        }),
      )
      .handle(
        "session.get",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .get(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handleRaw("session.event", (ctx) =>
        feed.subscribeFiltered(sessionEventFilter(ctx.params.sessionID)).pipe(
          Effect.map((live) => {
            const connected = EventFeed.frame({
              id: Event.ID.create(),
              type: "server.connected",
              data: {},
            })
            return eventResponse(Stream.make(connected).pipe(Stream.concat(live)))
          }),
        ),
      )
      .handle(
        "session.view",
        Effect.fn(function* (ctx) {
          yield* session
            .view({ sessionID: ctx.params.sessionID, idle: DateTime.toEpochMillis(ctx.payload.idle) })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* audit(ctx.params.sessionID, "session.view")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.remove",
        Effect.fn(function* (ctx) {
          yield* session.remove(ctx.params.sessionID).pipe(
            Effect.catchTag("Session.NotFoundError", missingSession),
            Effect.catchTag("Session.SandboxRetainedError", (error) => Effect.fail(new ConflictError({ message: error.message }))),
          )
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.environment",
        Effect.fn(function* (ctx) {
          yield* session
            .environment({ sessionID: ctx.params.sessionID, variables: ctx.payload.variables })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* audit(ctx.params.sessionID, "session.environment", {
            variables: Object.keys(ctx.payload.variables),
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.fork",
        Effect.fn(function* (ctx) {
          const forked = yield* session.fork({ sessionID: ctx.params.sessionID, before: ctx.payload.before }).pipe(
            Effect.catchTag("Session.NotFoundError", missingSession),
            Effect.catchTag("Session.MessageNotFoundError", missingMessage),
            Effect.catchTag(
              "Session.ForkEmptyError",
              (error) => new InvalidRequestError({ message: error.message, kind: "empty_session" }),
            ),
          )
          yield* audit(forked.id, "session.fork", { from: ctx.params.sessionID })
          return { data: forked }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session
            .switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.agent.select",
            detail: { agent: ctx.payload.agent },
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session
            .switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.model.select",
            detail: { model: ctx.payload.model },
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.update",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          if (ctx.payload.title !== undefined) {
            if (ctx.payload.title) {
              yield* session
                .rename({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
                .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            } else {
              const title = yield* SessionTitle.Service
              yield* title.generate(ctx.params.sessionID)
            }
          }
          if (ctx.payload.permissions !== undefined)
            yield* session
              .setPermissions({ sessionID: ctx.params.sessionID, permissions: ctx.payload.permissions })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          if (ctx.payload.sandbox !== undefined) {
            if (!validSandboxResource(ctx.payload.sandbox))
              return yield* new InvalidRequestError({ message: "Invalid sandbox resource format", field: "sandbox" })
            yield* session
              .setSandboxResource({ sessionID: ctx.params.sessionID, sandbox: ctx.payload.sandbox })
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
            if (ctx.payload.recreate) {
              const provider = yield* SandboxProvider.Service
              yield* provider.destroy(ctx.params.sessionID)
              clearProxyTargets(ctx.params.sessionID)
            }
          }
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.update",
            detail: {
              ...(ctx.payload.title === undefined ? {} : { title: ctx.payload.title }),
              ...(ctx.payload.permissions === undefined ? {} : { permissions: ctx.payload.permissions.length }),
              ...(ctx.payload.sandbox === undefined ? {} : { sandbox: ctx.payload.sandbox }),
            },
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.permissions.preset",
        Effect.fn(function* (ctx) {
          const permissions = PermissionPreset.rules(ctx.payload.preset)
          yield* session
            .setPermissions({ sessionID: ctx.params.sessionID, permissions })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.permissions",
            detail: { preset: ctx.payload.preset },
          })
          return { preset: ctx.payload.preset, permissions }
        }),
      )
      .handle(
        "session.move",
        Effect.fn(function* (ctx) {
          yield* session
            .move({
              sessionID: ctx.params.sessionID,
              directory: ctx.payload.directory,
              delivery: ctx.payload.delivery,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.DestinationNotFoundError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Directory does not exist: ${error.directory}` })),
              ),
              Effect.catchTag("Session.DestinationNotDirectoryError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Not a directory: ${error.directory}` })),
              ),
              Effect.catchTag("Session.DestinationUnavailableError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Directory is unavailable: ${error.directory}` })),
              ),
            )
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.move",
            detail: { directory: ctx.payload.directory, delivery: ctx.payload.delivery },
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          const accepted = yield* session
            .prompt({
              sessionID: ctx.params.sessionID,
              id: ctx.payload.id,
              text: ctx.payload.text,
              files: ctx.payload.files,
              agents: ctx.payload.agents,
              skills: ctx.payload.skills,
              format: ctx.payload.format,
              preset: ctx.payload.preset,
              permissions: ctx.payload.permissions,
              userName: ctx.payload.userName,
              userId: request.headers["x-user-id"] || undefined,
              metadata: ctx.payload.metadata,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
              model: ctx.payload.model,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.PromptConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                    resource: error.messageID,
                  }),
                ),
              ),
              Effect.catchTag("Session.AttachmentError", (error) =>
                Effect.fail(new InvalidRequestError({ message: error.message, field: "files" })),
              ),
              Effect.catchTag("Session.SkillNotFoundError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Skill not found: ${error.skill}`, field: "skills" })),
              ),
            )
          yield* audit(ctx.params.sessionID, "session.prompt", {
            delivery: ctx.payload.delivery,
            ...(ctx.payload.agents === undefined ? {} : { agents: ctx.payload.agents }),
            ...(ctx.payload.model === undefined ? {} : { model: ctx.payload.model }),
            ...(ctx.payload.preset === undefined ? {} : { preset: ctx.payload.preset }),
          })
          return { data: accepted }
        }),
      )
      .handleRaw("session.promptStream", (ctx) =>
        Effect.gen(function* () {
          const payload = yield* HttpServerRequest.schemaBodyJson(SessionPromptStreamPayload).pipe(
            Effect.mapError(() => new InvalidRequestError({ message: "Invalid prompt payload" })),
          )
          const request = yield* HttpServerRequest.HttpServerRequest
          // Subscribe first so fast executions cannot finish before the stream starts observing events.
          const live = yield* feed.subscribeFiltered(sessionEventFilter(ctx.params.sessionID))
          const accepted = yield* session
            .prompt({
              sessionID: ctx.params.sessionID,
              id: payload.id,
              text: payload.text,
              files: payload.files,
              agents: payload.agents,
              skills: payload.skills,
              preset: payload.preset,
              permissions: payload.permissions,
              userName: payload.userName,
              userId: request.headers["x-user-id"] || undefined,
              metadata: payload.metadata,
              delivery: payload.delivery,
              resume: payload.resume,
              format: payload.format,
              model: payload.model,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.PromptConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                    resource: error.messageID,
                  }),
                ),
              ),
              Effect.catchTag("Session.AttachmentError", (error) =>
                Effect.fail(new InvalidRequestError({ message: error.message, field: "files" })),
              ),
              Effect.catchTag("Session.SkillNotFoundError", (error) =>
                Effect.fail(new InvalidRequestError({ message: `Skill not found: ${error.skill}`, field: "skills" })),
              ),
            )

          const followed = live.pipe(Stream.takeUntil(makePromptStreamTakeUntil(accepted.id)))
          yield* audit(ctx.params.sessionID, "session.prompt", {
            stream: true,
            delivery: payload.delivery,
            ...(payload.agents === undefined ? {} : { agents: payload.agents }),
            ...(payload.model === undefined ? {} : { model: payload.model }),
            ...(payload.preset === undefined ? {} : { preset: payload.preset }),
          })
          const connected = EventFeed.frame({
            id: Event.ID.create(),
            type: "server.connected",
            data: {},
          })
          return eventResponse(Stream.make(connected).pipe(Stream.concat(followed)))
        }),
      )
      .handle(
        "session.command",
        Effect.fn(function* (ctx) {
          yield* session
            .command({
              sessionID: ctx.params.sessionID,
              command: ctx.payload.name,
              text: ctx.payload.text,
              files: ctx.payload.files,
              agents: ctx.payload.agents,
              skills: ctx.payload.skills,
              delivery: ctx.payload.delivery,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Command.NotFoundError", (error) =>
                Effect.fail(
                  new CommandNotFoundError({
                    command: error.command,
                    message: error.message,
                  }),
                ),
              ),
              Effect.catchTag("Command.ExecutionError", (error) =>
                Effect.fail(
                  new CommandExecutionError({
                    command: error.command,
                    message: error.message,
                  }),
                ),
              ),
            )
          yield* audit(ctx.params.sessionID, "session.command", {
            name: ctx.payload.name,
            ...(ctx.payload.agents === undefined ? {} : { agents: ctx.payload.agents }),
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.commandDefinitions.list",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return {
            data: yield* SessionCommands.list(info).pipe(
              Effect.mapError((error) => new UnknownError({ message: error.message })),
            ),
          }
        }),
      )
      .handle(
        "session.commandDefinitions.create",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const name = ctx.payload.name.trim()
          if (!SessionCommands.validName(name))
            return yield* Effect.fail(new InvalidRequestError({ field: "name", message: "Invalid command name" }))
          const created = yield* SessionCommands.create(info.id, { ...ctx.payload, name })
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: info.id,
            source: "session.commandDefinition.create",
            detail: { name },
          })
          return created
        }),
      )
      .handle(
        "session.commandDefinitions.delete",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* SessionCommands.remove(ctx.params.sessionID, ctx.params.name)
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.commandDefinition.delete",
            detail: { name: ctx.params.name },
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.commandDefinitions.clear",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* SessionCommands.clear(ctx.params.sessionID)
          const logs = yield* Log.Service
          yield* logs.record({ sessionID: ctx.params.sessionID, source: "session.commandDefinition.clear" })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.commandDefinitions.refresh",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return {
            data: yield* SessionCommands.refresh(info).pipe(
              Effect.mapError((error) => new UnknownError({ message: error.message })),
            ),
          }
        }),
      )
      .handle(
        "session.agentDefinitions.list",
        Effect.fn(function* (ctx) {
          const agents = yield* SessionAgents.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // `list` degrades on sandbox scan failure; `refresh` is the explicit scan that reports it.
          return { data: yield* agents.list(info) }
        }),
      )
      .handle(
        "session.agentDefinitions.create",
        Effect.fn(function* (ctx) {
          const agents = yield* SessionAgents.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          if (!SessionAgents.validName(ctx.payload.id))
            return yield* Effect.fail(new InvalidRequestError({ field: "id", message: "Invalid agent ID" }))
          const created = yield* agents.create(info.id, ctx.payload)
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: info.id,
            source: "session.agentDefinition.create",
            detail: { id: ctx.payload.id },
          })
          return created
        }),
      )
      .handle(
        "session.agentDefinitions.permissionPreset",
        Effect.fn(function* (ctx) {
          const agents = yield* SessionAgents.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const id = Agent.ID.make(ctx.params.agentID)
          if (!SessionAgents.validName(id))
            return yield* Effect.fail(new InvalidRequestError({ field: "agentID", message: "Invalid agent ID" }))
          const existing = yield* agents.get(info, id)
          if (!existing)
            return yield* Effect.fail(
              new AgentNotFoundError({ agentID: id, message: `Agent not found: ${id}` }),
            )
          yield* agents.setPermissions(info.id, id, PermissionPreset.rules(ctx.payload.preset))
          const updated = yield* agents.get(info, id)
          if (!updated)
            return yield* Effect.fail(
              new AgentNotFoundError({ agentID: id, message: `Agent not found: ${id}` }),
            )
          yield* audit(info.id, "session.agentDefinition.permissionPreset", {
            agentID: id,
            preset: ctx.payload.preset,
          })
          return { preset: ctx.payload.preset, agent: updated }
        }),
      )
      .handle(
        "session.agentDefinitions.delete",
        Effect.fn(function* (ctx) {
          const agents = yield* SessionAgents.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* agents.remove(ctx.params.sessionID, ctx.params.agentID)
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.agentDefinition.delete",
            detail: { agentID: ctx.params.agentID },
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.agentDefinitions.clear",
        Effect.fn(function* (ctx) {
          const agents = yield* SessionAgents.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* agents.clear(ctx.params.sessionID)
          const logs = yield* Log.Service
          yield* logs.record({ sessionID: ctx.params.sessionID, source: "session.agentDefinition.clear" })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.agentDefinitions.refresh",
        Effect.fn(function* (ctx) {
          const agents = yield* SessionAgents.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return {
            data: yield* agents
              .refresh(info)
              .pipe(Effect.mapError((error) => new UnknownError({ message: error.message }))),
          }
        }),
      )
      .handle(
        "session.skill",
        Effect.fn(function* (ctx) {
          yield* session
            .skill({
              sessionID: ctx.params.sessionID,
              skill: ctx.payload.id,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.SkillNotFoundError", (error) =>
                Effect.fail(new SkillNotFoundError({ skill: error.skill, message: `Skill not found: ${error.skill}` })),
              ),
            )
          yield* audit(ctx.params.sessionID, "session.skill", { skill: ctx.payload.id })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.synthetic",
        Effect.fn(function* (ctx) {
          const data = yield* session
            .synthetic({
              id: ctx.payload.id,
              sessionID: ctx.params.sessionID,
              text: ctx.payload.text,
              description: ctx.payload.description,
              metadata: ctx.payload.metadata,
              delivery: ctx.payload.delivery,
              resume: ctx.payload.resume,
            })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.SyntheticConflictError", (error) =>
                Effect.fail(
                  new ConflictError({
                    message: `Synthetic input ID conflicts with an existing durable record: ${error.inputID}`,
                    resource: error.inputID,
                  }),
                ),
              ),
            )
          yield* audit(ctx.params.sessionID, "session.synthetic", {
            ...(ctx.payload.description === undefined ? {} : { description: ctx.payload.description }),
            delivery: ctx.payload.delivery,
          })
          return { data }
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* session
            .shell({
              sessionID: ctx.params.sessionID,
              id: ctx.payload.id,
              command: ctx.payload.command,
              timeoutSeconds: ctx.payload.timeoutSeconds,
            })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* audit(ctx.params.sessionID, "session.shell", {
            command: ctx.payload.command,
            ...(ctx.payload.timeoutSeconds === undefined ? {} : { timeoutSeconds: ctx.payload.timeoutSeconds }),
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.keepAlive",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const provider = yield* SandboxProvider.Service
          const enabled = ctx.payload.enabled !== false
          if (enabled) yield* provider.keepAlive(ctx.params.sessionID)
          else {
            yield* provider.release(ctx.params.sessionID)
          }
          const sandboxId =
            enabled && ctx.payload.boot === true && provider.enabled
              ? yield* provider.boot(ctx.params.sessionID).pipe(Effect.catch(() => Effect.succeed(null)))
              : null
          yield* audit(ctx.params.sessionID, "session.keepAlive", { enabled })
          return { sessionID: ctx.params.sessionID, keepAlive: enabled, sandboxId }
        }),
      )
      .handle(
        "session.keepAliveStatus",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const provider = yield* SandboxProvider.Service
          return { sessionID: ctx.params.sessionID, keepAlive: yield* provider.isKeepAlive(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.sandbox",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const provider = yield* SandboxProvider.Service
          return { sessionID: ctx.params.sessionID, sandboxId: yield* provider.sandboxId(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.killSandbox",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const provider = yield* SandboxProvider.Service
          const existing = yield* provider.lifecycle(ctx.params.sessionID)
          if (existing.state && existing.state !== "destroyed" && provider.enabled) yield* provider.destroy(ctx.params.sessionID)
          const remaining = yield* provider.lifecycle(ctx.params.sessionID)
          const destroyed = existing.state !== null && existing.state !== "destroyed" && remaining.state === "destroyed"
          if (destroyed) clearProxyTargets(ctx.params.sessionID)
          yield* audit(ctx.params.sessionID, "session.killSandbox", { destroyed })
          return { sessionID: ctx.params.sessionID, destroyed }
        }),
      )
      .handle(
        "session.snapshot.create",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const provider = yield* SandboxProvider.Service
          const snapshot = yield* provider.snapshot(ctx.params.sessionID).pipe(
            Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: "snapshot" })),
          )
          yield* audit(ctx.params.sessionID, "session.snapshot.create", { snapshotID: snapshot.snapshotID })
          return { data: snapshot }
        }),
      )
      .handle(
        "session.snapshot.get",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const provider = yield* SandboxProvider.Service
          return {
            data: yield* provider.latestSnapshot(ctx.params.sessionID).pipe(
              Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: "snapshot" })),
            ),
          }
        }),
      )
      .handle(
        "session.snapshot.stats",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const provider = yield* SandboxProvider.Service
          return {
            data: yield* provider.snapshotStats(ctx.params.sessionID).pipe(
              Effect.mapError((error) => new InvalidRequestError({ message: error.message, kind: "snapshot" })),
            ),
          }
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          const compacted = yield* session
            .compact({ sessionID: ctx.params.sessionID, id: ctx.payload.id, delivery: ctx.payload.delivery })
            .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.CompactionConflictError", (error) =>
                  Effect.fail(
                    new ConflictError({
                      message: `Compaction input ID conflicts with an existing durable record: ${error.inputID}`,
                      resource: error.inputID,
                    }),
                  ),
                ),
              )
          yield* audit(ctx.params.sessionID, "session.compact")
          return { data: compacted }
        }),
      )
      .handle(
        "session.wait",
        Effect.fn(function* (ctx) {
          yield* session.wait(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.stage",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.stage", {
            sessionID: ctx.params.sessionID,
            messageID: ctx.payload.messageID,
            files: ctx.payload.files,
          })
          const staged = yield* session.revert
            .stage({ ...ctx.params, ...ctx.payload })
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              Effect.catchTag("Session.BusyError", busySession),
              Effect.catchTag("Snapshot.Error", failedSnapshot("stage session revert", ctx.params.sessionID)),
            )
          yield* audit(ctx.params.sessionID, "session.revert.stage", {
            ...(ctx.payload.messageID === undefined ? {} : { messageID: ctx.payload.messageID }),
          })
          return { data: staged }
        }),
      )
      .handle(
        "session.revert.clear",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.clear", { sessionID: ctx.params.sessionID })
          yield* session.revert
            .clear(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.BusyError", busySession),
              Effect.catchTag("Snapshot.Error", failedSnapshot("clear session revert", ctx.params.sessionID)),
            )
          yield* audit(ctx.params.sessionID, "session.revert.clear")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.revert.commit",
        Effect.fn(function* (ctx) {
          yield* Effect.log("session.revert.commit", { sessionID: ctx.params.sessionID })
          yield* session.revert
            .commit(ctx.params.sessionID)
            .pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.BusyError", busySession),
            )
          yield* audit(ctx.params.sessionID, "session.revert.commit")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.context",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .context(ctx.params.sessionID)
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.MessageDecodeError", failedMessageDecode),
              ),
          }
        }),
      )
      .handle(
        "session.diff",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.diff({ sessionID: ctx.params.sessionID, ...ctx.query }).pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              Effect.catchTag(
                "Session.TurnRangeError",
                (error) => new InvalidRequestError({ message: error.message, field: error.field }),
              ),
              Effect.catchTag("Snapshot.Error", failedSnapshot("diff session turn", ctx.params.sessionID)),
            ),
          }
        }),
      )
      .handle(
        "session.inbox.list",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
              .inbox(ctx.params.sessionID)
              .pipe(Effect.catchTag("Session.NotFoundError", missingSession)),
          }
        }),
      )
      .handle(
        "session.inbox.cancel",
        Effect.fn(function* (ctx) {
          yield* session.cancelInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID }).pipe(
            Effect.catchTag("Session.NotFoundError", missingSession),
            Effect.catchTag("Session.InboxConflictError", () => Effect.void),
          )
          yield* audit(ctx.params.sessionID, "session.inbox.cancel", { inboxID: ctx.params.inboxID })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.inbox.update",
        Effect.fn(function* (ctx) {
          const result = yield* pendingMutation(
            ctx.payload.delivery === "steer"
              ? session.steerInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID })
              : session.queueInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID }),
            `Pending input cannot change to ${ctx.payload.delivery}`,
          )
          yield* audit(ctx.params.sessionID, "session.inbox.update", {
            inboxID: ctx.params.inboxID,
            delivery: ctx.payload.delivery,
          })
          return result
        }),
      )
      .handle(
        "session.skillDefinitions.list",
        Effect.fn(function* (ctx) {
          const skills = yield* SessionSkills.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return { data: yield* skills.list(info) }
        }),
      )
      .handle(
        "session.mcpDefinitions.list",
        Effect.fn(function* (ctx) {
          const mcps = yield* SessionMcps.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return { data: yield* mcps.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.mcpDefinitions.create",
        Effect.fn(function* (ctx) {
          const mcps = yield* SessionMcps.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const created = yield* mcps.create(ctx.params.sessionID, ctx.payload)
          yield* audit(ctx.params.sessionID, "session.mcpDefinition.create", { name: ctx.payload.name })
          return created
        }),
      )
      .handle(
        "session.mcpDefinitions.delete",
        Effect.fn(function* (ctx) {
          const mcps = yield* SessionMcps.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* mcps.remove(info, ctx.params.name)
          yield* audit(ctx.params.sessionID, "session.mcpDefinition.delete", { name: ctx.params.name })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.mcpDefinitions.clear",
        Effect.fn(function* (ctx) {
          const mcps = yield* SessionMcps.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* mcps.clear(info)
          yield* audit(ctx.params.sessionID, "session.mcpDefinition.clear")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.toolDefinitions.list",
        Effect.fn(function* (ctx) {
          const tools = yield* SessionTools.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return { data: yield* tools.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.toolDefinitions.create",
        Effect.fn(function* (ctx) {
          const tools = yield* SessionTools.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const created = yield* tools.create(ctx.params.sessionID, ctx.payload)
          yield* audit(ctx.params.sessionID, "session.toolDefinition.create", { name: ctx.payload.name })
          return created
        }),
      )
      .handle(
        "session.toolDefinitions.delete",
        Effect.fn(function* (ctx) {
          const tools = yield* SessionTools.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* tools.remove(ctx.params.sessionID, ctx.params.name)
          yield* audit(ctx.params.sessionID, "session.toolDefinition.delete", { name: ctx.params.name })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.toolDefinitions.clear",
        Effect.fn(function* (ctx) {
          const tools = yield* SessionTools.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* tools.clear(ctx.params.sessionID)
          yield* audit(ctx.params.sessionID, "session.toolDefinition.clear")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.skillDefinitions.create",
        Effect.fn(function* (ctx) {
          const skills = yield* SessionSkills.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const created = yield* skills.create(ctx.params.sessionID, ctx.payload)
          yield* audit(ctx.params.sessionID, "session.skillDefinition.create", { skill: ctx.payload.id })
          return created
        }),
      )
      .handle(
        "session.skillDefinitions.delete",
        Effect.fn(function* (ctx) {
          const skills = yield* SessionSkills.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* skills.remove(ctx.params.sessionID, ctx.params.skillID)
          yield* audit(ctx.params.sessionID, "session.skillDefinition.delete", { skillID: ctx.params.skillID })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.skillDefinitions.clear",
        Effect.fn(function* (ctx) {
          const skills = yield* SessionSkills.Service
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* skills.clear(ctx.params.sessionID)
          yield* audit(ctx.params.sessionID, "session.skillDefinition.clear")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.skillDefinitions.refresh",
        Effect.fn(function* (ctx) {
          const skills = yield* SessionSkills.Service
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return {
            data: yield* skills
              .refresh(info)
              .pipe(Effect.mapError((error) => new UnknownError({ message: error.message }))),
          }
        }),
      )
      .handle(
        "session.logs",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const logs = yield* Log.Service
          return {
            data: yield* logs.list({ sessionID: ctx.params.sessionID, limit: ctx.query.limit, after: ctx.query.after }),
          }
        }),
      )
      .handle(
        "session.agentsMd.get",
        Effect.fn(function* (ctx) {
          const agentsMd = yield* SessionAgentsMd.Service
          return { data: yield* agentsMd.get(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.agentsMd.put",
        Effect.fn(function* (ctx) {
          const agentsMd = yield* SessionAgentsMd.Service
          const updated = yield* agentsMd.put(ctx.params.sessionID, ctx.payload.content)
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.agentsMd.update",
            detail: { bytes: Buffer.byteLength(ctx.payload.content, "utf8") },
          })
          return { data: updated }
        }),
      )
      .handle(
        "session.agentsMd.remove",
        Effect.fn(function* (ctx) {
          const agentsMd = yield* SessionAgentsMd.Service
          yield* agentsMd.remove(ctx.params.sessionID)
          const logs = yield* Log.Service
          yield* logs.record({ sessionID: ctx.params.sessionID, source: "session.agentsMd.remove" })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.instructions.entry.list",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          return { data: yield* instructions.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.instructions.entry.put",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          yield* instructions.put({ sessionID: ctx.params.sessionID, key: ctx.params.key, value: ctx.payload.value })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.instructions.entry.remove",
        Effect.fn(function* (ctx) {
          const instructions = yield* InstructionEntry.Service
          yield* instructions.remove({ sessionID: ctx.params.sessionID, key: ctx.params.key })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.generate",
        Effect.fn(function* (ctx) {
          const text = yield* session
            .generate({ sessionID: ctx.params.sessionID, prompt: ctx.payload.prompt })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "Session.NotFoundError"
                  ? missingSession(error)
                  : new ServiceUnavailableError({ message: error.message, service: "session generation" }),
              ),
            )
          return { data: { text } }
        }),
      )
      .handle(
        "session.log",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return session
            .log({ sessionID: ctx.params.sessionID, after: ctx.query.after, follow: ctx.query.follow })
            .pipe(Stream.orDie)
        }),
      )
      .handle(
        "session.interrupt",
        Effect.fn(function* (ctx) {
          const interrupted = yield* session.interrupt(ctx.params.sessionID, { resume: ctx.query.resume })
          const logs = yield* Log.Service
          yield* logs.record({
            sessionID: ctx.params.sessionID,
            source: "session.interrupt",
            detail: { interrupted, ...(ctx.query.resume === undefined ? {} : { resume: ctx.query.resume }) },
          })
          return { interrupted }
        }),
      )
      .handle(
        "session.background",
        Effect.fn(function* (ctx) {
          yield* session.background(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          yield* audit(ctx.params.sessionID, "session.background")
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.message",
        Effect.fn(function* (ctx) {
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const message = yield* session.message(ctx.params)
          if (message) return { data: message }
          return yield* new MessageNotFoundError({
            sessionID: ctx.params.sessionID,
            messageID: ctx.params.messageID,
            message: `Message not found: ${ctx.params.messageID}`,
          })
        }),
      )
      .handle(
        "session.form.list",
        Effect.fn(function* (ctx) {
          const form = yield* Form.Service
          return { data: yield* form.list({ sessionID: ctx.params.sessionID }) }
        }),
      )
      .handle(
        "session.form.create",
        Effect.fn(function* (ctx) {
          const form = yield* Form.Service
          const created = yield* form
            .create({
              id: ctx.payload.id,
              sessionID: ctx.params.sessionID,
              title: ctx.payload.title,
              metadata: ctx.payload.metadata,
              fields: ctx.payload.fields,
            })
            .pipe(
              Effect.catchTags({
                "Form.AlreadyExistsError": (error) => new ConflictError({ resource: error.id, message: error.message }),
                "Form.InvalidFormError": (error) =>
                  new InvalidRequestError({ message: error.message, field: "fields" }),
              }),
            )
          return { data: created }
        }),
      )
      .handle(
        "session.form.get",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          const state = yield* owned.form
            .state(ctx.params.formID)
            .pipe(Effect.catchTag("Form.NotFoundError", () => missingForm(ctx.params.formID)))
          return { data: { ...owned.info, state } }
        }),
      )
      .handle(
        "session.form.reply",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          yield* owned.form.reply({ id: ctx.params.formID, answer: ctx.payload.answer }).pipe(
            Effect.catchTags({
              "Form.AlreadySettledError": (error) =>
                new FormAlreadySettledError({ id: error.id, message: error.message }),
              "Form.InvalidAnswerError": (error) =>
                new FormInvalidAnswerError({ id: error.id, message: error.message }),
              "Form.NotFoundError": () => missingForm(ctx.params.formID),
            }),
          )
          yield* audit(Session.ID.make(ctx.params.sessionID), "session.form.reply", {
            formID: ctx.params.formID,
            keys: Object.keys(ctx.payload.answer ?? {}),
          })
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.form.cancel",
        Effect.fn(function* (ctx) {
          const owned = yield* requireOwnedForm(ctx.params.sessionID, ctx.params.formID)
          yield* owned.form.cancel(ctx.params.formID).pipe(
            Effect.catchTags({
              "Form.AlreadySettledError": (error) =>
                new FormAlreadySettledError({ id: error.id, message: error.message }),
              "Form.NotFoundError": () => missingForm(ctx.params.formID),
            }),
          )
          yield* audit(Session.ID.make(ctx.params.sessionID), "session.form.cancel", { formID: ctx.params.formID })
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
