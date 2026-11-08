import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm"
import { check } from "../../authz/index.js"
import { db, pool } from "../../db/index.js"
import {
  instructionApp as apps,
  instructionDraft as drafts,
  instructionRun as runs,
} from "../../db/schema.js"
import { writeAudit } from "../../lib/audit.js"
import { contentHash } from "./contract.js"
import { regenerateInstructionDefinition } from "./draft.js"
import { pollProgress, readSessionFile, runVerificationPath, sendInstructionPrompt } from "./runtime.js"
type Run = typeof runs.$inferSelect

/** 单次执行的最长观察时间；超时只暂停观察，不重放动作。 */
const OBSERVE_TIMEOUT_MS = Number(process.env.INSTRUCTION_RUN_TIMEOUT_MS ?? 2 * 60 * 60 * 1000)

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/**
 * 指令应用执行器。
 *
 * - 每条指令单独一轮：当前步骤完成后才派发下一步，步骤状态逐步落库。
 * - 恢复观察时不会重复派发当前步骤，避免重复副作用。
 * - 执行错误时自动重生成应用定义，但不会自动重跑。
 */
export async function processInstructionRun(id: string) {
  const client = await pool.connect()
  let locked = false
  try {
    const result = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [`instruction:${id}`])
    locked = result.rows[0]?.locked === true
    if (!locked) return
    const [run] = await db.select().from(runs).where(eq(runs.id, id))
    if (!run) return
    if (run.status === "regenerating") return await regenerate(run)
    if (run.status === "queued") return await dispatch(run)
    if (run.status === "running") return await observe(run)
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`instruction:${id}`]).catch(() => undefined)
    client.release()
  }
}

/** 步骤状态：pending 未开始、running 执行中、succeeded 已完成、failed 失败。 */
function initialSteps(definition: Run["definition"]): Run["steps"] {
  return definition.instructions.map((instruction, index) => ({
    index,
    title: instruction.title,
    promptId: null,
    status: "pending" as const,
    output: null,
  }))
}

async function dispatch(run: Run) {
  const steps = initialSteps(run.definition)
  const first = steps[0]
  if (!first) return fail(run.id, "应用没有可执行的步骤")
  const promptId = `msg_${crypto.randomUUID().replaceAll("-", "")}`
  steps[0] = { ...first, promptId, status: "running" }
  // 先原子认领，确保只有一个实例发送提示词，避免重复执行副作用。
  const [claimed] = await db
    .update(runs)
    .set({ status: "running", promptId, steps, timeUpdated: Date.now() })
    .where(and(eq(runs.id, run.id), eq(runs.status, "queued")))
    .returning()
  if (!claimed) return
  const permitted = await check(db, {
    subject: { type: "user", id: run.ownerId },
    permission: "run",
    object: { type: "session", id: run.sessionId },
  })
  if (!permitted) return fail(run.id, "会话执行权限已失效")
  await sendStep(claimed, 0, promptId)
}

