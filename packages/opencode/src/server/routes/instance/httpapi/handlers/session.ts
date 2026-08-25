import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Agent } from "@/agent/agent"
import { SessionMcp } from "@/mcp/session-mcp"
import { MCP } from "@/mcp"
import { SessionLoadDotOpencode } from "@/config/session-load-dot-opencode"
import { SessionTool } from "@/tool/session-tool"
import { ToolAttachment } from "@/tool/attachment"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { SessionPlugin } from "@/plugin/session-plugin"
import { SessionPluginRuntime } from "@/plugin/session-plugin-runtime"
import { SessionAgentsMd } from "@/session/agents-md"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { InstanceRef } from "@/effect/instance-ref"
import { Permission } from "@/permission"
import { InstanceStore } from "@/project/instance-store"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { SessionCompaction } from "@/session/compaction"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRevert } from "@/session/revert"
import { SessionRunState } from "@/session/run-state"
import { insertExecLog, type ExecLogSource } from "@/session/exec-log"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { Skill } from "@/skill"
import { NamedError } from "@opencode-ai/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import * as Stream from "effect/Stream"
import { InstanceState } from "@/effect/instance-state"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SkillCreatePayload,
  SkillLoadPayload,
  AgentCreatePayload,
  AgentsMdCreatePayload,
  ToolCreatePayload,
  PluginCreatePayload,
  CommandCreatePayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { ApiNotFoundError, PermissionNotFoundError, notFound } from "../errors"
