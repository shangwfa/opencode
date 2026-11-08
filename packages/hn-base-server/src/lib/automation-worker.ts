import { asc, eq, inArray } from "drizzle-orm"
import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { db, pool } from "../db/index.js"
import { automationRun as runs } from "../db/schema.js"
import { browserUpstream, startBrowser } from "./browser-cdp.js"
import { automationTarget, ElementUnavailable, executeStep, pageSnapshot } from "./browser-automation-cdp.js"
import { repairSelector } from "./automation-ai.js"
import { requiresConfirmation, resolveOperation } from "./automation-app.js"
import { executeScript, ScriptFailed, VerificationFailed, verifyAutomationOutput } from "./automation-runtime.js"
import { check } from "../authz/index.js"
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { repairScript } from "./automation-ai.js"
import { applyVerifiedRepair } from "./automation-repair.js"

/**
 * 异步修复：worker 生成方案后回到「待审核」，不自动执行、不修改应用。
 * 只有持有运行锁的实例能写回，避免多 Pod 覆盖。
 */
async function completeRepair(lockedDb: NodePgDatabase, run: typeof runs.$inferSelect) {
  const current = run.results[run.cursor]
  const step = run.definition.steps[run.cursor]
  if (!current || !step || step.operation.type !== "script") {
    await lockedDb
      .update(runs)
      .set({ status: "failed", error: "修复目标已丢失，请重新运行", timeUpdated: Date.now() })
      .where(eq(runs.id, run.id))
    return
  }
  const results = [...run.results]
  try {
    const operation = await repairScript(
      { ...step, operation: current.repairedOperation ?? step.operation },
      current.error ?? "",
      run.definition.model,
    )
    results[run.cursor] = {
      ...current,
      repairedOperation: operation,
      pauseReason: "repair_review",
      error: "已生成此步骤的修复方案。上次执行可能产生部分结果，请先核实，再审核脚本并确认执行",
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 修复失败"
    results[run.cursor] = { ...current, pauseReason: "failed", error: `修复未完成：${message}` }
  }
  await lockedDb
    .update(runs)
    .set({ status: "paused", results, error: results[run.cursor]!.error, timeUpdated: Date.now() })
    .where(eq(runs.id, run.id))
}

export async function processAutomationRun(id: string) {
  const client = await pool.connect()
  // 检查点写入必须使用持锁连接；连接断开后旧 worker 不能通过另一连接覆盖新状态。
  const lockedDb = drizzle(client)
  let locked = false,
    disconnected = false
  const lost = () => {
    disconnected = true
  }
  client.on("error", lost)
  try {
    // PG 会话锁随连接断开释放；所有 pod 使用同一个锁，不依赖进程内归属。
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked", [
      `automation:${id}`,
    ])
    locked = lock.rows[0]?.locked === true
    if (!locked) return
    const [run] = await lockedDb.select().from(runs).where(eq(runs.id, id))
    if (!run) return
    if (run.status === "repairing") {
      await completeRepair(lockedDb, run)
      return
    }
    if (!["queued", "running"].includes(run.status)) return
    const results: A.StepResult[] = [...run.results]
    const save = async (patch: Partial<typeof runs.$inferInsert>) => {
      if (disconnected) throw new Error("运行锁连接中断")
      await lockedDb
        .update(runs)
        .set({ ...patch, timeUpdated: Date.now() })
        .where(eq(runs.id, id))
    }
    let current = results[run.cursor]
    const original = run.definition.steps[run.cursor]
    if (!original) {
      await save({ status: "succeeded", error: null })
      return
    }
    const pause = async (reason: NonNullable<A.StepResult["pauseReason"]>, error: string) => {
      results[run.cursor] = {
        ...(current ?? { stepId: original.id, repairAttempts: 0 }),
        status: "paused",
        approved: false,
        pauseReason: reason,
        error,
      }
      await save({ status: "paused", results, error })
    }
    // 派发后崩溃即视作结果不确定，不自动重放任何动作。
    if (current?.status === "running") {
      await pause("uncertain", "执行连接中断，请核实本步骤是否已经完成；确认前不会重放")
      return
    }
    try {
      const permitted = await check(db, {
        subject: { type: "user", id: run.ownerId },
        permission: "run",
        object: { type: "session", id: run.sessionId },
      })
      if (!permitted) {
        await pause("failed", "会话执行权限已失效")
        return
      }
      const operation = resolveOperation(current?.repairedOperation ?? original.operation, run.parameters)
      if (requiresConfirmation(operation) && !current?.approved) {
        await pause(
          "confirmation",
          operation.type === "script"
            ? "将执行固定的数据处理脚本，可能读写当前会话文件，请确认"
            : "点击可能产生外部影响，请检查页面并确认",
        )
        return
      }
      let target: string | undefined
      if (operation.type === "browser") {
        if (run.targetId) {
          try {
            const probe = await browserUpstream(`/api/session/${encodeURIComponent(run.sessionId)}/proxy/9222/json/version`, undefined, 3000)
            const version = await probe.json() as { Browser?: unknown; webSocketDebuggerUrl?: unknown }
            if (typeof version.Browser !== "string" || typeof version.webSocketDebuggerUrl !== "string") throw new Error("浏览器网关未就绪")
          } catch {
            await startBrowser(run.sessionId)
          }
        } else await startBrowser(run.sessionId)
        target = run.targetId ?? (await automationTarget(run.sessionId))
        if (!run.targetId) await save({ targetId: target })
      }
      current = {
        stepId: original.id,
        status: "running",
        approved: false,
        repairAttempts: current?.repairAttempts ?? 0,
        ...(current?.repairedOperation ? { repairedOperation: current.repairedOperation } : {}),
      }
      results[run.cursor] = current
      await save({ status: "running", results, error: null })
      if (disconnected) throw new Error("运行锁连接中断")
      let output: string
      try {
        output =
          operation.type === "script"
            ? await executeScript(
                run.sessionId,
                operation,
                run.parameters,
                `${run.id}_${run.cursor}_${crypto.randomUUID()}`,
                 results,
                 run.definition.resources,
                 run.id,
              )
            : await executeStep(run.sessionId, target!, operation)
      } catch (error) {
        if (error instanceof ScriptFailed && operation.type === "script" && current.repairAttempts < 2) {
          results[run.cursor] = {
            ...current, status: "paused", approved: false, repairAttempts: current.repairAttempts + 1,
            pauseReason: "repair_running", error: error.message,
          }
          await save({ status: "repairing", results, error: "步骤执行失败，正在生成修复方案；请核实是否产生部分结果" })
          return
        }
        if (
          !(error instanceof ElementUnavailable) ||
          operation.type !== "browser" ||
          !target ||
          current.repairAttempts >= 2
        )
          throw error
        // 仅定位失败、尚未派发的浏览器动作可自动修复；不重放结果不确定的副作用。
        current = { ...current, repairAttempts: current.repairAttempts + 1 }
        results[run.cursor] = current
        await save({ results })
        const selector = await repairSelector(original, await pageSnapshot(run.sessionId, target), run.definition.model)
        const repaired: A.BrowserOperation = { ...operation, selector }
        // 保存模板值而非本轮已填参数的值，避免更新应用时固定住本轮参数。
        if (original.operation.type !== "browser") throw new Error("步骤类型不匹配")
        current = { ...current, repairedOperation: { ...original.operation, selector } }
        results[run.cursor] = current
        await save({ results })
        if (operation.action === "click") {
          await pause("repair_review", "已找到新的点击目标，请检查页面并再次确认")
          return
        }
        if (disconnected) throw new Error("运行锁连接中断")
        output = await executeStep(run.sessionId, target, repaired)
      }
      current = { ...current, status: "succeeded", output }
      results[run.cursor] = current
      const finished = run.cursor + 1 === run.definition.steps.length
      if (finished && run.definition.verification)
        await verifyAutomationOutput(run.sessionId, run.id, run.definition.verification)
      await save({
        results,
        cursor: run.cursor + 1,
        status: finished ? "succeeded" : "queued",
      })
      // 已发布应用的修复经重跑验证成功后自动固化为新版本；跳过或未完成步骤不会保存。
      if (finished && run.appId) {
        await applyVerifiedRepair({ ...run, results, status: "succeeded" }).catch((error) =>
          console.error("[automation] 自动保存修复失败", run.id, error instanceof Error ? error.message : error),
        )
      }
    } catch (error) {
      await pause(
        error instanceof ElementUnavailable || error instanceof VerificationFailed ? "failed" : "uncertain",
        error instanceof Error ? error.message : String(error),
      )
    }
  } finally {
    try {
      if (locked && !disconnected)
        await client.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [`automation:${id}`])
    } finally {
      client.off("error", lost)
      client.release(disconnected)
    }
  }
}

export function startAutomationWorker() {
  let busy = false
  const tick = async () => {
    if (busy) return
    busy = true
    try {
      const pending = await db
        .select({ id: runs.id })
        .from(runs)
        .where(inArray(runs.status, ["queued", "running", "repairing"]))
        .orderBy(asc(runs.timeUpdated))
        .limit(12)
      // 限制并发，避免等待 SaaS 的工作占满 PG 连接池。
      for (let offset = 0; offset < pending.length; offset += 3) {
        await Promise.all(
          pending.slice(offset, offset + 3).map(async (run) => {
            try {
              await processAutomationRun(run.id)
            } catch (error) {
              console.error("[automation]", run.id, error instanceof Error ? error.message : error)
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
