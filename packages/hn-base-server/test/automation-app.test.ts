import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AutomationApp as A } from "@opencode/schema/automation-app"
import { definition, interpolate, parameters, requiresConfirmation, resolveOperation } from "../src/lib/automation-app"
import { scriptPlan, uniqueShellCommand } from "../src/lib/automation-runtime"

const value: A.Definition = {
  name: "整理报告",
  description: "网页与数据处理",
  parameters: [{ key: "query", label: "关键词", required: true, defaultValue: "" }],
  steps: [
    {
      id: "one",
      title: "打开页面",
      operation: { type: "browser", action: "navigate", value: "https://example.com?q={{query}}" },
    },
    { id: "two", title: "整理数据", operation: { type: "script", runtime: "python", source: "print('ok')" } },
  ],
}

describe("自动化应用契约与验证", () => {
  test("网页和脚本可组合，缺省可选属性不会编码为 undefined", () => {
    expect(definition(value)).toEqual(value)
    const encoded = Schema.encodeSync(A.BrowserOperation)({
      type: "browser",
      action: "navigate",
      value: "https://example.com",
    })
    expect(Object.hasOwn(encoded, "selector")).toBe(false)
    expect(Schema.toJsonSchemaDocument(A.Definition).schema).toBeDefined()
  })
  test("业务阶段保留在定义中，旧应用兼容且拒绝空名称", () => {
    const staged = { ...value, steps: value.steps.map((step) => ({ ...step, businessStage: "查询并整理订单" })) }
    expect(definition(staged)).toEqual(staged)
    expect(Object.hasOwn(Schema.encodeSync(A.Step)(value.steps[0]!), "businessStage")).toBe(false)
    expect(() => definition({ ...value, steps: [{ ...value.steps[0], businessStage: " " }] })).toThrow()
  })
  test("拒绝无效、重复、未定义参数和任意能力类型", () => {
    for (const patch of [
      { steps: [] },
      { name: " " },
      { parameters: [...value.parameters, ...value.parameters] },
      { steps: [...value.steps, value.steps[0]] },
      { steps: [{ ...value.steps[0], operation: { type: "connector", action: "send" } }] },
      {
        steps: [
          { ...value.steps[0], operation: { type: "browser", action: "fill", selector: "{{query}}", value: "a" } },
        ],
      },
      {
        steps: [
          { ...value.steps[0], operation: { type: "browser", action: "fill", selector: "#q", value: "{{unknown}}" } },
        ],
      },
      { steps: [{ ...value.steps[0], operation: { type: "script", runtime: "python", source: "" } }] },
    ])
      expect(() => definition({ ...value, ...patch })).toThrow()
  })
  test("运行参数校验、不递归替换、脚本不插值", () => {
    expect(() => parameters(value, {})).toThrow()
    expect(() => parameters(value, { query: "a", extra: "b" })).toThrow()
    expect(parameters(value, { query: "中文" })).toEqual({ query: "中文" })
    expect(interpolate("{{query}}", { query: "{{unknown}}" })).toBe("{{unknown}}")
    expect(() => interpolate("{{query}}", {})).toThrow()
    const script = { type: "script", runtime: "python", source: "print('{{query}}')" } as const
    expect(resolveOperation(script, { query: "unsafe" })).toBe(script)
  })
  test("运行时地址不能变成 file/javascript 或带凭据的 URL", () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "https://user:pass@example.com", "bad"])
      expect(() => resolveOperation({ type: "browser", action: "navigate", value: "{{url}}" }, { url })).toThrow()
    expect(
      resolveOperation({ type: "browser", action: "navigate", value: "{{url}}" }, { url: "https://example.com" }),
    ).toMatchObject({ value: "https://example.com" })
  })
  test("点击和脚本必须确认；参数、源代码不拼入 shell", () => {
    expect(requiresConfirmation({ type: "browser", action: "click", selector: "#send" })).toBe(true)
    expect(requiresConfirmation({ type: "browser", action: "extract", selector: "h1" })).toBe(false)
    const operation = { type: "script", runtime: "python", source: "print('源代码')" } as const
    expect(requiresConfirmation(operation)).toBe(true)
    const { command, setup } = scriptPlan(operation, { value: "'; touch /tmp/injected; #" }, "run_1")
    expect(command).not.toContain("touch /tmp/injected")
    expect(command).not.toContain(operation.source)
    expect(setup.every((line) => line.length < 3200)).toBe(true)
    expect(uniqueShellCommand(setup[0]!)).not.toBe(uniqueShellCommand(setup[0]!))
    expect(() => scriptPlan(operation, {}, "../bad")).toThrow()
  })
})
