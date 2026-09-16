import { Effect } from "effect"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { Session } from "@/session/session"
import { SessionPrompt } from "@/session/prompt"
import type { PromptInput } from "@/session/prompt"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import type { SessionID } from "@/session/schema"
import { Log } from "@opencode-ai/core/util/log"
import {
  claimRpaRun,
  insertNextRpaVersion,
  promoteRpaVersion,
  queryRpaApp,
  queryRpaRun,
  queryRpaVersion,
  updateRpaRunIfStatus,
  updateRpaVersion,
  type RpaAppRun,
} from "./rpa.pg"

const log = Log.create({ service: "rpa-runner" })

/** stdout/stderr 落库截断上限（防大输出撑爆行） */
const OUTPUT_LIMIT_BYTES = 64 * 1024
/** 单次 run 的自修复次数上限，超过即 failed 上报（防 token 失控） */
export const MAX_REPAIRS = 2

const truncate = (text: string) => (text.length > OUTPUT_LIMIT_BYTES ? text.slice(0, OUTPUT_LIMIT_BYTES) : text)

export interface RpaRepairDeps {
  session: Session.Interface
  promptFn: (input: PromptInput) => Effect.Effect<unknown, unknown, never>
  instanceRef: InstanceContext | undefined
  model: { providerID: string; modelID: string }
}

export interface RpaRunnerDeps {
  sandbox: SandboxProvider.Interface
  repair?: RpaRepairDeps
}

interface ScriptOutcome {
  exitCode: number | null
  stdout: string
  stderr: string
}

const joinLogs = (logs: { text: string }[] | undefined) => (logs ?? []).map((m) => m.text).join("\n")

/** 执行单个 run 的完整生命周期：认领 → app PVC 沙箱 → 注入脚本 → 执行 → 落终态/自修复。
 * 运行会话由 handler 在请求上下文内创建后传入（session.create 依赖 request-scoped InstanceRef，
 * fork 出去的 fiber 拿不到——修复会话的创建则通过 deps.repair.instanceRef 显式注入解决）。 */
export const executeRpaRun = Effect.fn("RpaRunner.execute")(function* (
  runID: string,
  hiddenSessionID: SessionID,
  deps: RpaRunnerDeps,
) {
  for (;;) {
    const run = yield* Effect.promise(() => queryRpaRun(runID))
    if (run === null) return
    const claimed = yield* Effect.promise(() => claimRpaRun(runID))
    if (!claimed) {
      log.info("run already claimed, skipping", { runID, status: run.status })
      return
    }

    const fail = (error: string) =>
      Effect.promise(() =>
        updateRpaRunIfStatus(runID, "running", { status: "failed", error, time_finished: Date.now() }),
      )

    const app = yield* Effect.promise(() => queryRpaApp(run.app_id))
    if (app === null) {
      yield* fail("app deleted before run started")
      return
    }
    const version = yield* Effect.promise(() => queryRpaVersion(run.repaired_version_id ?? run.version_id))
    if (version === null) {
      yield* fail("version deleted before run started")
      return
    }

    if (app.status !== "active") {
      yield* fail(`app is ${app.status}`)
      return
    }

    const outcome = yield* runScript(run, version.script, version.manifest, hiddenSessionID, deps).pipe(Effect.exit)

    if (outcome._tag === "Failure") {
      yield* fail(`sandbox execution failed: ${outcome.cause}`)
      return
    }

    const { exitCode, stdout, stderr } = outcome.value
    if (exitCode === 0) {
      if (run.repaired_version_id) {
        yield* Effect.promise(() => updateRpaVersion(version.id, { validate_run_id: run.id }))
        const promoted = yield* Effect.promise(() => promoteRpaVersion(app.id, version.id, run.version_id))
        if (!promoted) {
          log.warn("repaired version validated but active version changed; leaving candidate unpromoted", {
            runID,
            versionID: version.id,
          })
        }
      }
      yield* Effect.promise(() =>
        updateRpaRunIfStatus(runID, "running", {
          status: "succeeded",
          version_id: version.id,
          exit_code: 0,
          error: null,
          result: { stdout: truncate(stdout), workdir: `/workspace/.rpa/${runID}` },
          time_finished: Date.now(),
        }),
      )
      return
    }

    const scriptError = truncate(stderr) || truncate(stdout) || `script exited with code ${exitCode}`
    const result = { stdout: truncate(stdout), workdir: `/workspace/.rpa/${runID}` }
    if (!deps.repair || run.repair_count >= MAX_REPAIRS) {
      yield* Effect.promise(() =>
        updateRpaRunIfStatus(runID, "running", {
          status: "failed",
          exit_code: exitCode ?? null,
          result,
          error: scriptError,
          time_finished: Date.now(),
        }),
      )
      return
    }

    const repairing = yield* Effect.promise(() =>
      updateRpaRunIfStatus(runID, "running", {
        status: "repairing",
        exit_code: exitCode ?? null,
        result,
        error: scriptError,
        repair_count: run.repair_count + 1,
        time_finished: null,
      }),
    )
    if (!repairing) return

    const repaired = yield* repairScript(
      run,
      app,
      version,
      scriptError,
      hiddenSessionID,
      deps.sandbox,
      deps.repair,
    ).pipe(Effect.exit)
    if (repaired._tag === "Success" && repaired.value !== null) {
      const newVersion = repaired.value
      const queued = yield* Effect.promise(() =>
        updateRpaRunIfStatus(runID, "repairing", {
          status: "pending",
          error: null,
          exit_code: null,
          result: null,
          repaired_version_id: newVersion.id,
          time_finished: null,
        }),
      )
      if (!queued) return
      log.info("script repaired, rerunning in original sandbox", {
        runID,
        from: version.version,
        to: newVersion.version,
      })
      continue
    }
    if (repaired._tag === "Failure") {
      log.warn("repair attempt failed", { runID, cause: String(repaired.cause) })
    }
    yield* Effect.promise(() =>
      updateRpaRunIfStatus(runID, "repairing", { status: "failed", time_finished: Date.now() }),
    )
    return
  }
})

