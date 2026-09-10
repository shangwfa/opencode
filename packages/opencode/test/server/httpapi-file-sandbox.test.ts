import { afterAll, describe, expect, mock, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { mkdtemp } from "node:fs/promises"
import os from "os"
import path from "path"
import { tmpdir } from "../fixture/fixture"

// 沙箱分支依赖 OPENCODE_SANDBOX_ENABLED（import 时求值），必须在加载被测链路前
// 用 mock.module 覆盖（先例：test/mcp/session-mcp.test.ts）。
import * as RealFlag from "@opencode-ai/core/flag/flag"
mock.module("@opencode-ai/core/flag/flag", () => ({
  ...RealFlag,
  Flag: { ...RealFlag.Flag, OPENCODE_SANDBOX_ENABLED: true },
}))

// webHandler 是模块级单例且 memoMap 缓存 Service 实例，defaultLayer 的 mock
// 必须在 server.ts 首次加载前生效。server.ts 经 "@/tool/sandbox-provider" 别名
// import，handlers 经同一别名——相对路径与别名两个 specifier 都要 mock。
// 两个用例共享同一个 provider 实例，行为通过 active 切换。
import * as RealSP from "../../src/tool/sandbox-provider"

type Calls = {
  runDetached: Array<{ sid: string; command: string }>
  runInSession: Array<{ sid: string; command: string }>
  getOrCreate: string[]
}

const active: {
  calls: Calls
  detached: (command: string) => Effect.Effect<any, Error>
} = {
  calls: { runDetached: [], runInSession: [], getOrCreate: [] },
  detached: () => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 0 }),
}

const spMockModule = {
  ...RealSP,
  SandboxProvider: {
    ...RealSP.SandboxProvider,
    defaultLayer: Layer.succeed(
      RealSP.SandboxProvider.Service,
      RealSP.SandboxProvider.Service.of({
        getOrCreate: (sid: string) => {
          active.calls.getOrCreate.push(sid)
          return Effect.succeed({ id: "sb_mock" } as never)
        },
        get: () => Effect.succeed(null),
        runDetached: (sid: string, command: string) => {
          active.calls.runDetached.push({ sid, command })
          return active.detached(command)
        },
        runInSession: (sid: string, command: string) => {
          active.calls.runInSession.push({ sid, command })
          return Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 0 } as never)
        },
      } as any),
    ),
  },
}
mock.module("../../src/tool/sandbox-provider", () => spMockModule)
mock.module("@/tool/sandbox-provider", () => spMockModule)

// 被测链路（server.ts → fileHandlers）必须在 mock.module 之后加载
const { HttpApiApp } = await import("../../src/server/routes/instance/httpapi/server")
const { FilePaths } = await import("../../src/server/routes/instance/httpapi/groups/file")

const context = Context.empty() as Context.Context<unknown>
const sid = "ses_file_sandbox_test" as never

function listRequest(directory: string) {
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${FilePaths.list}?sessionID=${sid}&directory=${encodeURIComponent(directory)}&path=`, {
      headers: { "x-opencode-directory": directory },
    }),
    context,
  )
}

// webHandler 是模块级单例（memoMap 缓存 Service 实例）。若本文件与其他
// import server.ts 的测试同批运行且对方先加载，mock 无法生效——用探针请求
// 检测（mock 生效时 runDetached 调用会落在 active.calls），未生效则 skip
// 本文件（单文件运行即完整覆盖）。
const probeOk = await (async () => {
  active.calls = { runDetached: [], runInSession: [], getOrCreate: [] }
  active.detached = () => Effect.succeed({ logs: { stdout: [], stderr: [] }, exitCode: 0 })
  await listRequest(await mkdtemp(path.join(os.tmpdir(), "oc-probe-"))).catch(() => undefined)
  return active.calls.runDetached.length > 0
})()
if (!probeOk) console.log("skip: server.ts already loaded by another test file; run this file standalone")

const it = test.if(probeOk)

// 恢复被 mock 的模块，避免污染同进程后续测试文件
afterAll(() => {
  mock.module("@opencode-ai/core/flag/flag", () => RealFlag)
  mock.module("../../src/tool/sandbox-provider", () => RealSP)
  mock.module("@/tool/sandbox-provider", () => RealSP)
})

describe("file.list sandbox branch (httpapi)", () => {
  it("lists entries via runDetached, bypassing the command queue", async () => {
    await using tmp = await tmpdir()
    active.calls = { runDetached: [], runInSession: [], getOrCreate: [] }
    active.detached = () =>
      Effect.succeed({
        logs: { stdout: [{ text: "src/\npackage.json\n" }], stderr: [] },
        exitCode: 0,
      })

    const res = await listRequest(tmp.path)

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual([
      expect.objectContaining({ name: "package.json", path: "package.json", type: "file" }),
      expect.objectContaining({ name: "src", path: "src", type: "directory" }),
    ])
    // 核心回归点：列目录走独立 session 通道，不碰被长命令独占的串行队列，
    // 也不再显式 getOrCreate（runDetached 内部自管沙箱）
    expect(active.calls.runDetached).toHaveLength(1)
    expect(active.calls.runDetached[0]!.command).toContain('ls -1ap "/workspace"')
    expect(active.calls.runInSession).toHaveLength(0)
    expect(active.calls.getOrCreate).toHaveLength(0)
  })

  it("returns 503 ServiceUnavailableError instead of dieing when sandbox command fails", async () => {
    await using tmp = await tmpdir()
    active.calls = { runDetached: [], runInSession: [], getOrCreate: [] }
    active.detached = () => Effect.fail(new Error("command queue wait timed out after 15s"))

    const res = await listRequest(tmp.path)

    // 修复前：Effect.orDie 把失败变 defect → 500 无信息
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toMatchObject({ message: expect.stringContaining("command queue wait timed out") })
  })
})
