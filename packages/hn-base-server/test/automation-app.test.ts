import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { AutomationApp as A } from "@opencode/schema/automation-app"
import { definition, interpolate, parameters, requiresConfirmation, resolveOperation } from "../src/lib/automation-app"
import { scriptPlan, uniqueShellCommand } from "../src/lib/automation-runtime"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"

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
  test("文本资源可保存，并拒绝危险路径、冲突及超限", () => {
    const resources = [{ path: "lib/helper.py", content: "print('你好')" }]
    expect(definition({ ...value, resources }).resources).toEqual(resources)
    for (const bad of [
      [{ path: "../escape", content: "" }], [{ path: "/absolute", content: "" }],
      [{ path: ".env", content: "" }], [{ path: "secret.pem", content: "" }],
      [resources[0], resources[0]], [{ path: "lib", content: "" }, resources[0]],
      [{ path: "huge", content: "x".repeat(65537) }],
      Array.from({ length: 33 }, (_, i) => ({ path: `file${i}`, content: "" })),
    ]) expect(() => definition({ ...value, resources: bad })).toThrow()
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
    const resource = { path: "lib/helper.py", content: "敏感 ' $(touch injected)" }
    const plan = scriptPlan(operation, {}, "run_2", [], [resource])
    expect(plan.setup.join("\n")).not.toContain(resource.content)
    expect(plan.setup.join("\n")).toContain(Buffer.from(JSON.stringify([resource])).toString("base64"))
  })
  test("运行计划将多文件资源还原到独立目录并传给脚本", () => {
    const temp = mkdtempSync(join(tmpdir(), "automation-assets-"))
    try {
      const operation = { type: "script", runtime: "python", source: "import os,pathlib\np=pathlib.Path(os.environ['AUTOMATION_ASSETS_DIR'])\nprint((p/'lib'/'helper.txt').read_text())" } as const
      const plan = scriptPlan(operation, {}, "test_run", [], [{ path: "lib/helper.txt", content: "你好 ' $()" }])
      const replace = (text: string) => text.replaceAll("/workspace/.automation/test_run", `${temp}/run`).replaceAll("/workspace/output", `${temp}/output`)
      for (const command of plan.setup) execFileSync("sh", ["-c", replace(command)])
      const encoded = plan.command.match(/b64decode\("([^"]+)"\)/)?.[1]
      expect(encoded).toBeDefined()
      const bootstrap = replace(Buffer.from(encoded!, "base64").toString()).replace("cwd='/workspace'", `cwd='${temp}'`)
      expect(execFileSync("python3", ["-c", bootstrap], { encoding: "utf8" }).trim()).toBe("你好 ' $()")
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  })
  /** 本地按 sandbox 布局执行一步脚本，返回 stdout。 */
  function runScript(operation: A.ScriptOperation, input: Record<string, string>, results: A.StepResult[] = []) {
    const temp = mkdtempSync(join(tmpdir(), "automation-run-"))
    try {
      const plan = scriptPlan(operation, input, "test_run", results)
      const replace = (text: string) => text.replaceAll("/workspace/.automation/test_run", `${temp}/run`).replaceAll("/workspace/output", `${temp}/output`)
      for (const command of plan.setup) execFileSync("sh", ["-c", replace(command)])
      const encoded = plan.command.match(/b64decode\("([^"]+)"\)/)?.[1]
      if (!encoded) throw new Error("缺少引导程序")
      const bootstrap = replace(Buffer.from(encoded, "base64").toString()).replace("cwd='/workspace'", `cwd='${temp}'`)
      return execFileSync("python3", ["-c", bootstrap], { encoding: "utf8" }).trim()
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  // 实测缺陷：AI 生成的 JS 脚本用顶层 return 返回数据，执行器只捕获 stdout 导致后续步骤拿不到结果。
  test("JS 顶层 return 的结果也会写入 stdout，后续步骤可解析", () => {
    const compute = runScript({ type: "script", runtime: "javascript", source: "return { product: 42 }" }, {})
    expect(compute).toBe('{"product":42}')
    const report = runScript(
      { type: "script", runtime: "javascript", source: "const fs=require('fs');const r=JSON.parse(fs.readFileSync(process.env.AUTOMATION_RESULTS_PATH,'utf8'));console.log(JSON.stringify({result:JSON.parse(r.compute).product}))" },
      {},
      [{ stepId: "compute", status: "succeeded", repairAttempts: 0, output: compute }],
    )
    expect(report).toBe('{"result":42}')
    // 已用 console.log 的脚本不会被重复输出
    expect(runScript({ type: "script", runtime: "javascript", source: "console.log('only')" }, {})).toBe("only")
  })
  test("Python 脚本仍按 stdout 原样输出", () => {
    expect(runScript({ type: "script", runtime: "python", source: "import json,os\nprint(json.dumps({'v':json.loads(os.environ['AUTOMATION_INPUT'])['a']}))" }, { a: "9" })).toBe('{"v": "9"}')
  })
})