const runScript = Effect.fn("RpaRunner.runScript")(function* (
  run: RpaAppRun,
  script: string,
  manifest: Record<string, unknown> | null,
  sessionID: SessionID,
  deps: RpaRunnerDeps,
) {
  yield* deps.sandbox.getOrCreate(sessionID, { pvcMode: "app", appId: run.app_id })

  const dir = `/workspace/.rpa/${run.id}`
  const scriptB64 = Buffer.from(script).toString("base64")
  const paramsB64 = Buffer.from(JSON.stringify(run.params ?? {})).toString("base64")
  yield* deps.sandbox.runInSession(
    sessionID,
    `mkdir -p ${dir} && echo ${scriptB64} | base64 -d > ${dir}/main.mjs && echo ${paramsB64} | base64 -d > ${dir}/params.json`,
    { timeoutSeconds: 30 },
  )

  const timeoutSeconds = typeof manifest?.timeout_seconds === "number" ? manifest.timeout_seconds : 300
  // 断点续跑契约：脚本每步成功后写 RPA_CHECKPOINT（{step:N}）；修复重跑时同卷 checkpoint 保留，
  // 脚本读它跳过已完成步骤、从失败步骤继续执行（不从头重跑）。
  const execution = yield* deps.sandbox.runInSession(
    sessionID,
    `RPA_CHECKPOINT=${dir}/checkpoint.json node ${dir}/main.mjs ${dir}/params.json`,
    { timeoutSeconds },
  )
  return {
    exitCode: execution.exitCode ?? null,
    stdout: joinLogs(execution.logs?.stdout),
    stderr: joinLogs(execution.logs?.stderr),
  } satisfies ScriptOutcome
})

/** AI 自修复会话作为运行会话的子会话，因此工具读取原运行沙箱现场；AI 只返回脚本文本，
 * runner 负责语法校验和候选版本落库，实际验证与续跑仍发生在原运行沙箱。 */
