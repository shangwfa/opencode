import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { Effect } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Agent } from "@opencode/schema/agent"
import { Tool } from "@opencode/schema/tool"
import { budgets, prefix, protocolVersion, versionHash } from "../src/session/tool-host-protocol"
import { consume, rpc, type Connection } from "../src/session/tool-sandbox"

let root: string
let process: ChildProcess
let connection: Connection
let sequence = 0
const context = (id: string, progress: (update: unknown) => void = () => {}, sessionID = "ses_test"): Tool.Context => ({
  sessionID: Session.ID.make(sessionID),
  agent: Agent.ID.make("build"),
  messageID: SessionMessage.ID.make("msg_test"),
  id: Tool.CallID.make(id),
  progress: (update) => Effect.sync(() => progress(update)),
})
const code = `import { tool } from "@opencode-ai/plugin"
let count = 0
export default tool({ description: "stateful", args: {}, async execute(args, context) {
  count++; return { output: "count=" + count + ";cwd=" + context.directory, title: "state" }
} })`

beforeAll(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "session-tool-host-")))
  const directory = path.join(root, "bin")
  await fs.mkdir(directory)
  const entries = [
    ["src/session/tool-host/host.ts", "session-tool-host.mjs"],
    ["src/session/tool-host/worker.ts", "session-tool-worker.mjs"],
    ["src/session/tool-host/runtime.ts", "session-tool-runtime.mjs"],
  ]
  for (const [entry, name] of entries) {
    const result = spawnSync(
      "bun",
      ["build", path.resolve(entry!), "--target=node", "--format=esm", `--outfile=${path.join(directory, name!)}`],
      { encoding: "utf8" },
    )
    if (result.status !== 0) throw new Error(result.stderr)
  }
  const launcher = path.join(directory, "test-host.mjs")
  await fs.writeFile(
    launcher,
    `import {createHost} from './session-tool-host.mjs';const h=createHost({sandboxID:'test',root:${JSON.stringify(root)}});h.server.listen(0,'127.0.0.1',()=>console.log(h.server.address().port));process.on('SIGTERM',()=>h.close().then(()=>process.exit(0)));`,
  )
  process = spawn("node", [launcher], { stdio: ["ignore", "pipe", "pipe"] })
  const port = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host did not start")), 10_000)
    process.stdout!.once("data", (data) => {
      clearTimeout(timer)
      resolve(data.toString().trim())
    })
    process.once("error", reject)
  })
  const endpoint = `127.0.0.1:${port}`
  const health = (await (await fetch(`http://${endpoint}${prefix}health`)).json()) as { hostEpoch: string }
  connection = {
    endpoint,
    envelope: {
      protocolVersion,
      sandboxID: "test",
      hostEpoch: health.hostEpoch,
      ownerID: "owner",
      ownerLeaseID: "",
      logicalSessionID: "ses_test",
      generation: 1,
      lifecycleEpoch: 1,
    },
  }
  const prepared = (await (await rpc(connection, "prepare")).json()) as { ownerLeaseID: string }
  connection.envelope.ownerLeaseID = prepared.ownerLeaseID
}, 30_000)

afterAll(async () => {
  process?.kill("SIGTERM")
  if (process && process.exitCode === null) await new Promise<void>((resolve) => process.once("exit", () => resolve()))
  if (root) await fs.rm(root, { recursive: true, force: true })
})

async function discover(source: string, current = connection) {
  const version = versionHash(source)
  const sourcePath = path.join(
    root,
    ".opencode/.session-tools",
    current.envelope.logicalSessionID,
    version,
    "source.ts",
  )
  await fs.mkdir(path.dirname(sourcePath), { recursive: true })
  await fs.writeFile(sourcePath, source)
  const manifest = (await (await rpc(current, "discover", { versionHash: version, sourcePath })).json()) as {
    versionHash: string
    manifestHash: string
  }
  return { manifest, sourcePath }
}

async function run(
  source: string,
  args: unknown = {},
  progress: (update: unknown) => void = () => {},
  deadlineMs = 5000,
  current = connection,
) {
  await rpc(current, "renew")
  const { manifest, sourcePath } = await discover(source, current)
  const snapshotID = `snapshot_${++sequence}`
  const executionID = `execution_${sequence}`
  await rpc(current, "snapshot-acquire", { snapshotID, manifests: [manifest] })
  try {
    const response = await rpc(current, "execute", {
      snapshotID,
      executionID,
      ...manifest,
      sourcePath,
      args,
      deadlineMs,
      context: { sessionID: current.envelope.logicalSessionID, agent: "build", messageID: "msg_test", id: executionID },
    })
    return await consume(
      current,
      response,
      executionID,
      context(executionID, progress, current.envelope.logicalSessionID),
    )
  } finally {
    await rpc(current, "snapshot-release", { snapshotID })
  }
}

async function prepareSession(sessionID: string, ownerID = "owner") {
  const current: Connection = {
    endpoint: connection.endpoint,
    envelope: { ...connection.envelope, logicalSessionID: sessionID, ownerID, ownerLeaseID: "" },
  }
  const prepared = (await (await rpc(current, "prepare")).json()) as { ownerLeaseID: string }
  current.envelope.ownerLeaseID = prepared.ownerLeaseID
  return current
}