import * as SessionError from "./session-errors"
import { withSessionLock, waitForSessionLock } from "./session-lock"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const revertSvc = yield* SessionRevert.Service
    const compactSvc = yield* SessionCompaction.Service
    const runState = yield* SessionRunState.Service
    const agentSvc = yield* Agent.Service
    const agentsMdSvc = yield* SessionAgentsMd.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const todoSvc = yield* Todo.Service
    const mcpSessionSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionMcp.Service))
    const mcpSvc = yield* MCP.Service
    const toolSessionSvc = Option.getOrUndefined(yield* Effect.serviceOption(SessionTool.Service))
    const pluginSessionSvc = yield* SessionPlugin.Service
    const pluginRuntime = yield* SessionPluginRuntime.Service
    const commandSvc = yield* Command.Service
    const skillSvc = yield* Skill.Service
    const summary = yield* SessionSummary.Service
    const sessionLoadDotOpencodeSvc = yield* SessionLoadDotOpencode.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope
    const sandboxProvider = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      const directory = ctx.query.directory ? yield* InstanceState.directory : undefined
      return yield* session.list({
        directory: ctx.query.scope === "project" ? undefined : directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        appId: ctx.query.appId,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      return yield* SessionError.mapStorageNotFound(session.get(sessionID))
    })

    const logAction = (sessionID: SessionID, source: ExecLogSource, command: unknown) =>
      Effect.promise(() =>
        insertExecLog({
          id: `action-${Date.now()}`,
          session_id: sessionID,
          command: typeof command === "string" ? command : JSON.stringify(command),
          status: "completed" as const,
          source,
          time_started: Date.now(),
          time_finished: Date.now(),
        }),
      ).pipe(Effect.catch(() => Effect.void))

    const errorDetails = (error: unknown) => {
      if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`
      if (typeof error === "object" && error !== null) return JSON.stringify(error) ?? String(error)
      return String(error)
    }

    const logActionFailure = (sessionID: SessionID, source: ExecLogSource, command: unknown, error: unknown) =>
      Effect.promise(() =>
        insertExecLog({
          id: `action-${Date.now()}`,
          session_id: sessionID,
          command: typeof command === "string" ? command : JSON.stringify(command),
          status: "failed" as const,
          error: errorDetails(error),
          source,
          time_started: Date.now(),
          time_finished: Date.now(),
        }),
      ).pipe(Effect.catch(() => Effect.void))

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* session.children(ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const attachment = Effect.fn("SessionHttpApi.attachment")(function* (ctx: {
      params: { sessionID: SessionID; attachmentID: ToolAttachment.ID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!sandboxProvider) return yield* new HttpApiError.InternalServerError({})
      const file = yield* ToolAttachment.open({
        provider: sandboxProvider,
        sessionID: ctx.params.sessionID,
        id: ctx.params.attachmentID,
      }).pipe(
        Effect.catchTag("ToolAttachment.NotFoundError", () =>
          Effect.fail(notFound(`Attachment not found: ${ctx.params.attachmentID}`)),
        ),
        Effect.mapError((error) =>
          error instanceof HttpApiError.InternalServerError || error instanceof ApiNotFoundError
            ? error
            : new HttpApiError.InternalServerError({}),
        ),
      )
      const range = ToolAttachment.parseByteRange(ctx.request.headers.range, file.metadata.size)
      if (range === null)
        return HttpServerResponse.empty({
          status: 416,
          headers: { "Content-Range": `bytes */${file.metadata.size}` },
        })
      const etag = `"sha256-${file.metadata.sha256}"`
      // If-None-Match may be a comma-separated list of entity-tags (RFC 7232 §3.2).
      const ifNoneMatch = ctx.request.headers["if-none-match"]
        ?.split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
      if (!range && ifNoneMatch?.includes(etag))
        return HttpServerResponse.empty({ status: 304, headers: { ETag: etag } })
      return HttpServerResponse.stream(
        Stream.fromAsyncIterable(file.bytes(range?.header), (cause) => cause),
        {
          status: range ? 206 : 200,
          contentType: file.metadata.mime,
          contentLength: range ? range.end - range.start + 1 : file.metadata.size,
          headers: {
            "Accept-Ranges": "bytes",
            "Cache-Control": "private, max-age=31536000, immutable",
            "Content-Disposition": `${file.metadata.audience === "display-only" ? "attachment" : "inline"}; filename="attachment"; filename*=UTF-8''${encodeFilename(file.metadata.filename)}`,
            ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${file.metadata.size}` } : {}),
            ETag: etag,
            "X-Content-Type-Options": "nosniff",
          },
        },
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      const result = yield* shareSvc.create(ctx.payload).pipe(
        Effect.catchTag("SessionInvalidPvcConfigError", () => Effect.fail(new HttpApiError.BadRequest({}))),
      )
      if (result?.id) yield* logAction(result.id as SessionID, "session-create", ctx.payload ?? {})
      return result
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* SessionError.mapStorageNotFound(session.remove(ctx.params.sessionID))
      yield* pluginRuntime.dispose(ctx.params.sessionID)
      // session-delete not logged here — FK cascade removes exec_log along with session
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      if (ctx.payload.directory !== undefined) {
        const store = yield* InstanceStore.Service
        yield* withSessionLock(ctx.params.sessionID, store.reload({ directory: ctx.payload.directory }))
        yield* session.setDirectory({ sessionID: ctx.params.sessionID, directory: ctx.payload.directory })
      }
      if (ctx.payload.title !== undefined) {
        yield* session.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
      }
      if (ctx.payload.metadata !== undefined) {
        yield* session.setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
      }
      if (ctx.payload.permission !== undefined) {
        yield* session.setPermission({
          sessionID: ctx.params.sessionID,
          permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
        })
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* session.setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
      }
      yield* logAction(ctx.params.sessionID, "patch", ctx.payload)
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      const result = yield* SessionError.mapStorageNotFound(
        session.fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID,
        }),
      )
      yield* logAction(ctx.params.sessionID, "session-fork", ctx.payload ?? {})
      return result
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* promptSvc.cancel(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "session-abort", {})
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* promptSvc
        .command({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload.messageID,
          model: `${ctx.payload.providerID}/${ctx.payload.modelID}`,
          command: Command.Default.INIT,
          arguments: "",
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      yield* logAction(ctx.params.sessionID, "session-init", ctx.payload)
      return true
    })

    const loadDotOpencode = Effect.fn("SessionHttpApi.loadDotOpencode")(function* (ctx: {
      params: { sessionID: SessionID }
      query: { directory?: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const directory = ctx.query.directory ?? (yield* InstanceState.directory)
      const result = yield* sessionLoadDotOpencodeSvc.load(ctx.params.sessionID, directory)
      if (result.loaded.some((item) => item.startsWith("plugins/"))) {
        yield* pluginRuntime.invalidate(ctx.params.sessionID)
      }
      yield* logAction(ctx.params.sessionID, "dotopencode-load", result)
      return result
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      yield* logAction(ctx.params.sessionID, "session-share", {})
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      yield* logAction(ctx.params.sessionID, "session-unshare", {})
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* revertSvc.cleanup(yield* requireSession(ctx.params.sessionID))
      const messages = yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      const defaultAgent = yield* agentSvc.defaultAgent()
      const currentAgent = messages.findLast((message) => message.info.role === "user")?.info.agent ?? defaultAgent

      yield* compactSvc.create({
        sessionID: ctx.params.sessionID,
        agent: currentAgent,
        model: {
          providerID: ctx.payload.providerID,
          modelID: ctx.payload.modelID,
        },
        auto: ctx.payload.auto ?? false,
      })
      yield* promptSvc.loop({ sessionID: ctx.params.sessionID })
      yield* logAction(ctx.params.sessionID, "session-summarize", ctx.payload)
      return true
    })

    const prompt = Effect.fn("SessionHttpApi.prompt")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* waitForSessionLock(ctx.params.sessionID)
      const message = yield* withSessionLock(ctx.params.sessionID, promptSvc.prompt({
        ...ctx.payload,
        sessionID: ctx.params.sessionID,
      })).pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      yield* logAction(ctx.params.sessionID, "session-prompt", ctx.payload)
      return HttpServerResponse.stream(Stream.make(JSON.stringify(message)).pipe(Stream.encodeText), {
        contentType: "application/json",
      })
    })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* waitForSessionLock(ctx.params.sessionID)
      yield* withSessionLock(ctx.params.sessionID, promptSvc.prompt({ ...ctx.payload, sessionID: ctx.params.sessionID })).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError("prompt_async failed", { sessionID: ctx.params.sessionID, cause })
            yield* events.publish(Session.Event.Error, {
              sessionID: ctx.params.sessionID,
              error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
            })
          }),
        ),
        Effect.forkIn(scope, { startImmediately: true }),
      )
      yield* logAction(ctx.params.sessionID, "session-prompt-async", ctx.payload)
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* waitForSessionLock(ctx.params.sessionID)
      const result = yield* withSessionLock(ctx.params.sessionID, promptSvc
        .command({ ...ctx.payload, sessionID: ctx.params.sessionID }))
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      yield* logAction(ctx.params.sessionID, "session-command", ctx.payload)
      return result
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* SessionError.mapBusy(promptSvc.shell({ ...ctx.payload, sessionID: ctx.params.sessionID }))
      yield* logAction(ctx.params.sessionID, "session-shell", ctx.payload)
      return result
    })

    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* SessionError.mapBusy(revertSvc.revert({ sessionID: ctx.params.sessionID, ...ctx.payload }))
      yield* logAction(ctx.params.sessionID, "session-revert", ctx.payload)
      return result
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* SessionError.mapBusy(revertSvc.unrevert({ sessionID: ctx.params.sessionID }))
      yield* logAction(ctx.params.sessionID, "session-unrevert", {})
      return result
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      yield* logAction(ctx.params.sessionID, "permission-respond", { permissionID: ctx.params.permissionID, ...ctx.payload })
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      yield* logAction(ctx.params.sessionID, "message-delete", ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      yield* logAction(ctx.params.sessionID, "part-delete", ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      const result = yield* session.updatePart(payload)
      yield* logAction(ctx.params.sessionID, "part-update", ctx.params)
      return result
    })

    const listSkills = Effect.fn("SessionHttpApi.skills")(function* (ctx: { params: { sessionID: SessionID } }) {
      return (yield* skillSvc.sessionList(ctx.params.sessionID)).map(Skill.publicInfo)
    })

    const createSkill = Effect.fn("SessionHttpApi.skillsCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SkillCreatePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const result = Skill.publicInfo(
        yield* skillSvc
          .sessionCreate(ctx.params.sessionID, ctx.payload)
          .pipe(
            Effect.tapError((error) =>
              logActionFailure(
                ctx.params.sessionID,
                "skill-create",
                {
                  name: ctx.payload.name,
                  contentLength: ctx.payload.content.length,
                  resourceCount: ctx.payload.resources?.length ?? 0,
                },
                error,
              ),
            ),
          )
          .pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      yield* logAction(ctx.params.sessionID, "skill-create", ctx.payload)
      return result
    })

    const loadSkills = Effect.fn("SessionHttpApi.skillsLoad")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SkillLoadPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const result = (yield* skillSvc
        .sessionLoad(ctx.params.sessionID, ctx.payload.path)
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))).map(Skill.publicInfo)
      yield* logAction(ctx.params.sessionID, "skill-load", ctx.payload)
      return result
    })

    const deleteSkill = Effect.fn("SessionHttpApi.skillsDelete")(function* (ctx: {
      params: { sessionID: SessionID; name: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* skillSvc.sessionUnload(ctx.params.sessionID, ctx.params.name)
      yield* logAction(ctx.params.sessionID, "skill-delete", { name: ctx.params.name })
      return HttpApiSchema.NoContent.make()
    })

    const clearSkills = Effect.fn("SessionHttpApi.skillsClear")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* skillSvc.sessionClear(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "skill-clear", {})
      return HttpApiSchema.NoContent.make()
    })

    const listAgents = Effect.fn("SessionHttpApi.agents")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* agentSvc.sessionList(ctx.params.sessionID)
    })

    const createAgent = Effect.fn("SessionHttpApi.agentsCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: any
    }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* agentSvc.sessionCreate(ctx.params.sessionID, ctx.payload)
      yield* logAction(ctx.params.sessionID, "agent-create", ctx.payload)
      return result
    })

    const deleteAgent = Effect.fn("SessionHttpApi.agentsDelete")(function* (ctx: {
      params: { sessionID: SessionID; name: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* agentSvc.sessionUnload(ctx.params.sessionID, ctx.params.name)
      yield* logAction(ctx.params.sessionID, "agent-delete", { name: ctx.params.name })
    })

    const clearAgents = Effect.fn("SessionHttpApi.agentsClear")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* agentSvc.sessionClear(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "agent-clear", {})
    })

    const listMcps = Effect.fn("SessionHttpApi.mcps")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!mcpSessionSvc) return []
      return yield* mcpSessionSvc.list(ctx.params.sessionID).pipe(Effect.catch(() => Effect.succeed([])))
    })

    const createMcp = Effect.fn("SessionHttpApi.mcpsCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: any
    }) {
      if (!mcpSessionSvc) throw new Error("Session MCPs are only available in SaaS mode")
      yield* requireSession(ctx.params.sessionID)
      const result = yield* mcpSessionSvc.upsert(ctx.params.sessionID, ctx.payload)
      yield* mcpSvc.clearSessionCache(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "mcp-create", ctx.payload)
      return result
    })

    const deleteMcp = Effect.fn("SessionHttpApi.mcpsDelete")(function* (ctx: {
      params: { sessionID: SessionID; name: string }
    }) {
      if (!mcpSessionSvc) throw new Error("Session MCPs are only available in SaaS mode")
      yield* requireSession(ctx.params.sessionID)
      yield* mcpSessionSvc.remove(ctx.params.sessionID, ctx.params.name)
      yield* mcpSvc.clearSessionCache(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "mcp-delete", { name: ctx.params.name })
    })

    const clearMcps = Effect.fn("SessionHttpApi.mcpsClear")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!mcpSessionSvc) throw new Error("Session MCPs are only available in SaaS mode")
      yield* requireSession(ctx.params.sessionID)
      yield* mcpSessionSvc.removeAll(ctx.params.sessionID)
      yield* mcpSvc.clearSessionCache(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "mcp-clear", {})
    })

    const listTools = Effect.fn("SessionHttpApi.tools")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!toolSessionSvc) return []
      return yield* toolSessionSvc.list(ctx.params.sessionID).pipe(Effect.catch(() => Effect.succeed([])))
    })

    const createTool = Effect.fn("SessionHttpApi.toolsCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: { name: string; description: string; code: string }
    }) {
      if (!toolSessionSvc) throw new Error("Session tools are only available in SaaS mode")
      yield* requireSession(ctx.params.sessionID)
      const result = yield* toolSessionSvc.upsert(ctx.params.sessionID, ctx.payload)
      yield* logAction(ctx.params.sessionID, "tool-create", { name: ctx.payload.name })
      return result
    })

    const deleteTool = Effect.fn("SessionHttpApi.toolsDelete")(function* (ctx: {
      params: { sessionID: SessionID; name: string }
    }) {
      if (!toolSessionSvc) throw new Error("Session tools are only available in SaaS mode")
      yield* requireSession(ctx.params.sessionID)
      yield* toolSessionSvc.remove(ctx.params.sessionID, ctx.params.name)
      yield* logAction(ctx.params.sessionID, "tool-delete", { name: ctx.params.name })
    })

    const clearTools = Effect.fn("SessionHttpApi.toolsClear")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      if (!toolSessionSvc) throw new Error("Session tools are only available in SaaS mode")
      yield* requireSession(ctx.params.sessionID)
      yield* toolSessionSvc.removeAll(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "tool-clear", {})
    })

    const stripUndefined = (obj: Record<string, unknown>) => {
      const r: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(obj)) if (v !== undefined) r[k] = v
      return r
    }

    const listCommands = Effect.fn("SessionHttpApi.commands")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      const cmds = yield* commandSvc.sessionList(ctx.params.sessionID).pipe(
        Effect.catch((error) =>
          Effect.logWarning("sessionList failed", { sessionID: ctx.params.sessionID, error: String(error) }).pipe(Effect.as([])),
        ),
      )
      return cmds.map((c) => stripUndefined(c as unknown as Record<string, unknown>))
    })

    const createCommand = Effect.fn("SessionHttpApi.commandsCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: {
        name: string
        template: string
        description?: string
        agent?: string
        model?: string
        subtask?: boolean
        hints?: readonly string[]
      }
    }) {
      yield* requireSession(ctx.params.sessionID)
      if (!ctx.payload.name?.trim() || /[\s/]/.test(ctx.payload.name)) {
        return yield* Effect.fail(new HttpApiError.BadRequest({}))
      }
      const info = yield* commandSvc.sessionCreate(ctx.params.sessionID, ctx.payload)
      yield* logAction(ctx.params.sessionID, "command-create", ctx.payload)
      return stripUndefined(info as unknown as Record<string, unknown>)
    })

    const deleteCommand = Effect.fn("SessionHttpApi.commandsDelete")(function* (ctx: {
      params: { sessionID: SessionID; name: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* commandSvc.sessionRemove(ctx.params.sessionID, ctx.params.name)
      yield* logAction(ctx.params.sessionID, "command-delete", { name: ctx.params.name })
    })

    const clearCommands = Effect.fn("SessionHttpApi.commandsClear")(function* (ctx: {
      params: { sessionID: SessionID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* commandSvc.sessionClear(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "command-clear", {})
    })

    const getAgentsMd = Effect.fn("SessionHttpApi.agentsMd")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return (yield* agentsMdSvc.get(ctx.params.sessionID)) ?? null
    })

    const createAgentsMd = Effect.fn("SessionHttpApi.agentsMdCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof AgentsMdCreatePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const result = yield* agentsMdSvc.upsert(ctx.params.sessionID, ctx.payload)
      yield* logAction(ctx.params.sessionID, "agentsmd-create", { length: ctx.payload.content?.length ?? 0 })
      return result
    })

    const clearAgentsMd = Effect.fn("SessionHttpApi.agentsMdDelete")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* agentsMdSvc.remove(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "agentsmd-clear", {})
    })

    const listPlugins = Effect.fn("SessionHttpApi.plugins")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      const rows = yield* pluginSessionSvc.list(ctx.params.sessionID)
      return rows.map(({ code: _code, ...row }) => row)
    })

    const createPlugin = Effect.fn("SessionHttpApi.pluginsCreate")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PluginCreatePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const row = yield* pluginSessionSvc.upsert(ctx.params.sessionID, ctx.payload)
      yield* pluginRuntime.invalidate(ctx.params.sessionID)
      const { code: _code, ...safe } = row
      yield* logAction(ctx.params.sessionID, "plugin-create", { name: ctx.payload.name })
      return safe
    })

    const deletePlugin = Effect.fn("SessionHttpApi.pluginsDelete")(function* (ctx: {
      params: { sessionID: SessionID; name: string }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* pluginSessionSvc.remove(ctx.params.sessionID, ctx.params.name)
      yield* pluginRuntime.invalidate(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "plugin-delete", { name: ctx.params.name })
    })

    const clearPlugins = Effect.fn("SessionHttpApi.pluginsClear")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* pluginSessionSvc.removeAll(ctx.params.sessionID)
      yield* pluginRuntime.invalidate(ctx.params.sessionID)
      yield* logAction(ctx.params.sessionID, "plugin-clear", {})
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("attachment", attachment)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("loadDotOpencode", loadDotOpencode)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("prompt", prompt)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
      .handle("skills", listSkills)
      .handle("skillsCreate", createSkill)
      .handle("skillsLoad", loadSkills)
      .handle("skillsDelete", deleteSkill)
      .handle("skillsClear", clearSkills)
      .handle("agents", listAgents)
      .handle("agentsCreate", createAgent)
      .handle("agentsDelete", deleteAgent)
      .handle("agentsClear", clearAgents)
      .handle("mcps", listMcps)
      .handle("mcpsCreate", createMcp)
      .handle("mcpsDelete", deleteMcp)
      .handle("mcpsClear", clearMcps)
      .handle("tools", listTools)
      .handle("toolsCreate", createTool)
      .handle("toolsDelete", deleteTool)
      .handle("toolsClear", clearTools)
      .handle("commands", listCommands)
      .handle("commandsCreate", createCommand)
      .handle("commandsDelete", deleteCommand)
      .handle("commandsClear", clearCommands)
      .handle("agentsMd", getAgentsMd)
      .handle("agentsMdCreate", createAgentsMd)
      .handle("agentsMdDelete", clearAgentsMd)
      .handle("plugins", listPlugins)
      .handle("pluginsCreate", createPlugin)
      .handle("pluginsDelete", deletePlugin)
      .handle("pluginsClear", clearPlugins)
  }),
)

function encodeFilename(value: string) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}