const repairScript = Effect.fn("RpaRunner.repairScript")(function* (
  run: RpaAppRun,
  app: NonNullable<Awaited<ReturnType<typeof queryRpaApp>>>,
  version: NonNullable<Awaited<ReturnType<typeof queryRpaVersion>>>,
  failure: string,
  runSessionID: SessionID,
  sandbox: SandboxProvider.Interface,
  repair: RpaRepairDeps,
) {
  if (!repair.instanceRef) {
    log.warn("no InstanceRef available for repair, skipping", { runID: run.id })
    return null
  }

  const dir = `/workspace/.rpa/${run.id}`
  const repairPrompt = `你是自动化脚本修复工程师。一个已沉淀的 RPA 脚本（${app.name}）执行失败，请诊断并修复。

## 应用描述
${app.description ?? "(none)"}

## 失败现场（run ${run.id}）
- 参数文件: ${dir}/params.json
- 退出码非 0
- 错误输出（截断）:
${failure.slice(0, 4000)}

## 当前脚本 (${dir}/main.mjs，版本 v${version.version})
\`\`\`js
${version.script.slice(0, 8000)}
\`\`\`

## 红线（最高优先级）
你只能读取运行现场并返回修复后的脚本文本。严禁修改目标站点的任何数据/文件（如 /workspace/site/ 下的页面文件）、
严禁通过改动环境让断言通过（例如改页面内容、改 params.json 期望值）——那是作弊，不是修复。
页面实际内容是什么，脚本的断言就应该正确地反映它。

## 三段式模板契约（必须保持）
脚本分三段：setup()（每次执行：open 等环境准备，浏览器页面状态不跨执行保留）/ steps[]（业务步骤，可断点续跑：
每步成功后写 RPA_CHECKPOINT 环境变量指向的文件 {step:N}，重跑跳过已完成步骤从失败步骤继续）/ teardown()（每次执行：close 清理）。
修复后的 fixed.mjs 必须保持此契约：只修失败步骤的实现（选择器/断言/等待逻辑），不删步骤、不改 checkpoint 读写逻辑；
若失败原因是「跳过的步骤导致环境缺失」（如浏览器无页面），把环境依赖移入 setup()（每次执行）而不是当成可跳过步骤。

## 要求
1. 用 read/grep/glob 读取 ${dir}/main.mjs、${dir}/params.json 和 checkpoint 文件，确认失败发生在哪一步
2. 若涉及页面结构变化，只能使用 agent-browser 的 open/snapshot/get/wait/close 只读命令查看真实页面；禁止 click/fill/eval 等可能产生副作用的命令
3. 修复失败步骤的实现，参数结构不变，仍从 process.argv[2] 读 params.json
4. 不要执行修复脚本：正式验证由 runner 在原运行沙箱、原 checkpoint 上继续执行，避免验证和续跑重复产生业务副作用
5. 成功时严格按以下格式回复；确实无法自动修复时只回复 <CANNOT_FIX>原因</CANNOT_FIX>：
<SUMMARY>简短诊断</SUMMARY>
<FIXED_SCRIPT>完整 ESM 脚本</FIXED_SCRIPT>`

  const repairSession = yield* repair.session
    .create({
      title: `rpa-repair:${app.name}`,
      parentID: runSessionID,
      permission: [
        { permission: "*", pattern: "*", action: "deny" as const },
        ...["read", "grep", "glob", "list"].map((permission) => ({
          permission,
          pattern: "*",
          action: "allow" as const,
        })),
        ...[
          "agent-browser open *",
          "agent-browser snapshot*",
          "agent-browser get *",
          "agent-browser wait *",
          "agent-browser close*",
          "agent-browser --session * open *",
          "agent-browser --session * snapshot*",
          "agent-browser --session * get *",
          "agent-browser --session * wait *",
          "agent-browser --session * close*",
        ].map((pattern) => ({ permission: "bash", pattern, action: "allow" as const })),
        ...["*>*", "*<*", "*|*", "*;*", "*&&*", "*||*", "*$(*", "*`*"].map((pattern) => ({
          permission: "bash",
          pattern,
          action: "deny" as const,
        })),
      ],
    })
    .pipe(
      Effect.catch(() => Effect.succeed(null)),
      Effect.provideService(InstanceRef, repair.instanceRef),
    )
  if (repairSession === null) {
    log.warn("failed to create repair session", { runID: run.id })
    return null
  }
  yield* Effect.promise(() => updateRpaRunIfStatus(run.id, "repairing", { repair_session_id: repairSession.id }))

  const input = {
    sessionID: repairSession.id,
    model: { providerID: repair.model.providerID, modelID: repair.model.modelID },
    parts: [{ type: "text", text: repairPrompt }],
  } as unknown as PromptInput
  const promptEffect = repair.promptFn(input)
  const promptExit = yield* promptEffect.pipe(Effect.provideService(InstanceRef, repair.instanceRef), Effect.exit)

  const repairInfo = yield* repair.session.get(repairSession.id).pipe(Effect.catch(() => Effect.succeed(null)))
  if (repairInfo?.tokens) {
    const tokens =
      repairInfo.tokens.input +
      repairInfo.tokens.output +
      repairInfo.tokens.reasoning +
      repairInfo.tokens.cache.read +
      repairInfo.tokens.cache.write
    yield* Effect.promise(() =>
      updateRpaRunIfStatus(run.id, "repairing", { repair_tokens: run.repair_tokens + tokens }),
    )
  }

  if (promptExit._tag === "Failure") {
    log.warn("repair prompt failed", { runID: run.id, cause: String(promptExit.cause) })
    return null
  }

  const repairParts = (promptExit.value as { parts?: { type: string; text?: string }[] } | undefined)?.parts ?? []
  const response = repairParts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text as string)
    .at(-1)
  const rawFixed = response?.match(/<FIXED_SCRIPT>\s*([\s\S]*?)\s*<\/FIXED_SCRIPT>/)?.[1]?.trim()
  // 剥离 AI 回复中常见的 markdown 代码围栏（```js ... ```）——不剥会把围栏当代码存库，回放必然 TypeError
  const fixed = rawFixed
    ?.replace(/^```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim()
  const summary = response?.match(/<SUMMARY>\s*([\s\S]*?)\s*<\/SUMMARY>/)?.[1]?.trim()
  if (!fixed || fixed.length < 20 || fixed.includes("No such file") || fixed.startsWith("```")) {
    log.warn("repair response missing script", { runID: run.id })
    return null
  }

  yield* sandbox.getOrCreate(runSessionID, { pvcMode: "app", appId: run.app_id })
  const checkPath = `/tmp/rpa-repair-${run.id}.mjs`
  const fixedB64 = Buffer.from(fixed).toString("base64")
  const syntax = yield* sandbox
    .runInSession(
      runSessionID,
      `echo ${fixedB64} | base64 -d > ${checkPath} && node --check ${checkPath}; rm -f ${checkPath}`,
      {
        timeoutSeconds: 30,
      },
    )
    .pipe(Effect.exit)
  if (syntax._tag === "Failure" || syntax.value.exitCode !== 0) {
    // 语法不过时把语法错误回填到 run，便于外部看到修复失败的真实原因（而非静默 null）
    const syntaxErr =
      syntax._tag === "Success" ? joinLogs(syntax.value.logs?.stderr).slice(0, 500) : String(syntax.cause)
    log.warn("repaired script failed syntax validation", { runID: run.id, syntaxErr })
    yield* Effect.promise(() =>
      updateRpaRunIfStatus(run.id, "repairing", {
        error: `repaired script failed syntax check: ${syntaxErr}`,
      }),
    ).pipe(Effect.ignore)
    return null
  }

  const appID = run.app_id
  const versionID = `rpaver_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`
  const candidate = yield* Effect.promise(() =>
    insertNextRpaVersion({
      id: versionID,
      app_id: appID,
      status: "candidate",
      source: "repair",
      script: fixed,
      manifest: version.manifest,
      note: [
        `auto-repair for run ${run.id} (v${version.version} failed: ${failure.slice(0, 200)})`,
        summary ? `AI: ${summary.slice(0, 400)}` : undefined,
      ]
        .filter(Boolean)
        .join(" | "),
      repair_from_version: version.version,
    }),
  )
  return { id: versionID, version: candidate.version }
})

export * as RpaRunner from "./rpa-runner"