/** 派发第 index 步；失败只暂停观察，不重放已派发的动作。 */
async function sendStep(run: Run, index: number, promptId: string) {
  const instruction = run.definition.instructions[index]
  if (!instruction) return
  try {
    await sendInstructionPrompt(
      run.sessionId,
      run.definition,
      instruction,
      index,
      run.definition.instructions.length,
      run.parameters,
      promptId,
      run.id,
    )
  } catch (error) {
    // 网络错误不能证明上游未收到请求，只能恢复观察，不能重新派发。
    await db
      .update(runs)
      .set({ status: "paused", error: `第 ${index + 1} 步派发结果不确定：${message(error)}\n\n请核实；恢复只会继续观察，不会重发本步。`, timeUpdated: Date.now() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
  }
}

async function observe(run: Run) {
  if (!run.promptId) {
    await db
      .update(runs)
      .set({ status: "paused", error: "派发状态不确定，请核实，不要重试。", timeUpdated: Date.now() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    return
  }
  let progress
  try {
    progress = await pollProgress(run.sessionId, run.promptId, run.timeCreated)
  } catch (error) {
    // 只恢复观察，不重新派发；避免网络失败后重复执行。
    await db
      .update(runs)
      .set({ status: "paused", error: `${message(error)}\n\n执行可能仍在进行，恢复只会继续观察，不会重发指令。`, timeUpdated: Date.now() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    return
  }
  if (progress.state === "pending") {
    if (Date.now() - run.timeUpdated > OBSERVE_TIMEOUT_MS)
      await db
        .update(runs)
        .set({ status: "paused", error: "执行时间过长，已暂停观察。请核实当前进度后恢复观察或结束运行。", timeUpdated: Date.now() })
        .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    return
  }
  if (progress.state === "succeeded") {
    // 当前步骤完成：落库该步结果，并派发下一步（若有）。
    const current = run.steps.findIndex((step) => step.promptId === run.promptId)
    const steps = run.steps.map((step, index) =>
      index === current ? { ...step, status: "succeeded" as const, output: progress.output } : step,
    )
    const nextIndex = current + 1
    const next = steps[nextIndex]
    if (next) {
      const promptId = `msg_${crypto.randomUUID().replaceAll("-", "")}`
      steps[nextIndex] = { ...next, promptId, status: "running" }
      // 以 promptId 作为并发守卫：旧步骤的观察者不会再推进同一步。
      const [advanced] = await db
        .update(runs)
        .set({ steps, promptId, timeUpdated: Date.now() })
        .where(and(eq(runs.id, run.id), eq(runs.status, "running"), eq(runs.promptId, run.promptId!)))
        .returning()
      if (!advanced) return
      await sendStep(advanced, nextIndex, promptId)
      return
    }
    // 全部步骤完成：模型回合完成不等于业务结果正确；有产物约定时必须校验，避免“写完文本就算成功”。
    const verification = run.definition.verification
    if (verification) {
      let content: string | null = null
      try {
        content = await readSessionFile(run.sessionId, runVerificationPath(run.id, verification.path))
      } catch {
        content = null
      }
      const passed = content !== null && (!verification.contains || content.includes(verification.contains))
      if (!passed) {
        await db
          .update(runs)
          .set({
            status: "failed",
            steps,
            error: `结果校验未通过：${content === null ? `未找到 ${verification.path}` : `${verification.path} 未包含预期内容`}，未自动重试。`,
            timeUpdated: Date.now(),
          })
          .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
        return
      }
    }
    const output = steps
      .map((step) => (step.output ? `【${step.title}】\n${step.output}` : ""))
      .filter(Boolean)
      .join("\n\n")
    await db
      .update(runs)
      .set({ status: "succeeded", steps, output: output || progress.output, error: null, timeUpdated: Date.now() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    return
  }
  if (progress.interrupted) {
    // 用户主动中断不是应用缺陷：结束运行，但不自动重生成，也不重放。
    await db
      .update(runs)
      .set({ status: "failed", error: `${progress.error}，如需继续请重新运行。`, timeUpdated: Date.now() })
      .where(and(eq(runs.id, run.id), eq(runs.status, "running")))
    return
  }
  const current = run.steps.findIndex((step) => step.promptId === run.promptId)
  const failedTitle = current >= 0 ? run.steps[current]?.title : undefined
  const steps = run.steps.map((step, index) =>
    index === current ? { ...step, status: "failed" as const } : step,
  )
  const [claimed] = await db
    .update(runs)
    .set({ status: "regenerating", steps, error: `${failedTitle ? `第 ${current + 1} 步「${failedTitle}」失败：` : ""}${progress.error}`, timeUpdated: Date.now() })
    .where(and(eq(runs.id, run.id), eq(runs.status, "running"), eq(runs.promptId, run.promptId!)))
    .returning()
  if (claimed) await regenerate(claimed)
}

async function regenerate(run: Run) {
  try {
    const definition = await regenerateInstructionDefinition(
      run.definition,
      { error: run.error ?? "执行失败", output: run.output },
      run.definition.model,
    )
    let version: number | null = null
    if (run.appId) {
      // 正式应用不可被未验证的修复覆盖；修订必须另存草稿并重新测试。
      const [app] = await db.select({ version: apps.version }).from(apps).where(and(eq(apps.id, run.appId), eq(apps.version, run.appVersion)))
      if (app) {
        const now = Date.now()
        await db.insert(drafts).values({ id: `idraft_${crypto.randomUUID()}`, ownerId: run.ownerId, sessionId: run.sessionId, definition, version: 1, contentHash: contentHash(definition), timeCreated: now, timeUpdated: now })
        version = 1
      }
    } else if (run.draftId) {
      const [updated] = await db
        .update(drafts)
        .set({
          definition,
          version: sql`${drafts.version} + 1`,
          contentHash: contentHash(definition),
          timeUpdated: Date.now(),
        })
        .where(and(eq(drafts.id, run.draftId), eq(drafts.version, run.appVersion), isNull(drafts.publishedAppId)))
        .returning({ version: drafts.version })
      version = updated?.version ?? null
    }
    const note = version
      ? `已根据错误生成待审核草稿 v${version}，请在会话中审阅并重新测试；正式应用未被覆盖。`
      : "应用已有新版本或已发布，未自动覆盖，请人工检查。"
    await finish(run.id, run.error ?? "执行失败", version, note)
    await writeAudit({
      actorType: "system",
      actorId: run.ownerId,
      action: "instruction.regenerate",
      resourceType: run.appId ? "instruction_app" : "instruction_draft",
      resourceId: run.appId ?? run.draftId ?? run.id,
      metadata: { runId: run.id, version },
    })
  } catch (error) {
    await finish(run.id, run.error ?? "执行失败", null, `自动重新生成失败：${message(error)}`)
  }
}

async function finish(id: string, original: string, version: number | null, note: string) {
  await db
    .update(runs)
    .set({ status: "failed", regeneratedVersion: version, error: `${original}\n\n${note}`, timeUpdated: Date.now() })
    .where(and(eq(runs.id, id), eq(runs.status, "regenerating")))
}

async function fail(id: string, error: string) {
  await db
    .update(runs)
    .set({ status: "failed", error, timeUpdated: Date.now() })
    .where(and(eq(runs.id, id), eq(runs.status, "running")))
}

export function startInstructionWorker() {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const pending = await db
        .select({ id: runs.id })
        .from(runs)
        .where(inArray(runs.status, ["queued", "running", "regenerating"]))
        .orderBy(asc(runs.timeUpdated))
        .limit(9)
      for (let offset = 0; offset < pending.length; offset += 3) {
        await Promise.all(
          pending.slice(offset, offset + 3).map(async (run) => {
            try {
              await processInstructionRun(run.id)
            } catch (error) {
              console.error("[instruction]", run.id, message(error))
            }
          }),
        )
      }
    } finally {
      busy = false
    }
  }
  const timer = setInterval(() => void tick().catch(console.error), 1000)
  timer.unref()
  return () => clearInterval(timer)
}
