/**
 * E2E Scenario: Node.js 项目脚手架
 *
 * 模拟真实 Agent 工作流：一个 Session 中顺序使用 6 个工具完成一个可运行的 Node.js 项目。
 * 所有操作必须在同一个 Sandbox 中完成，验证 Session ↔ Sandbox 1:1 绑定。
 *
 * 流程（工具调用顺序）：
 *   1. write  — 创建 package.json
 *   2. write  — 创建 index.js
 *   3. write  — 创建 README.md
 *   4. read   — 读回 package.json 确认写入成功
 *   5. edit   — 修改 index.js，把 "Hello" 换成 "Hello Sandbox"
 *   6. glob   — 找所有 .js / .json / .md 文件
 *   7. grep   — 在项目里搜 "Sandbox" 关键字
 *   8. bash   — node index.js 运行项目
 *
 * Usage:
 *   OPENCODE_SANDBOX_IMAGE=opensandbox/code-interpreter-rg bun run test/tool/scenario-nodejs-scaffold.ts
 *
 * PG 模式（同时验证数据库落库）:
 *   OPENCODE_DATABASE_URL=postgresql://postgres:postgres@localhost:5432/opencode_test \
 *   OPENCODE_SANDBOX_IMAGE=opensandbox/code-interpreter-rg bun run test/tool/scenario-nodejs-scaffold.ts
 */
import { Effect, Layer, ManagedRuntime } from "effect"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { BashTool } from "../../src/tool/bash"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { Truncate } from "../../src/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { Plugin } from "../../src/plugin"
import { AppFileSystem } from "@opencode-ai/shared/filesystem"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Ripgrep } from "../../src/file/ripgrep"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { LSP } from "../../src/lsp"
import { FileTime } from "../../src/file/time"
import { FileWatcher } from "../../src/file/watcher"
import { Bus } from "../../src/bus"
import { Format } from "../../src/format"
import { Instruction } from "../../src/session/instruction"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import { Instance } from "../../src/project/instance"
import { Sandbox } from "@alibaba-group/opensandbox"
import { Database } from "../../src/storage/db"
import { ProjectTable } from "../../src/project/project.sql"
import { SessionTable, MessageTable, PartTable } from "../../src/session/session.sql"
import { eq } from "drizzle-orm"

const TEST_IMAGE = process.env["OPENCODE_SANDBOX_IMAGE"] || "opensandbox/code-interpreter-rg"
const PG_MODE = !!process.env["OPENCODE_DATABASE_URL"]
const SESSION_ID = SessionID.make("ses_scenario_" + Date.now())
const PROJECT_ID = "proj_scenario_" + Date.now()
let callSeq = 0

async function persist(toolName: string, args: any, result: any, msgID: MessageID) {
  if (!PG_MODE) return
  const partID = PartID.make(`part_${toolName}_${++callSeq}`)
  await Database.use(async (db: any) => {
    await db.insert(PartTable).values({
      id: partID,
      message_id: msgID,
      session_id: SESSION_ID,
      time_created: Date.now(),
      time_updated: Date.now(),
      data: {
        type: "tool-invocation",
        toolName,
        toolCallId: `call_${callSeq}`,
        state: "result",
        args,
        result: typeof result === "string" ? result : JSON.stringify(result),
      },
    })
  })
}

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Ripgrep.defaultLayer,
    SandboxProvider.defaultLayer,
    LSP.defaultLayer,
    FileTime.defaultLayer,
    FileWatcher.defaultLayer,
    Bus.layer,
    Format.defaultLayer,
    Instruction.defaultLayer,
  ),
)

function makeCtx(sb: Sandbox) {
  return {
    sessionID: SESSION_ID,
    messageID: MessageID.make("msg_scenario"),
    agent: "scenario-agent",
    abort: AbortSignal.any([]),
    callID: "call_scenario",
    messages: [] as any[],
    metadata: () => Effect.void,
    ask: () => Effect.void,
    sandbox: Promise.resolve(sb) as Promise<any>,
  }
}

