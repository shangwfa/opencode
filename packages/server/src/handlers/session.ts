import { Session } from "@opencode/core/session"
import { SessionExecution } from "@opencode/core/session/execution"
import { SessionStats } from "@opencode/core/session/stats"
import { SessionExecAsync } from "@opencode/core/session/exec-async"
import { SessionTitle } from "@opencode/core/session/title"
import { SessionTransfer } from "@opencode/core/session/transfer"
import { InstructionEntry } from "@opencode/core/session/instruction-entry"
import { Form } from "@opencode/core/form"
import { Permission } from "@opencode/core/permission"
import { Hitl } from "@opencode/core/hitl/index"
import { DateTime, Effect, Exit, Queue, Stream } from "effect"
import { Option } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { Bus } from "@opencode/core/bus"
import { Event } from "@opencode/schema/event"
import { Command } from "@opencode/schema/command"
import { SessionsCursor } from "@opencode/protocol/groups/session"

import {
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
} from "@opencode/protocol/errors"
import { AbsolutePath } from "@opencode/core/schema"
import { SandboxOpenSandbox } from "@opencode/sandbox/opensandbox"
import { SandboxResource } from "@opencode/schema/sandbox-resource"
import { Workspace } from "@opencode/core/workspace"
import { ChildProcess } from "effect/unstable/process"
import { Location } from "@opencode/core/location"
import { failedMessageDecode, failedSnapshot, missingMessage, missingSession } from "./session-error"
import { requestUserID, requestUserName } from "../location"
import { HttpServerRequest } from "effect/unstable/http"

const DefaultSessionsLimit = 50

function missingForm(id: Form.ID) {
  return new FormNotFoundError({ id, message: `Form not found: ${id}` })
}

function eventSessionID(event: Event.Payload): string | undefined {
  const data = event.data as { readonly sessionID?: unknown } | undefined
  return typeof data?.sessionID === "string" ? data.sessionID : undefined
}

