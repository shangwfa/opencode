import { Effect, Option } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as InstanceState from "@/effect/instance-state"
import { InstanceRef } from "@/effect/instance-ref"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { RpaRunner } from "@/rpa/rpa-runner"
import { RpaPG } from "@/rpa/rpa.pg"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError, notFound } from "../errors"

const toAppInfo = (row: RpaPG.RpaApp) => ({
  id: row.id,
  name: row.name,
  description: row.description ?? undefined,
  status: row.status,
  params_schema: row.params_schema ?? undefined,
  time_created: row.time_created,
  time_updated: row.time_updated,
})

const toVersionInfo = (row: RpaPG.RpaAppVersion) => ({
  id: row.id,
  app_id: row.app_id,
  version: row.version,
  status: row.status,
  source: row.source,
  script: row.script,
  exploration: row.exploration ?? undefined,
  manifest: row.manifest ?? undefined,
  note: row.note ?? undefined,
  repair_from_version: row.repair_from_version ?? undefined,
  validate_run_id: row.validate_run_id ?? undefined,
  time_created: row.time_created,
  time_updated: row.time_updated,
})

const toRunInfo = (row: RpaPG.RpaAppRun) => ({
  id: row.id,
  app_id: row.app_id,
  version_id: row.version_id,
  trigger_type: row.trigger_type,
  status: row.status,
  params: row.params ?? undefined,
  result: row.result ?? undefined,
  error: row.error ?? undefined,
  exit_code: row.exit_code ?? undefined,
  repair_count: row.repair_count,
  repair_tokens: row.repair_tokens,
  repair_session_id: row.repair_session_id ?? undefined,
  repaired_version_id: row.repaired_version_id ?? undefined,
  run_session_id: row.run_session_id ?? undefined,
  time_started: row.time_started ?? undefined,
  time_finished: row.time_finished ?? undefined,
  time_created: row.time_created,
  time_updated: row.time_updated,
})

const requireApp = Effect.fn("RpaHttpApi.requireApp")(function* (appID: string) {
  const instance = yield* InstanceState.context
  const app = yield* Effect.promise(() => RpaPG.queryRpaAppForProject(appID, instance.project.id))
  if (app === null) return yield* Effect.fail(notFound(`RPA app not found: ${appID}`))
  return app
})