function runEffect(effect: any): Promise<any> {
  return runtime.runPromise(Effect.scoped(effect) as any)
}

async function initTools() {
  return Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const init = (tool: any) =>
        runtime.runPromise(Effect.scoped(tool.pipe(Effect.flatMap((info: any) => info.init()))) as any)
      return {
        bash: await init(BashTool),
        write: await init(WriteTool),
        read: await init(ReadTool),
        edit: await init(EditTool),
        glob: await init(GlobTool),
        grep: await init(GrepTool),
      }
    },
  })
}

function section(title: string) {
  console.log()
  console.log(`━━━ ${title} ━━━`)
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`  ❌ ${msg}`)
    throw new Error(`Assertion failed: ${msg}`)
  }
  console.log(`  ✅ ${msg}`)
}

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = performance.now()
  const result = await fn()
  const elapsed = performance.now() - start
  console.log(`  ⏱  ${label}: ${elapsed.toFixed(1)}ms`)
  return result
}

// ── Scenario ──

console.log("╔══════════════════════════════════════════════════════════════╗")
console.log("║   Scenario: Node.js 项目脚手架 — Session ↔ Sandbox 绑定       ║")
console.log("╚══════════════════════════════════════════════════════════════╝")
console.log(`Session: ${SESSION_ID}  |  Image: ${TEST_IMAGE}  |  PG: ${PG_MODE ? "ON" : "OFF"}`)

const MSG_USER = MessageID.make("msg_user_" + Date.now())
const MSG_AGENT = MessageID.make("msg_agent_" + Date.now())

if (PG_MODE) {
  section("Step -1: PG 初始化 — 建表 + 插入 Session/Message")
  await Database.initialize()
  const now = Date.now()
  await Database.use(async (db: any) => {
    const existing = await db.select().from(ProjectTable).where(eq(ProjectTable.id, PROJECT_ID))
    if (existing.length === 0) {
      await db.insert(ProjectTable).values({
        id: PROJECT_ID,
        worktree: process.cwd(),
        sandboxes: [],
        time_created: now,
        time_updated: now,
      })
    }
    await db.insert(SessionTable).values({
      id: SESSION_ID,
      project_id: PROJECT_ID,
      slug: "nodejs-scaffold",
      directory: process.cwd(),
      title: "Node.js 项目脚手架 E2E",
      version: "1.0.0",
      time_created: now,
      time_updated: now,
    })
    await db.insert(MessageTable).values({
      id: MSG_USER,
      session_id: SESSION_ID,
      time_created: now,
      time_updated: now,
      data: { role: "user", content: "创建一个 Node.js 项目脚手架，包含 package.json、index.js、README.md" },
    })
    await db.insert(MessageTable).values({
      id: MSG_AGENT,
      session_id: SESSION_ID,
      time_created: now + 1,
      time_updated: now + 1,
      data: { role: "assistant", content: "好的，我来创建项目文件。" },
    })
  })
  console.log("  ✅ PG: project + session + 2 messages 已插入")
}

section("Step 0: 获取 Sandbox（懒创建）")

const sb = await time("SandboxProvider.getOrCreate", () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      return yield* provider.getOrCreate(SESSION_ID)
    }) as any,
  ),
)
console.log(`  📦 Sandbox ID: ${sb.id}`)

const tools = await initTools()
const ctx = makeCtx(sb)