/** A turn settles at a terminal execution state (v2 streams no `session.idle` for a normal run). */
function isTurnEnd(event: Event.Payload): boolean {
  if (event.type === "session.idle") return true
  if (event.type === "session.status") {
    const status = (event.data as { readonly status?: { readonly type?: string } }).status
    return status?.type === "idle"
  }
  return (
    event.type === "session.execution.succeeded" ||
    event.type === "session.execution.failed" ||
    event.type === "session.execution.interrupted"
  )
}

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const transfer = yield* SessionTransfer.Service
    const workspace = yield* Workspace.Service
    const execution = yield* SessionExecution.Service
    // Optional: the test fixture's minimal graph does not carry the async
    // exec service; real deployments always do.
    const execAsyncOption = yield* Effect.serviceOption(SessionExecAsync.Service)
    const bus = yield* Bus.Service
    const requireOwnedForm = Effect.fnUntraced(function* (sessionID: Form.Info["sessionID"], formID: Form.ID) {
      const forms = yield* Form.Service
      const info = yield* forms.get(formID).pipe(Effect.catchTag("Form.NotFoundError", () => missingForm(formID)))
      if (info.sessionID !== sessionID) return yield* missingForm(formID)
      return { form: forms, info }
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
        "session.status",
        Effect.fn(function* () {
          const active = yield* execution.active
          return { data: { active: [...active] } }
        }),
      )
      .handle(
        "session.exec",
        Effect.fn(function* (ctx) {
          // v1 parity: run the command inside the session's sandbox workspace
          // (provisioned on demand by workspace.connect). The workspaceID comes
          // from the session's location.
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          if (workspaceID === undefined) {
            return { exitCode: -1, stdout: "", stderr: "session has no sandbox workspace" }
          }
          const cwd = ctx.payload.workingDirectory ?? info.location.directory
          // v1 falsy semantics: 0 (and undefined) mean "no timeout".
          const timeoutMs = ctx.payload.timeoutSeconds ? ctx.payload.timeoutSeconds * 1000 : undefined
          const runOnce = Effect.fn("session.exec.once")(function* () {
            const driver = yield* workspace.connect(workspaceID)
            // The payload is a full shell string (v1 parity): pipes,
            // substitutions, quoting. Route it through sh -c so the argv
            // quoting in the sandbox adapter preserves shell semantics.
            const shell = yield* driver.spawner.spawn(ChildProcess.make("sh", ["-c", ctx.payload.command], { cwd }))
            const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
              Stream.decodeText(stream).pipe(
                Stream.runCollect,
                Effect.map((chunks) => Array.from(chunks).join("")),
                Effect.orDie,
              )
            const wait = Effect.all([shell.exitCode, collect(shell.stdout), collect(shell.stderr)] as const)
            const settled: Option.Option<readonly [number, string, string]> =
              timeoutMs === undefined
                ? yield* Effect.map(wait, Option.some)
                : yield* Effect.timeoutOption(wait, `${timeoutMs} millis`)
            if (Option.isNone(settled)) {
              yield* Effect.ignore(shell.kill())
              return [-1, "", `exec timed out after ${ctx.payload.timeoutSeconds}s`] as const
            }
            return settled.value
          })
          let output = yield* Effect.scoped(runOnce()).pipe(Effect.orDie)
          // Transport failure (-1 with no command output): the sandbox likely
          // died underneath the cached connection. Drop it and retry once on a
          // fresh connection (connect revives from snapshot or cold start).
          if (Number(output[0]) === -1 && output[1] === "" && !String(output[2]).startsWith("exec timed out")) {
            yield* workspace.invalidate(workspaceID)
            output = yield* Effect.scoped(runOnce()).pipe(Effect.orDie)
          }
          // v1 parity: decode exit >= 128 to a signal name and flag likely OOM (SIGKILL).
          const exitCode = Number(output[0])
          const signal = SandboxResource.exitSignal(exitCode)
          return {
            exitCode,
            stdout: output[1],
            stderr: output[2],
            ...(signal === undefined ? {} : { signal, oomSuspected: signal === "SIGKILL" }),
          }
        }),
      )
      .handle(
        "session.snapshot",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          if (workspaceID === undefined)
            return yield* new ServiceUnavailableError({ message: "session has no sandbox workspace", service: "sandbox" })
          const result = yield* workspace.snapshot(workspaceID).pipe(Effect.exit)
          if (Exit.isSuccess(result)) return { snapshotId: result.value.snapshotId }
          return yield* new ServiceUnavailableError({
            message: "snapshot failed or not supported",
            service: "sandbox",
          })
        }),
      )
      .handle(
        "session.killSandbox",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          if (workspaceID === undefined) return { workspaceID: undefined, destroyed: false }
          // v1 parity for persistent sessions: snapshot first (Ready before the
          // kill), keep the workspace row so the next use restores from the
          // snapshot. Falls back to a plain destroy when nothing is bound.
          const suspended = yield* workspace.suspend(workspaceID).pipe(Effect.exit)
          if (Exit.isSuccess(suspended)) return { workspaceID, destroyed: true }
          const result = yield* workspace.destroy(workspaceID).pipe(Effect.orDie)
          if (result.destroyed) {
            // kill the *container*, keep the logical record so the session's
            // workspaceID stays valid; the next exec/tool provisions a fresh
            // sandbox (destroy removes the row, so re-commit it).
            yield* workspace.create({ id: workspaceID, provider: SandboxOpenSandbox.PROVIDER }).pipe(Effect.orDie)
          }
          return { workspaceID, destroyed: result.destroyed }
        }),
      )
      .handle(
        "session.execAsync",
        Effect.fn(function* (ctx) {
          if (Option.isNone(execAsyncOption))
            return yield* new ServiceUnavailableError({ message: "exec async unavailable", service: "sandbox" })
          const execAsync = execAsyncOption.value
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          if (workspaceID === undefined)
            return yield* new ServiceUnavailableError({
              message: "session has no sandbox workspace",
              service: "sandbox",
            })
          const { execId } = yield* execAsync.start({
            sessionID: ctx.params.sessionID,
            workspaceID,
            command: ctx.payload.command,
            workingDirectory: ctx.payload.workingDirectory ?? info.location.directory,
            timeoutMs: ctx.payload.timeoutSeconds ? ctx.payload.timeoutSeconds * 1000 : undefined,
          })
          return { execId, status: "running" as const }
        }),
      )
      .handle(
        "session.execs",
        Effect.fn(function* (ctx) {
          if (Option.isNone(execAsyncOption))
            return yield* new ServiceUnavailableError({ message: "exec async unavailable", service: "sandbox" })
          const execAsync = execAsyncOption.value
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return { execs: yield* execAsync.list(ctx.params.sessionID) }
        }),
      )
      .handle(
        "session.execStatus",
        Effect.fn(function* (ctx) {
          if (Option.isNone(execAsyncOption))
            return yield* new ServiceUnavailableError({ message: "exec async unavailable", service: "sandbox" })
          const execAsync = execAsyncOption.value
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const snapshot = execAsync.get(ctx.params.execID)
          if (snapshot === undefined)
            return yield* new InvalidRequestError({ message: `exec not found: ${ctx.params.execID}` })
          return snapshot
        }),
      )
      .handle(
        "session.execKill",
        Effect.fn(function* (ctx) {
          if (Option.isNone(execAsyncOption))
            return yield* new ServiceUnavailableError({ message: "exec async unavailable", service: "sandbox" })
          const execAsync = execAsyncOption.value
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const killed = yield* execAsync.kill(ctx.params.execID)
          return { killed }
        }),
      )
      .handle(
        "session.execStream",
        Effect.fn(function* (ctx) {
          if (Option.isNone(execAsyncOption))
            return yield* new ServiceUnavailableError({ message: "exec async unavailable", service: "sandbox" })
          const execAsync = execAsyncOption.value
          yield* session.get(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const events = execAsync.events(ctx.params.execID)
          if (events === undefined)
            return yield* new InvalidRequestError({ message: `exec not found: ${ctx.params.execID}` })
          return events
        }),
      )
      .handle(
        "session.keepAlive",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          if (ctx.payload.enabled && workspaceID === undefined)
            return yield* new InvalidRequestError({ message: "session has no sandbox workspace" })
          if (workspaceID === undefined) return { keepAlive: false }
          yield* workspace.setKeepAlive(workspaceID, ctx.payload.enabled)
          // connect is per-operation lazy; boot must provision eagerly so the
          // binding (sandbox) exists when the response returns.
          if (ctx.payload.boot) yield* workspace.provision(workspaceID).pipe(Effect.orDie)
          return { keepAlive: ctx.payload.enabled, workspaceID }
        }),
      )
      .handle(
        "session.keepAliveGet",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          return { keepAlive: workspaceID === undefined ? false : workspace.isKeepAlive(workspaceID) }
        }),
      )
      .handle(
        "session.sandbox",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return { workspaceID: info.location.workspaceID }
        }),
      )
      .handle(
        "session.create",
        Effect.fn(function* (ctx) {
          const location = ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) }
          const created = yield* session
            .create({
              id: ctx.payload.id,
              title: ctx.payload.title,
              appId: ctx.payload.appId,
              summaryFrom: ctx.payload.summaryFrom,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              metadata: ctx.payload.metadata,
              permissions: ctx.payload.permissions,
              sandbox: ctx.payload.sandbox,
                // Sandbox wiring (SaaS): bind every session to its own
                // OpenSandbox workspace unless the caller pinned one. The
                // workspace is only a logical commit here; the sandbox is
                // provisioned lazily on first tool execution (v1 parity).
                location: yield* bindSandboxWorkspace(location, workspace, ctx.payload.sandbox),
              })
              .pipe(Effect.orDie)
          // v1 parity: enrich the response with the stored sandbox resource.
          const workspaceID = created.location.workspaceID
          const resource = workspaceID === undefined ? null : yield* workspace.resource(workspaceID).pipe(Effect.orElseSucceed(() => null))
          return { data: { ...created, sandbox: resource === null ? undefined : { cpu: resource.cpu, memory: resource.memory } } }
        }),
      )
      .handle(
        "session.import",
        Effect.fn(function* (ctx) {
          return {
            data: yield* transfer
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
              ),
          }
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
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          const resource = workspaceID === undefined ? null : yield* workspace.resource(workspaceID).pipe(Effect.orElseSucceed(() => null))
          return {
            data: { ...info, sandbox: resource === null ? undefined : { cpu: resource.cpu, memory: resource.memory } },
          }
        }),
      )
      .handle(
        "session.view",
        Effect.fn(function* (ctx) {
          yield* session
            .view({ sessionID: ctx.params.sessionID, idle: DateTime.toEpochMillis(ctx.payload.idle) })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.remove",
        Effect.fn(function* (ctx) {
          // SaaS: destroying the session also destroys its sandbox workspace
          // (v1's remove -> cancel + destroy linkage). Capture the location
          // first; remove invalidates the row.
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // SaaS: sweep pending HITL asks before the session row goes away —
          // in-memory pendings are settled with a terminal decision and the
          // hitl_request rows are deleted (v1's FK cascade semantics). Both
          // services are Location-scoped, so they resolve per-request here.
          const permission = yield* Permission.Service
          const form = yield* Form.Service
          yield* permission.cancelBySession(ctx.params.sessionID)
          yield* form.cancelBySession(ctx.params.sessionID)
          yield* Hitl.deleteBySession(ctx.params.sessionID)
          yield* session.remove(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          const workspaceID = info.location.workspaceID
          if (workspaceID !== undefined) {
            yield* workspace.destroy(workspaceID).pipe(
              // A stale workspace row (already destroyed) must not fail the
              // session removal.
              Effect.catchIf(
                (error) => error._tag === "WorkspaceDriver.Error",
                () => Effect.void,
              ),
              Effect.orDie,
            )
          }
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.environment",
        Effect.fn(function* (ctx) {
          yield* session
            .environment({ sessionID: ctx.params.sessionID, variables: ctx.payload.variables })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.fork",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session.fork({ sessionID: ctx.params.sessionID, before: ctx.payload.before }).pipe(
              Effect.catchTag("Session.NotFoundError", missingSession),
              Effect.catchTag("Session.MessageNotFoundError", missingMessage),
              Effect.catchTag(
                "Session.ForkEmptyError",
                (error) => new InvalidRequestError({ message: error.message, kind: "empty_session" }),
              ),
            ),
          }
        }),
      )
      .handle(
        "session.switchAgent",
        Effect.fn(function* (ctx) {
          yield* session
            .switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.switchModel",
        Effect.fn(function* (ctx) {
          yield* session
            .switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.update",
        Effect.fn(function* (ctx) {
          const info = yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
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
          // v1 parity: update the workspace sandbox resource; with recreate the
          // current sandbox is killed so the next use provisions with the new spec.
          const workspaceID = info.location.workspaceID
          if (ctx.payload.sandbox !== undefined && workspaceID !== undefined) {
            yield* workspace
              .setResource(workspaceID, { cpu: ctx.payload.sandbox.cpu, memory: ctx.payload.sandbox.memory })
              .pipe(Effect.catchTag("Workspace.NotFound", () => Effect.void), Effect.orDie)
            if (ctx.payload.recreate === true) {
              const suspended = yield* workspace.suspend(workspaceID).pipe(Effect.exit)
              if (!Exit.isSuccess(suspended)) {
                yield* workspace.destroy(workspaceID).pipe(Effect.orDie)
                yield* workspace
                  .create({
                    id: workspaceID,
                    provider: SandboxOpenSandbox.PROVIDER,
                    resource: { cpu: ctx.payload.sandbox.cpu, memory: ctx.payload.sandbox.memory },
                  })
                  .pipe(Effect.orDie)
              }
            }
          }
          return HttpApiSchema.NoContent.make()
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
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.prompt",
        Effect.fn(function* (ctx) {
          // SaaS: stamp the acting user onto the admitted message so HITL asks
          // raised by this turn record their owner (v1's x-user-id -> ask.userId);
          // `x-user-name` mirrors v1's per-message userName on the user message.
          const request = yield* HttpServerRequest.HttpServerRequest
          const userID = requestUserID(request)
          const userName = requestUserName(request)
          const identity = {
            ...(userID === "" ? {} : { userId: userID }),
            ...(userName === "" ? {} : { userName }),
          }
          return {
            data: yield* session
              .prompt({
                sessionID: ctx.params.sessionID,
                id: ctx.payload.id,
                text: ctx.payload.text,
                files: ctx.payload.files,
                agents: ctx.payload.agents,
                skills: ctx.payload.skills,
                format: ctx.payload.format,
                metadata:
                  Object.keys(identity).length === 0 ? ctx.payload.metadata : { ...ctx.payload.metadata, ...identity },
                delivery: ctx.payload.delivery,
                resume: ctx.payload.resume,
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
              ),
          }
        }),
      )
      .handle(
        "session.promptStream",
        Effect.fn(function* (ctx) {
          const request = yield* HttpServerRequest.HttpServerRequest
          const userID = requestUserID(request)
          const userName = requestUserName(request)
          yield* session
            .get(ctx.params.sessionID)
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          // Subscribe before admitting so no event of this turn can be missed;
          // the stream closes once the turn settles.
          const queue = yield* Queue.unbounded<Event.Payload>()
          const unsubscribe = yield* bus.listen((event) =>
            Effect.sync(() => {
              Queue.offerUnsafe(queue, event)
            }),
          )
          const identity = {
            ...(userID === "" ? {} : { userId: userID }),
            ...(userName === "" ? {} : { userName }),
          }
          yield* session
            .prompt({
              sessionID: ctx.params.sessionID,
              text: ctx.payload.text,
              files: ctx.payload.files,
              agents: ctx.payload.agents,
              skills: ctx.payload.skills,
              format: ctx.payload.format,
              metadata:
                Object.keys(identity).length === 0 ? ctx.payload.metadata : { ...ctx.payload.metadata, ...identity },
              delivery: ctx.payload.delivery,
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
          const connected = { id: Event.ID.create(), type: "server.connected", data: {} } as unknown
          return Stream.make(connected).pipe(
            Stream.concat(
              Stream.fromQueue(queue).pipe(
                Stream.filter((event) => eventSessionID(event) === ctx.params.sessionID),
                Stream.takeUntil(isTurnEnd),
                Stream.map((event) => event as unknown),
              ),
            ),
            Stream.ensuring(unsubscribe),
          )
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
          // v1 parity: signal that a custom command ran (arguments is the invocation text).
          yield* bus.publish(Command.Event.Executed, {
            sessionID: ctx.params.sessionID,
            name: ctx.payload.name,
            arguments: ctx.payload.text,
          })
          return HttpApiSchema.NoContent.make()
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
          return { data }
        }),
      )
      .handle(
        "session.shell",
        Effect.fn(function* (ctx) {
          yield* session
            .shell({ sessionID: ctx.params.sessionID, id: ctx.payload.id, command: ctx.payload.command })
            .pipe(Effect.catchTag("Session.NotFoundError", missingSession))
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.compact",
        Effect.fn(function* (ctx) {
          return {
            data: yield* session
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
              ),
          }
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
          return {
            data: yield* session.revert
              .stage({ ...ctx.params, ...ctx.payload })
              .pipe(
                Effect.catchTag("Session.NotFoundError", missingSession),
                Effect.catchTag("Session.MessageNotFoundError", missingMessage),
                Effect.catchTag("Session.BusyError", busySession),
                Effect.catchTag("Snapshot.Error", failedSnapshot("stage session revert", ctx.params.sessionID)),
              ),
          }
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
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "session.inbox.update",
        Effect.fn(function* (ctx) {
          return yield* pendingMutation(
            ctx.payload.delivery === "steer"
              ? session.steerInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID })
              : session.queueInbox({ sessionID: ctx.params.sessionID, inboxID: ctx.params.inboxID }),
            `Pending input cannot change to ${ctx.payload.delivery}`,
          )
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
          // SaaS: an interrupted run no longer waits on its HITL asks, so the
          // pending list clears and the rows close as instance-restart (v1's
          // abort sweep). Idle no-ops leave other owners' asks untouched.
          if (interrupted) {
            const permission = yield* Permission.Service
            const form = yield* Form.Service
            yield* permission.cancelBySession(ctx.params.sessionID, "instance-restart")
            yield* form.cancelBySession(ctx.params.sessionID, "instance-restart")
          }
          return { interrupted }
        }),
      )
      .handle(
        "session.background",
        Effect.fn(function* (ctx) {
          yield* session.background(ctx.params.sessionID).pipe(Effect.catchTag("Session.NotFoundError", missingSession))
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
          const request = yield* HttpServerRequest.HttpServerRequest
          yield* owned.form.reply({
            id: ctx.params.formID,
            answer: ctx.payload.answer,
            userID: requestUserID(request),
          }).pipe(
            Effect.catchTags({
              "Form.AlreadySettledError": (error) =>
                new FormAlreadySettledError({ id: error.id, message: error.message }),
              "Form.InvalidAnswerError": (error) =>
                new FormInvalidAnswerError({ id: error.id, message: error.message }),
              "Form.NotFoundError": () => missingForm(ctx.params.formID),
            }),
          )
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
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)

/**
 * Sandbox wiring (SaaS): when a sandbox provider is configured, allocate a
 * logical workspace for this session so Location routes tool execution into
 * the sandbox. Provisioning stays lazy (first tool execution), matching v1's
 * getOrCreate semantics. Configured alongside the workspace driver in
 * routes.ts; without a configured domain this is a no-op.
 */
const bindSandboxWorkspace = (
  location: Location.Ref,
  workspace: Workspace.Interface,
  sandbox?: { readonly cpu: string; readonly memory: string },
): Effect.Effect<Location.Ref> =>
  Effect.gen(function* () {
    if (location.workspaceID !== undefined) return location
    if (SandboxOpenSandbox.fromEnv() === undefined) return location
    const workspaceID = yield* workspace
      .create({
        provider: SandboxOpenSandbox.PROVIDER,
        resource: sandbox === undefined ? undefined : { cpu: sandbox.cpu, memory: sandbox.memory },
      })
      .pipe(
        Effect.catchTag("Workspace.CreateConflict", (conflict) => Effect.succeed(conflict.workspaceID)),
        Effect.catchTag("WorkspaceDriver.ProviderNotFound", () => Effect.succeed(undefined)),
      )
    if (workspaceID === undefined) return location
    // The sandbox has its own filesystem: Location must point at the
    // in-sandbox working directory, not the host cwd (v1's toSandboxCwd
    // semantics). Host-path -> sandbox-path mapping per directory comes later.
    return Location.Ref.make({
      directory: AbsolutePath.make(process.env["OPENCODE_SANDBOX_WORKDIR"] ?? "/workspace"),
      workspaceID,
    })
  })