describe("Session Tool Sandbox supervisor", () => {
  test("loads once, preserves module state, and runs in workspace", async () => {
    expect((await run(code)).output).toBe(`count=1;cwd=${root}`)
    expect((await run(code)).output).toBe(`count=2;cwd=${root}`)
  })
  test("upsert creates a new immutable version while the old module stays available", async () => {
    expect((await run(code.replace("count=", "new="))).output).toBe(`new=1;cwd=${root}`)
    expect((await run(code)).output).toBe(`count=3;cwd=${root}`)
  })
  test("concurrent first discovery reuses one module instance", async () => {
    const source = `let count=0;export default {description:'concurrent initialization',args:{},async execute(){await new Promise(r=>setTimeout(r,10));return String(++count)}}`
    const results = await Promise.all([run(source), run(source)])
    expect(results.map((result) => result.output).sort()).toEqual(["1", "2"])
  })
  test("progress Effect round trips and title maps to metadata", async () => {
    const updates: unknown[] = []
    const result = await run(
      `import {Effect} from 'effect';export default {description:'progress',args:{},async execute(args,context){await Effect.runPromise(context.progress({phase:'done'}));return {title:'Complete',output:'ok'}}}`,
      {},
      (update) => updates.push(update),
    )
    expect(updates).toEqual([{ phase: "done" }])
    expect(result.metadata?.title).toBe("Complete")
    expect(result.output).toBe("ok")
  })
  test("module and execute errors do not break healthy tools", async () => {
    await expect(discover("export default {foo:1}")).rejects.toThrow("invalid tool export")
    await expect(run("export default {description:'crash',args:{},execute(){throw Error('boom')}}")).rejects.toThrow(
      "boom",
    )
    expect((await run(code)).output).toContain("count=")
  })
  test("terminates a synchronous endless execute and can execute next turn", async () => {
    await expect(
      run("export default {description:'loop',args:{},execute(){while(true){}}}", {}, undefined, 100),
    ).rejects.toThrow("deadline")
    expect((await run(code)).output).toContain("cwd=")
  })
  test("cancel before execute creates a tombstone", async () => {
    await rpc(connection, "cancel", { executionID: "cancel-first" })
    await expect(rpc(connection, "execute", { executionID: "cancel-first" })).rejects.toThrow("cancelled")
  })
  test("codec input transformation and output encoding happen in worker", async () => {
    const result = await run(
      `import {Schema} from 'effect';export default {description:'codec',input:Schema.NumberFromString,output:Schema.Number,execute(args){return args+1}}`,
      "41",
    )
    expect(result.output).toBe(42)
  })
  test("large directories exceed worker capacity without blocking manifest discovery", async () => {
    for (let i = 0; i < budgets.workers + 2; i++)
      await discover(`export default {description:'version-${i}',args:{},execute(){return '${i}'}}`)
    expect((await run(code)).output).toContain("count=1")
  }, 30_000)
  test("shared Sandbox keeps logical session module state isolated", async () => {
    const parent = await prepareSession("ses_parent")
    const child = await prepareSession("ses_child")
    expect((await run(code, {}, undefined, 5000, parent)).output).toContain("count=1")
    expect((await run(code, {}, undefined, 5000, child)).output).toContain("count=1")
    await rpc(child, "release", { scope: "session" })
    await expect(rpc(child, "prepare")).rejects.toThrow("closed")
    expect((await run(code, {}, undefined, 5000, parent)).output).toContain("count=2")
  })
  test("unsupported Standard Schema stays a discovery failure", async () => {
    await expect(
      discover(
        `export default {description:'unsupported',input:{'~standard':{version:1,vendor:'unsupported',validate(value){return {value}}}},execute(){return 'ok'}}`,
      ),
    ).rejects.toThrow("does not support JSON Schema")
  })
  test("progress failure is acknowledged and reaches the original tool execution", async () => {
    await expect(
      run(
        `import {Effect} from 'effect';export default {description:'failed progress',args:{},async execute(a,c){await Effect.runPromise(c.progress({phase:'fail'}));return 'unexpected'}}`,
        {},
        () => {
          throw new Error("progress projection failed")
        },
      ),
    ).rejects.toThrow("progress projection failed")
  })
  test("worker context includes a local AbortSignal", async () => {
    expect(
      (
        await run(
          `export default {description:'signal',args:{},execute(args,context){return String(context.signal instanceof AbortSignal && !context.signal.aborted)}}`,
        )
      ).output,
    ).toBe("true")
  })
  test("duplicate execution IDs never replay side effects", async () => {
    const { manifest, sourcePath } = await discover(code)
    const snapshotID = `once-${++sequence}`
    const executionID = `once-${sequence}`
    await rpc(connection, "snapshot-acquire", { snapshotID, manifests: [manifest] })
    const input = { snapshotID, executionID, ...manifest, sourcePath, args: {}, context: {} }
    const response = await rpc(connection, "execute", input)
    const result = await consume(connection, response, executionID, context(executionID))
    await expect(rpc(connection, "execute", input)).rejects.toThrow("Duplicate execution")
    const status = (await (await rpc(connection, "status", { executionID })).json()) as {
      state: string
      terminal: { result: unknown }
    }
    expect(status.state).toBe("completed")
    expect(status.terminal.result).toEqual(result)
    await rpc(connection, "snapshot-release", { snapshotID })
  })
})