try {
  // ── Step 1-3: write ── ───────────────────────────────────────
  section("Step 1-3: write — 创建 3 个文件")

  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const packageJson = JSON.stringify({
        name: "sandbox-demo",
        version: "1.0.0",
        main: "index.js",
        scripts: { start: "node index.js" },
      }, null, 2)

      const indexJs = `const msg = "Hello from Node.js"
console.log(msg)
console.log("Running in:", process.cwd())
`

      const readme = `# Sandbox Demo

This is a demo Node.js project running inside OpenSandbox.
`

      const r1 = await time("write package.json", () =>
        runEffect(tools.write.execute({ filePath: "package.json", content: packageJson }, ctx)),
      )
      assert(r1.output.includes("Wrote file successfully"), "package.json 写入成功")
      await persist("write", { filePath: "package.json", content: packageJson }, r1.output, MSG_AGENT)

      const r2 = await time("write index.js", () =>
        runEffect(tools.write.execute({ filePath: "index.js", content: indexJs }, ctx)),
      )
      assert(r2.output.includes("Wrote file successfully"), "index.js 写入成功")
      await persist("write", { filePath: "index.js", content: indexJs }, r2.output, MSG_AGENT)

      const r3 = await time("write README.md", () =>
        runEffect(tools.write.execute({ filePath: "README.md", content: readme }, ctx)),
      )
      assert(r3.output.includes("Wrote file successfully"), "README.md 写入成功")
      await persist("write", { filePath: "README.md", content: readme }, r3.output, MSG_AGENT)
    },
  })

  // ── Step 4: read ── ───────────────────────────────────────────
  section("Step 4: read — 读回 package.json")

  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const r = await time("read package.json", () =>
        runEffect(tools.read.execute({ filePath: "package.json" }, ctx)),
      )
      assert(r.output.includes("sandbox-demo"), "读到 name: sandbox-demo")
      assert(r.output.includes(`"main": "index.js"`), "读到 main: index.js")
      await persist("read", { filePath: "package.json" }, r.output, MSG_AGENT)
    },
  })

  // ── Step 5: edit ── ───────────────────────────────────────────
  section("Step 5: edit — 修改 index.js")

  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      await runEffect(tools.read.execute({ filePath: "index.js" }, ctx))

      const r = await time("edit index.js", () =>
        runEffect(tools.edit.execute({
          filePath: "index.js",
          oldString: "Hello from Node.js",
          newString: "Hello Sandbox from Node.js",
        }, ctx)),
      )
      assert(r.output.includes("Edit applied"), "edit 应用成功")
      await persist("edit", { filePath: "index.js", oldString: "Hello from Node.js", newString: "Hello Sandbox from Node.js" }, r.output, MSG_AGENT)

      const verify: any = await runEffect(tools.read.execute({ filePath: "index.js" }, ctx))
      assert(verify.output.includes("Hello Sandbox from Node.js"), "edit 后读到新内容")
    },
  })

  // ── Step 6: glob ── ───────────────────────────────────────────
  section("Step 6: glob — 列出项目文件")

  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const r: any = await time("glob *.{js,json,md}", () =>
        runEffect(tools.glob.execute({ pattern: "*", path: "." }, ctx)),
      )
      console.log(`  📂 找到 ${r.metadata.count} 个文件`)
      assert(r.output.includes("package.json"), "glob 找到 package.json")
      assert(r.output.includes("index.js"), "glob 找到 index.js")
      assert(r.output.includes("README.md"), "glob 找到 README.md")
      await persist("glob", { pattern: "*", path: "." }, r.output, MSG_AGENT)
    },
  })

  // ── Step 7: grep ── ───────────────────────────────────────────
  section("Step 7: grep — 搜索关键字 Sandbox")

  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const r: any = await time("grep 'Sandbox'", () =>
        runEffect(tools.grep.execute({ pattern: "Sandbox", path: "." }, ctx)),
      )
      console.log(`  🔍 ${r.metadata.matches} 处匹配`)
      assert(r.output.includes("index.js"), "grep 命中 index.js")
      assert(r.output.includes("README.md"), "grep 命中 README.md")
      assert(r.output.includes("Hello Sandbox"), "grep 输出包含 edit 后内容")
      await persist("grep", { pattern: "Sandbox", path: "." }, r.output, MSG_AGENT)
    },
  })

  // ── Step 8: bash ── ───────────────────────────────────────────
  section("Step 8: bash — 运行 node index.js")

  await Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const r: any = await time("bash node index.js", () =>
        runEffect(tools.bash.execute({
          command: "node index.js",
          description: "run node project",
          timeout: 15000,
        }, ctx)),
      )
      console.log(`  📤 stdout:\n${r.output.split("\n").map((l: string) => "      " + l).join("\n")}`)
      assert(r.metadata.exit === 0, "node 进程 exit code === 0")
      assert(r.output.includes("Hello Sandbox from Node.js"), "bash 输出 edit 后内容")
      assert(r.output.includes("/workspace"), "bash 显示 process.cwd() === /workspace")
      await persist("bash", { command: "node index.js", description: "run node project" }, r.output, MSG_AGENT)
    },
  })

  // ── Session ↔ Sandbox 绑定验证 ───────────────────────────────
  section("绑定验证: 第二次 getOrCreate 必须返回同一个 Sandbox")

  const sb2 = await runtime.runPromise(
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      return yield* provider.getOrCreate(SESSION_ID)
    }) as any,
  )
  assert(sb2.id === sb.id, `Session ${SESSION_ID} 绑定同一个 Sandbox: ${sb.id}`)

  if (PG_MODE) {
    section("PG 验证: 查询落库数据")

    const rows = await Database.use(async (db: any) => {
      const sessions = await db.select().from(SessionTable).where(eq(SessionTable.id, SESSION_ID))
      const messages = await db.select().from(MessageTable).where(eq(MessageTable.session_id, SESSION_ID))
      const parts = await db.select().from(PartTable).where(eq(PartTable.session_id, SESSION_ID))
      return { sessions, messages, parts }
    })

    assert(rows.sessions.length === 1, `session 表有 1 行 (实际 ${rows.sessions.length})`)
    assert(rows.sessions[0].title === "Node.js 项目脚手架 E2E", `session title 正确`)
    assert(rows.messages.length === 2, `message 表有 2 行 (实际 ${rows.messages.length})`)
    assert(rows.messages[0].data.role === "user", `第一条 message 是 user`)

    const toolNames = rows.parts.map((p: any) => p.data.toolName)
    console.log(`  📊 part 表 ${rows.parts.length} 行, 工具: [${toolNames.join(", ")}]`)
    assert(rows.parts.length === 8, `part 表有 8 行 — 8 次工具调用 (实际 ${rows.parts.length})`)
    assert(toolNames.filter((n: string) => n === "write").length === 3, "3 次 write")
    assert(toolNames.includes("read"), "包含 read")
    assert(toolNames.includes("edit"), "包含 edit")
    assert(toolNames.includes("glob"), "包含 glob")
    assert(toolNames.includes("grep"), "包含 grep")
    assert(toolNames.includes("bash"), "包含 bash")

    for (const part of rows.parts) {
      assert(part.data.state === "result", `${part.data.toolName} part state === result`)
      assert(!!part.data.result, `${part.data.toolName} part result 非空`)
    }

    section("PG psql 交叉验证")
    const { execSync } = require("child_process")
    const count = (table: string, col = "session_id") =>
      parseInt(execSync(
        `docker exec ai-nova-postgres psql -U postgres -d opencode_test -t -c "SELECT COUNT(*) FROM ${table} WHERE ${col} = '${SESSION_ID}'"`,
        { encoding: "utf-8" },
      ).trim(), 10)

    const sc = count("session", "id")
    const mc = count("message")
    const pc = count("part")
    console.log(`  📊 psql: session=${sc}, message=${mc}, part=${pc}`)
    assert(sc === 1, "psql session=1")
    assert(mc === 2, "psql message=2")
    assert(pc === 8, "psql part=8")
  }

  console.log()
  console.log("╔══════════════════════════════════════════════════════════════╗")
  console.log("║                       ✅ ALL PASSED                          ║")
  console.log("╚══════════════════════════════════════════════════════════════╝")
} finally {
  section("清理: 销毁 Sandbox")
  await runtime.runPromise(
    Effect.gen(function* () {
      const provider = yield* SandboxProvider.Service
      return yield* provider.destroy(SESSION_ID)
    }) as any,
  )
  await runtime.dispose()
  if (PG_MODE) await Database.close()
}
