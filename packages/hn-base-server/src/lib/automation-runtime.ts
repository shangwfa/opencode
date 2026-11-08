import type { AutomationApp as A } from "@opencode/schema/automation-app"
import { saasFetch, saasRunShell } from "./saas.js"
import { randomBytes } from "node:crypto"

export class ScriptFailed extends Error {}
export class VerificationFailed extends Error {}

/** 只核对本次运行的独立产物目录，不接受工作区里的上次运行遗留文件。 */
export async function verifyAutomationOutput(sessionId: string, runId: string, verification: A.Verification) {
  if (!/^arun_[a-zA-Z0-9-]+$/.test(runId)) throw new VerificationFailed("运行编号无效")
  const path = `output/automation/${runId}/${verification.path}`
  const response = await saasFetch(`/api/session/${encodeURIComponent(sessionId)}/fs/read/${path.split("/").map(encodeURIComponent).join("/")}`)
  if (!response.ok || !response.body) throw new VerificationFailed(`结果校验未通过：未找到本次产物 ${verification.path}`)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 1024 * 1024) throw new VerificationFailed("结果校验文件超过 1 MiB，请缩小校验文件")
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (verification.contains && !Buffer.concat(chunks).toString("utf8").includes(verification.contains))
    throw new VerificationFailed(`结果校验未通过：${verification.path} 不包含预期内容`)
}

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
  resources: readonly A.Resource[] = [],
  runId = executionId,
) {
  if (!/^[a-zA-Z0-9_-]+$/.test(executionId)) throw new Error("执行编号无效")
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error("运行编号无效")
  const root = `/workspace/.automation/${executionId}`
  const output = `/workspace/output/automation/${runId}`
  const setup = [`mkdir -p ${root} ${output}`]
  const isPython = operation.runtime === "python"
  // JS 兜底：把脚本包进函数执行，捕获顶层 return 的值并打印。
  // Node 的 CommonJS 顶层 return 会静默结束模块、stdout 为空，导致下一步拿不到数据。
  const runner = `const fs=require('fs'),path=require('path'),{createRequire}=require('module');
const file=process.env.STEP_SOURCE;
const src=fs.readFileSync(file,'utf8').replace(/^#!.*\\n/,'');
const req=createRequire(file);
const mod={exports:{}};
const fn=new Function('exports','require','module','__filename','__dirname',src+'\\n');
const value=fn.call(mod.exports,mod.exports,req,mod,file,path.dirname(file));
if(value!==undefined)console.log(typeof value==='string'?value:JSON.stringify(value));`
  const files = {
    source: operation.source,
    ...(isPython ? {} : { runner }),
    input: JSON.stringify(values),
    resources: JSON.stringify(resources),
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
  const bootstrap = `import base64,json,os,pathlib,subprocess,sys,signal
root=pathlib.Path('${root}')
assets=root/'assets'
assets.mkdir(exist_ok=False)
for resource in json.loads(base64.b64decode((root/'resources.b64').read_bytes())):
  relative=pathlib.PurePosixPath(resource['path'])
  if relative.is_absolute() or any(part in ('.','..') for part in relative.parts): raise ValueError('invalid resource path')
  target=assets.joinpath(*relative.parts)
  target.parent.mkdir(parents=True,exist_ok=True)
  with target.open('x',encoding='utf-8') as file: file.write(resource['content'])
path=root/'step.${isPython ? "py" : "js"}'
path.write_bytes(base64.b64decode((root/'source.b64').read_bytes()))
data=root/'results.json'
data.write_bytes(base64.b64decode((root/'results.b64').read_bytes()))
env=dict(os.environ,AUTOMATION_INPUT=base64.b64decode((root/'input.b64').read_bytes()).decode(),AUTOMATION_RESULTS_PATH=str(data),AUTOMATION_ASSETS_DIR=str(assets),AUTOMATION_OUTPUT_DIR='${output}')
${isPython
  ? "argv=['python3',str(path)]"
  : `runner=root/'runner.js'
runner.write_bytes(base64.b64decode((root/'runner.b64').read_bytes()))
argv=['node',str(runner)]`}
process=subprocess.Popen(argv,cwd='/workspace',env=dict(env,STEP_SOURCE=str(path)),start_new_session=True)
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
  resources: readonly A.Resource[] = [],
  runId = executionId,
) {
  const plan = scriptPlan(operation, values, executionId, results, resources, runId)
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
