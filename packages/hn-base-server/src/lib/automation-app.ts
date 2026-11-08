import { Schema } from "effect"
import { AutomationApp as A } from "@opencode/schema/automation-app"
import { errors } from "./errors.js"
import { nameAndDescription, parameters as parameterRules, resolveParameters, resources as resourceRules, verificationPath } from "../automation/shared/validation.js"

export function definition(input: unknown): A.Definition {
  let value: A.Definition
  try {
    value = Schema.decodeUnknownSync(A.Definition)(input)
  } catch {
    throw errors.invalid("应用定义格式不正确")
  }
  nameAndDescription(value.name, value.description)
  if (!value.steps.length || value.steps.length > 100)
    throw errors.invalid("应用需要 1–100 个步骤")
  resourceRules(value.resources)
  if (value.verification && (!verificationPath(value.verification.path) || (value.verification.contains?.length ?? 0) > 2000))
    throw errors.invalid("结果校验路径或内容无效")
  const keys = parameterRules(value.parameters),
    ids = new Set<string>()
  for (const step of value.steps) {
    if (!step.id || step.id.length > 80 || ids.has(step.id) || !step.title.trim() || step.title.length > 300)
      throw errors.invalid("步骤名称无效或编号重复")
    if (step.businessStage !== undefined && (!step.businessStage.trim() || step.businessStage.length > 300))
      throw errors.invalid("业务阶段名称无效")
    ids.add(step.id)
    const operation = step.operation
    if (operation.type === "script") {
      if (!operation.source.trim() || Buffer.byteLength(operation.source) > 128 * 1024)
        throw errors.invalid("数据处理脚本不能为空，且不能超过 128 KiB")
      continue
    }
    if (operation.selector?.includes("{{")) throw errors.invalid("元素定位不能包含运行参数")
    if (operation.action !== "navigate" && (!operation.selector?.trim() || operation.selector.length > 2000))
      throw errors.invalid("步骤缺少元素定位")
    if ((operation.action === "navigate" || operation.action === "fill") && operation.value === undefined)
      throw errors.invalid("步骤缺少地址或填写内容")
    for (const text of [operation.value, operation.selector]) {
      if (text && text.length > 8000) throw errors.invalid("步骤内容过长")
      if (text?.replace(/\{\{[^{}]+\}\}/g, "").includes("{{") || text?.replace(/\{\{[^{}]+\}\}/g, "").includes("}}"))
        throw errors.invalid("参数引用格式无效")
      for (const match of (text ?? "").matchAll(/\{\{([^{}]+)\}\}/g)) {
        if (!keys.has(match[1]!)) throw errors.invalid(`未定义的参数：${match[1]}`)
      }
    }
  }
  return value
}

export function parameters(app: A.Definition, input: Record<string, string>) {
  return resolveParameters(app.parameters, input)
}

export function interpolate(text: string, values: Readonly<Record<string, string>>) {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_, key: string) => {
    if (!Object.hasOwn(values, key)) throw errors.invalid(`缺少参数：${key}`)
    return values[key]!
  })
}

export function resolveOperation(operation: A.Operation, values: Readonly<Record<string, string>>): A.Operation {
  if (operation.type === "script") return operation
  // 参数只允许进入值，不拼接 CSS，避免参数变成选择器注入。
  if (operation.selector?.includes("{{")) throw errors.invalid("元素定位不能包含运行参数")
  const value = operation.value === undefined ? undefined : interpolate(operation.value, values)
  if (operation.action === "navigate") {
    let url: URL
    try {
      url = new URL(value!)
    } catch {
      throw errors.invalid("页面地址无效")
    }
    if (!/^https?:$/.test(url.protocol) || url.username || url.password)
      throw errors.invalid("仅支持无凭据的 HTTP/HTTPS 页面")
  }
  return { ...operation, ...(value === undefined ? {} : { value }) }
}

/** 所有点击都先确认：不能靠 AI 或按钮文案可靠判断是否付款、删除或发送。 */
export function requiresConfirmation(operation: A.Operation) {
  return operation.type === "script" || operation.action === "click"
}