export const rpaHandlers = HttpApiBuilder.group(InstanceHttpApi, "rpa", (handlers) =>
  Effect.gen(function* () {
    const sessionSvc = yield* Session.Service
    const sandboxSvc = Option.getOrUndefined(yield* Effect.serviceOption(SandboxProvider.Service))
    const promptSvc = yield* SessionPrompt.Service

    // exploration 兼容 string | object，统一落库为格式化 JSON 字符串
    const explorationText = (value: string | Record<string, unknown> | undefined) =>
      typeof value === "string" ? value : value === undefined ? undefined : JSON.stringify(value, null, 2)

    const create = Effect.fn("RpaHttpApi.create")(function* (ctx: {
      payload: {
        name: string
        description?: string
        script: string
        exploration?: string | Record<string, unknown>
        params_schema?: Record<string, unknown>
        manifest?: Record<string, unknown>
        source?: "exploration" | "manual"
      }
    }) {
      const instance = yield* InstanceState.context
      const appID = RpaPG.newRpaAppId()
      const now = Date.now()
      const app = {
        id: appID,
        project_id: instance.project.id,
        directory: instance.directory,
        name: ctx.payload.name,
        description: ctx.payload.description ?? null,
        status: "active" as const,
        params_schema: ctx.payload.params_schema ?? null,
        time_created: now,
        time_updated: now,
      }
      yield* Effect.promise(() => RpaPG.insertRpaApp(app))
      const version = yield* insertVersion({
        appID,
        script: ctx.payload.script,
        source: ctx.payload.source ?? "manual",
        exploration: explorationText(ctx.payload.exploration),
        manifest: ctx.payload.manifest,
        promote: true,
      })
      return { app: toAppInfo(app), version: toVersionInfo(version) }
    })

    const insertVersion = Effect.fn("RpaHttpApi.insertVersion")(function* (input: {
      appID: string
      script: string
      source: RpaPG.RpaVersionSource
      exploration?: string
      manifest?: Record<string, unknown>
      note?: string
      repair_from_version?: number
      promote: boolean
    }) {
      const versionID = RpaPG.newRpaVersionId()
      const version = yield* Effect.promise(() =>
        RpaPG.insertNextRpaVersion({
          id: versionID,
          app_id: input.appID,
          status: "candidate",
          source: input.source,
          script: input.script,
          exploration: input.exploration ?? null,
          manifest: input.manifest ?? null,
          note: input.note ?? null,
          repair_from_version: input.repair_from_version ?? null,
        }),
      )
      if (input.promote) yield* Effect.promise(() => RpaPG.promoteRpaVersion(input.appID, versionID))
      if (!input.promote) return version
      return yield* Effect.promise(() => RpaPG.requireRpaVersion(versionID))
    })

    const list = Effect.fn("RpaHttpApi.list")(function* () {
      const instance = yield* InstanceState.context
      const apps = yield* Effect.promise(() => RpaPG.queryRpaApps(instance.project.id))
      return { apps: apps.map(toAppInfo) }
    })

    const get = Effect.fn("RpaHttpApi.get")(function* (ctx: { params: { appID: string } }) {
      const app = yield* requireApp(ctx.params.appID)
      const versions = yield* Effect.promise(() => RpaPG.queryRpaVersions(app.id))
      const active = yield* Effect.promise(() => RpaPG.queryActiveRpaVersion(app.id))
      return {
        app: toAppInfo(app),
        active_version: active ? toVersionInfo(active) : undefined,
        versions: versions.map(toVersionInfo),
      }
    })

    const update = Effect.fn("RpaHttpApi.update")(function* (ctx: {
      params: { appID: string }
      payload: { name?: string; description?: string; status?: "active" | "disabled" }
    }) {
      const current = yield* requireApp(ctx.params.appID)
      yield* Effect.promise(() => RpaPG.updateRpaApp(ctx.params.appID, current.project_id, ctx.payload))
      const app = yield* requireApp(ctx.params.appID)
      return toAppInfo(app)
    })

    const remove = Effect.fn("RpaHttpApi.remove")(function* (ctx: { params: { appID: string } }) {
      const app = yield* requireApp(ctx.params.appID)
      yield* Effect.promise(() => RpaPG.deleteRpaApp(ctx.params.appID, app.project_id))
      return { ok: true }
    })

    const addVersion = Effect.fn("RpaHttpApi.addVersion")(function* (ctx: {
      params: { appID: string }
      payload: {
        script: string
        source: RpaPG.RpaVersionSource
        exploration?: string | Record<string, unknown>
        manifest?: Record<string, unknown>
        note?: string
        repair_from_version?: number
        promote?: boolean
      }
    }) {
      yield* requireApp(ctx.params.appID)
      const version = yield* insertVersion({
        appID: ctx.params.appID,
        script: ctx.payload.script,
        source: ctx.payload.source,
        exploration: explorationText(ctx.payload.exploration),
        manifest: ctx.payload.manifest,
        note: ctx.payload.note,
        repair_from_version: ctx.payload.repair_from_version,
        promote: ctx.payload.promote !== false,
      })
      return { version: toVersionInfo(version) }
    })

    const run = Effect.fn("RpaHttpApi.run")(function* (ctx: {
      params: { appID: string }
      payload: { params?: Record<string, unknown>; trigger_type?: RpaPG.RpaRunTrigger }
    }) {
      const app = yield* requireApp(ctx.params.appID)
      if (sandboxSvc === undefined) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: "Sandbox provider is not enabled on this instance", kind: "sandbox" }),
        )
      }
      const active = yield* Effect.promise(() => RpaPG.queryActiveRpaVersion(app.id))
      if (active === null) {
        return yield* Effect.fail(
          new InvalidRequestError({ message: "App has no active version", kind: "no-active-version" }),
        )
      }
      // 隐藏运行会话必须在请求上下文内创建（session.create 依赖 request-scoped InstanceRef）；
      // pvcMode=app + appId=rpa app id → 沙箱卷按 app 聚合，登录态/产物跨 run 复用
      const hidden = yield* sessionSvc
        .create({ title: `rpa:${app.name}`, pvcMode: "app", appId: app.id })
        .pipe(
          Effect.catch(() =>
            Effect.fail(
              new InvalidRequestError({ message: "Failed to create runner session", kind: "runner-session" }),
            ),
          ),
        )
      const runID = RpaPG.newRpaRunId()
      const row = {
        id: runID,
        app_id: app.id,
        version_id: active.id,
        trigger_type: ctx.payload.trigger_type ?? ("api" as const),
        status: "pending" as const,
        params: ctx.payload.params ?? null,
        run_session_id: hidden.id,
      }
      yield* Effect.promise(() => RpaPG.insertRpaRun(row))
      // InstanceRef 是请求作用域的，必须在 handler 体内读取（构建期读到的是 undefined）
      const instanceRef = yield* InstanceRef
      const repair = instanceRef
        ? {
            session: sessionSvc,
            promptFn: promptSvc.prompt,
            instanceRef,
            model: { providerID: "Yd-DeepSeek", modelID: "deepseek-v4-flash" },
          }
        : undefined
      const runnerEffect = RpaRunner.executeRpaRun(runID, hidden.id, { sandbox: sandboxSvc, repair })
      // 修复子会话的只读工具通过根会话定位到原运行沙箱，SandboxProvider 必须显式保留在 detached fiber 中。
      const runnerFiber = (
        instanceRef ? runnerEffect.pipe(Effect.provideService(InstanceRef, instanceRef)) : runnerEffect
      ).pipe(Effect.provideService(SandboxProvider.Service, sandboxSvc))
      Effect.runFork(
        runnerFiber.pipe(
          Effect.catchDefect((defect: unknown) =>
            Effect.promise(() => RpaPG.failActiveRpaRun(runID, `runner defect: ${defect}`)).pipe(Effect.asVoid),
          ),
        ),
      )
      const created = yield* Effect.promise(() => RpaPG.requireRpaRun(runID))
      return { run: toRunInfo(created) }
    })

    const runs = Effect.fn("RpaHttpApi.runs")(function* (ctx: { params: { appID: string } }) {
      yield* requireApp(ctx.params.appID)
      const rows = yield* Effect.promise(() => RpaPG.queryRpaRuns(ctx.params.appID))
      return { runs: rows.map(toRunInfo) }
    })

    const runDetail = Effect.fn("RpaHttpApi.runDetail")(function* (ctx: { params: { runID: string } }) {
      const instance = yield* InstanceState.context
      const row = yield* Effect.promise(() => RpaPG.queryRpaRunForProject(ctx.params.runID, instance.project.id))
      if (row === null) return yield* Effect.fail(notFound(`RPA run not found: ${ctx.params.runID}`))
      return { run: toRunInfo(row) }
    })

    return handlers
      .handle("create", create)
      .handle("list", list)
      .handle("get", get)
      .handle("update", update)
      .handle("remove", remove)
      .handle("addVersion", addVersion)
      .handle("run", run)
      .handle("runs", runs)
      .handle("runDetail", runDetail)
  }),
)
