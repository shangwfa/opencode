import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { saasRunShell } from "./saas.js"
import { randomBytes } from "node:crypto"

export class ScriptFailed extends Error {}

// 唯一命令标识避免 SaaS shell 历史回放把旧结果误认作本次上传。
export function uniqueShellCommand(command: string) {
  return `${command} # automation-${randomBytes(12).toString("hex")}`
}

/** 参数以独立 JSON 环境变量传入，不拼进 shell 或脚本源代码。 */
export function scriptPlan(
  operation: A.ScriptOperation,
  values: Readonly<Record<string, string>>,
  executionId: string,
  results: readonly A.StepResult[] = [],
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(executionId)) throw new Error("执行编号无效")
  const root = `/workspace/.automation/${executionId}`
  const setup = [`mkdir -p ${root} /workspace/output`]
  const files = {
    source: operation.source,
    input: JSON.stringify(values),
    results: JSON.stringify(
      Object.fromEntries(results.filter((r) => r.status === "succeeded").map((r) => [r.stepId, r.output ?? ""])),
    ),
  }
  for (const [name, text] of Object.entries(files)) {
    const encoded = Buffer.from(text).toString("base64")
    for (let offset = 0; offset < encoded.length; offset += 3000)
      setup.push(`printf '%s' '${encoded.slice(offset, offset + 3000)}' ${offset ? ">>" : ">"} ${root}/${name}.b64`)
  }
  // shell 从 SaaS 转发到会话沙箱；此处不在基础服务上执行任何用户代码。
  const bootstrap = `import base64,os,pathlib,subprocess,sys,signal
root=pathlib.Path('${root}')
path=root/'step.${operation.runtime === "python" ? "py" : "js"}'
path.write_bytes(base64.b64decode((root/'source.b64').read_bytes()))
data=root/'results.json'
data.write_bytes(base64.b64decode((root/'results.b64').read_bytes()))
env=dict(os.environ,AUTOMATION_INPUT=base64.b64decode((root/'input.b64').read_bytes()).decode(),AUTOMATION_RESULTS_PATH=str(data))
process=subprocess.Popen(['${operation.runtime === "python" ? "python3" : "node"}',str(path)],cwd='/workspace',env=env,start_new_session=True)
try:
  code=process.wait(timeout=60)
except subprocess.TimeoutExpired:
  os.killpg(process.pid,signal.SIGKILL)
  process.wait()
  print('步骤超时，已终止进程；请核实是否产生部分结果',file=sys.stderr)
  code=124
sys.exit(code)`
  return {
    setup,
    command: `python3 -c 'exec(__import__("base64").b64decode("${Buffer.from(bootstrap).toString("base64")}"))'`,
  }
}

export async function executeScript(
  sessionId: string,
  operation: A.ScriptOperation,
  values: Readonly<Record<string, string>>,
  executionId: string,
  results: readonly A.StepResult[],
) {
  const plan = scriptPlan(operation, values, executionId, results)
  for (const command of plan.setup) {
    const uploaded = await saasRunShell(sessionId, uniqueShellCommand(command))
    if (uploaded.exit !== 0) throw new Error("无法准备此步骤的固定脚本和输入")
  }
  const result = await saasRunShell(sessionId, plan.command)
  if (result.exit !== 0) {
    const message = `数据处理未完成（退出码 ${result.exit}），请核实是否产生部分结果。\n${result.output.slice(-6000)}`
    if (result.exit !== 124 && Number.isInteger(result.exit)) throw new ScriptFailed(message)
    throw new Error(message)
  }
  return result.output.slice(-32_000) || "数据处理已完成，产物可在会话文件中查看"
}
