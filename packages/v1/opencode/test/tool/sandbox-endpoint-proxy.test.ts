/**
 * SandboxProvider.getEndpoint 直连 / OpenSandbox server 网关代理双模式单测。
 * mock @alibaba-group/opensandbox（进程级，须与其他 mock SDK 的测试分进程运行）。
 */
import { beforeEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"
import type { Sandbox } from "@alibaba-group/opensandbox"

type EndpointCall = { id: string; port: number; useServerProxy: boolean | undefined }

const calls = {
  create: 0,
  getEndpointUrl: [] as number[],
  getSandboxEndpoint: [] as EndpointCall[],
}

const fakeSandbox = {
  id: "sbx_test_123",
  commands: {
    run: async () => ({}),
    createSession: async () => "cmd-session-1",
    deleteSession: async () => {},
    interrupt: async () => {},
  },
  kill: async () => {},
  close: async () => {},
  isHealthy: async () => true,
  getEndpointUrl: async (port: number) => {
    calls.getEndpointUrl.push(port)
    return `http://10.0.0.15:${port}`
  },
  sandboxes: {
    getSandboxEndpoint: async (id: string, port: number, useServerProxy?: boolean) => {
      calls.getSandboxEndpoint.push({ id, port, useServerProxy })
      return { endpoint: `gateway.shadow-rpa.net/sandboxes/${id}/port/${port}` }
    },
  },
} as unknown as Sandbox

mock.module("@alibaba-group/opensandbox", () => ({
  Sandbox: {
    create: async () => {
      calls.create += 1
      return fakeSandbox
    },
    connect: async () => fakeSandbox,
  },
  ConnectionConfig: class {
    constructor(public domain?: string) {}
  },
  SandboxApiException: class extends Error {
    statusCode?: number
  },
  SandboxManager: {
    create: () => ({ killSandbox: async () => {}, close: async () => {} }),
  },
}))

// createSandbox 无 opts 时经 resolveSandboxOpts 查 DB；单测直接返回默认 opts
mock.module("@/session/sandbox-opts", () => ({
  resolveSandboxOpts: async (sessionID: string) => ({ id: sessionID, persistMode: "pvc" as const }),
  parseSandboxColumn: () => undefined,
}))

const { SandboxProvider, SandboxConfig } = await import("../../src/tool/sandbox-provider")

const configLayer = Layer.succeed(
  SandboxConfig.Service,
  SandboxConfig.Service.of({
    ...SandboxConfig.defaultConfig,
    protocol: "https",
    useServerProxy: false,
    volumeType: "none",
    cleanupOnScopeExit: false,
  }),
)

// 共享同一个 provider 实例，让同 session 的多次 getEndpoint 走 getOrCreate 复用路径（生产行为）
const providerEffect = Effect.gen(function* () {
  return yield* SandboxProvider.Service
}).pipe(Effect.provide(Layer.provide(SandboxProvider.layer, configLayer)))
const provider = Effect.runPromise(providerEffect)

const run = async (sessionID: string, port: number, opts?: { useServerProxy?: boolean }) =>
  Effect.runPromise((await provider).getEndpoint(sessionID as never, port, opts))

beforeEach(() => {
  calls.create = 0
  calls.getEndpointUrl = []
  calls.getSandboxEndpoint = []
})

describe("SandboxProvider.getEndpoint endpoint 模式", () => {
  test("缺省不传 opts：走直连 getEndpointUrl，不触发网关查询", async () => {
    const url = await run("ses_ep_direct", 8080)
    expect(url).toBe("http://10.0.0.15:8080")
    expect(calls.getEndpointUrl).toEqual([8080])
    expect(calls.getSandboxEndpoint).toEqual([])
  })

  test("useServerProxy=true：经 OpenSandbox 网关取 /sandboxes/{id}/port/{port} 并按 config.protocol 拼 scheme", async () => {
    const url = await run("ses_ep_proxy", 9090, { useServerProxy: true })
    expect(url).toBe("https://gateway.shadow-rpa.net/sandboxes/sbx_test_123/port/9090")
    expect(calls.getSandboxEndpoint).toEqual([{ id: "sbx_test_123", port: 9090, useServerProxy: true }])
    expect(calls.getEndpointUrl).toEqual([])
  })

  test("同会话混合调用互不污染：沙箱复用，代理后缺省调用仍直连", async () => {
    await run("ses_ep_mixed", 7070, { useServerProxy: true })
    const url = await run("ses_ep_mixed", 7071)
    expect(url).toBe("http://10.0.0.15:7071")
    expect(calls.create).toBe(1)
    expect(calls.getSandboxEndpoint.map((c) => c.port)).toEqual([7070])
    expect(calls.getEndpointUrl).toEqual([7071])
  })
})
