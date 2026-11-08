import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { errors } from "../../lib/errors.js"

/**
 * 两类自动化应用（固定动作 / 业务指令）共用的定义约束。
 * 只包含纯粹的数据校验，不依赖数据库、HTTP 或执行器。
 */

export function nameAndDescription(name: string, description: string) {
  if (!name.trim() || name.length > 120 || description.length > 4000)
    throw errors.invalid("应用名称或说明超出限制")
}

/** 固定流程与旧指令共用的安全产物相对路径。 */
export function verificationPath(path: string) {
  const segments = path.split("/")
  return path.length <= 200 && !path.startsWith("/") && segments.every(
    (segment) => segment !== "" && segment !== "." && segment !== ".." && /^[a-zA-Z0-9_.-]{1,100}$/.test(segment),
  )
}

export function parameters(list: readonly A.Parameter[], limit = 30) {
  if (list.length > limit) throw errors.invalid(`最多 ${limit} 个参数`)
  const keys = new Set<string>()
  for (const parameter of list) {
    if (
      !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(parameter.key) ||
      ["constructor", "prototype", "__proto__"].includes(parameter.key) ||
      keys.has(parameter.key) ||
      !parameter.label.trim() ||
      parameter.label.length > 120 ||
      parameter.defaultValue.length > 4000
    )
      throw errors.invalid("参数名称无效或重复")
    keys.add(parameter.key)
  }
  return keys
}

export function resources(list: readonly A.Resource[] | undefined) {
  const paths = new Set<string>()
  let total = 0
  for (const resource of list ?? []) {
    const segments = resource.path.split("/")
    if (
      resource.path.length > 200 ||
      segments.some(
        (segment) => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,99}$/.test(segment) || segment === "." || segment === "..",
      ) ||
      paths.has(resource.path)
    )
      throw errors.invalid("资源路径无效或重复")
    if (
      segments.some((segment) =>
        /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx)|credentials(?:\..*)?|cookies?(?:\..*)?)$/i.test(segment),
      )
    )
      throw errors.invalid("资源不能包含凭据文件")
    paths.add(resource.path)
    total += Buffer.byteLength(resource.content)
    if (Buffer.byteLength(resource.content) > 64 * 1024 || total > 128 * 1024 || paths.size > 32)
      throw errors.invalid("资源超过数量或大小限制")
  }
  for (const path of paths) {
    const segments = path.split("/")
    for (let index = 1; index < segments.length; index++)
      if (paths.has(segments.slice(0, index).join("/"))) throw errors.invalid("资源文件与目录冲突")
  }
}

/** 运行参数：未提供时使用默认值；额外键一律拒绝，避免把隐藏输入带进执行。 */
export function resolveParameters(list: readonly A.Parameter[], input: Record<string, string>) {
  const result: Record<string, string> = {}
  const keys = new Set(list.map((parameter) => parameter.key))
  if (Object.keys(input).some((key) => !keys.has(key))) throw errors.invalid("包含未知参数")
  for (const parameter of list) {
    const value = input[parameter.key] ?? parameter.defaultValue
    if (value.length > 8000 || (parameter.required && !value.trim()))
      throw errors.invalid(`请填写有效的「${parameter.label}」`)
    result[parameter.key] = value
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 24 * 1024) throw errors.invalid("运行参数总量不能超过 24 KiB")
  return result
}
