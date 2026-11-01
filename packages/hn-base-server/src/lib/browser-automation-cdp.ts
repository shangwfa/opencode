import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { browserUpstream, connectCdp } from "./browser-cdp.js"
import { z } from "zod"

export class ElementUnavailable extends Error {}
const CommandResult = z.object({
  errorText: z.string().optional(),
  exceptionDetails: z.unknown().optional(),
  result: z.object({ value: z.unknown() }).optional(),
})

export async function automationTarget(sessionId: string) {
  const response = await browserUpstream(`/api/session/${encodeURIComponent(sessionId)}/proxy/9222/json/list`)
  const targets = z.array(z.object({ id: z.string(), type: z.string(), url: z.string() })).parse(await response.json())
  const target =
    targets.find((t) => t.type === "page" && /^https?:/.test(t.url)) ?? targets.find((t) => t.type === "page")
  if (!target) throw new Error("浏览器中没有可用页面")
  return target.id
}

// 仅供固定执行器内部使用，不扩大公开 CDP 接口的白名单。
async function command(sessionId: string, target: string, method: string, params: Record<string, unknown>) {
  const ws = await connectCdp(sessionId, target, AbortSignal.timeout(15_000))
  try {
    return await new Promise<z.infer<typeof CommandResult>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("浏览器操作超时，结果可能不确定")), 15_000)
      const finish = (error?: Error, result?: z.infer<typeof CommandResult>) => {
        clearTimeout(timer)
        error ? reject(error) : resolve(result ?? {})
      }
      ws.once("close", () => finish(new Error("浏览器连接中断，结果可能不确定")))
      ws.once("error", (error) => finish(error))
      ws.on("message", (data) => {
        try {
          const message = JSON.parse(String(data))
          if (message.id !== 1) return
          if (message.error) finish(new Error(String(message.error.message)))
          else finish(undefined, CommandResult.parse(message.result))
      } catch {
        finish(new Error("浏览器协议响应无效，结果可能不确定"))
      }
      })
      ws.send(JSON.stringify({ id: 1, method, params }))
    })
  } finally {
    ws.close()
  }
}

async function evaluate(sessionId: string, target: string, expression: string) {
  const result = await command(sessionId, target, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (result.exceptionDetails) throw new Error("页面操作失败，结果可能不确定")
  return result.result?.value
}

export const PAGE_ACTION = String.raw`(input) => {
  let matches
  try { matches = document.querySelectorAll(input.selector) } catch { return { missing: true, error: "元素定位无效" } }
  if (input.action === "extract" && input.selector === "title") {
    if (matches.length !== 1) return { missing: true, error: "页面标题不存在或不唯一" }
    return { output: (matches[0].textContent ?? "").slice(0, 32_000) }
  }
  const visible = Array.from(matches).filter((el) => el.getClientRects().length > 0)
  if (visible.length !== 1) return { missing: true, error: visible.length ? "元素定位不唯一" : "未找到可见元素" }
  const element = visible[0]
  if (element.matches(":disabled, [aria-disabled=true]")) return { missing: true, error: "元素不可操作" }
  if (input.action === "fill") {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement))
      return { missing: true, error: "目标不是文本输入框" }
    if (element instanceof HTMLInputElement && !["text", "search", "email", "url", "tel", "number", "password"].includes(element.type))
      return { missing: true, error: "不支持此输入类型" }
    const prototype = element instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype
    const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set
    if (!setter || element.readOnly) return { missing: true, error: "输入框不可填写" }
    setter.call(element, input.value ?? "")
    element.dispatchEvent(new Event("input", { bubbles: true }))
    element.dispatchEvent(new Event("change", { bubbles: true }))
  } else if (input.action === "click") element.click()
  return { output: input.action === "extract" ? (element.innerText ?? element.textContent ?? "").slice(0, 32_000) : "已完成" }
}`

export async function executeStep(sessionId: string, target: string, step: A.BrowserOperation): Promise<string> {
  if (step.action === "navigate") {
    const result = await command(sessionId, target, "Page.navigate", { url: step.value })
    if (result.errorText) throw new Error(`打开页面失败：${result.errorText}`)
    return step.value!
  }
  const deadline = Date.now() + 10_000
  while (true) {
    const result = z
      .object({ missing: z.boolean().optional(), error: z.string().optional(), output: z.string().optional() })
      .parse(
        await evaluate(
          sessionId,
          target,
          `(${PAGE_ACTION})(${JSON.stringify({ action: step.action, selector: step.selector, value: step.value })})`,
        ),
      )
    if (!result?.missing) return String(result?.output ?? "已完成")
    if (Date.now() >= deadline) throw new ElementUnavailable(result.error)
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export async function pageSnapshot(sessionId: string, target: string): Promise<string> {
  return String(
    await evaluate(
      sessionId,
      target,
      `JSON.stringify({url:location.href,title:document.title,elements:Array.from(document.querySelectorAll('a,button,input,textarea,select,[role],h1,h2,h3,p,table')).filter(e=>e.getClientRects().length).slice(0,150).map(e=>({tag:e.tagName,id:e.id,role:e.getAttribute('role'),name:e.getAttribute('name'),type:e.getAttribute('type'),label:e.getAttribute('aria-label'),text:(e.textContent||'').slice(0,160)}))})`,
    ),
  ).slice(0, 24_000)
}
