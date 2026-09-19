import { describe, expect, beforeEach, mock } from "bun:test"
import { Effect, Layer } from "effect"
import { testEffect } from "../lib/effect"
import { SandboxProvider } from "../../src/tool/sandbox-provider"
import { McpBrowser } from "../../src/mcp/browser"

// ─── Mock Flag: force SaaS mode ───

let _saasMode = true

mock.module("@opencode-ai/core/flag/flag", () => {
  const flags: Record<string, any> = {
    OPENCODE_SANDBOX_ENABLED: false,
    OPENCODE_SANDBOX_DOMAIN: "localhost",
    OPENCODE_SANDBOX_IMAGE: "sandbox:latest",
    OPENCODE_SANDBOX_TIMEOUT: 600,
    OPENCODE_SANDBOX_API_KEY: "",
    OPENCODE_SANDBOX_USE_SERVER_PROXY: false,
    OPENCODE_SANDBOX_VOLUME_TYPE: "none",
    OPENCODE_SANDBOX_PVC_CLAIM: "",
    OPENCODE_SANDBOX_IDLE_KILL_SEC: 3600,
    OPENCODE_SANDBOX_MAX_TTL_SEC: 3600,
    OPENCODE_DISABLE_COMPACTION: false,
    OPENCODE_MODELS_PATH: undefined,
    OPENCODE_GIT_BASH_PATH: undefined,
    OPENCODE_DB: undefined,
    OPENCODE_PERMISSION: undefined,
    OPENCODE_CONFIG: undefined,
    OPENCODE_DISABLE_AUTOCOMPACT: false,
    OPENCODE_WORKSPACE_ID: undefined,
  }
  return {
    Flag: new Proxy(flags, {
      get(t, p) {
        if (p === "OPENCODE_DATABASE_URL") return _saasMode ? "postgres://mock" : undefined
        return t[p as string]
      },
    }),
  }
})

// ─── Mock MCP SDK transports ───

class MockTransport {
  pid = 12346
  stderr: null = null
  async start() {}
  async close() {}
}

mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: MockTransport,
}))

mock.module("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: MockTransport,
}))

mock.module("@modelcontextprotocol/sdk/client/sse.js", () => ({
  SSEClientTransport: MockTransport,
}))

mock.module("@modelcontextprotocol/sdk/client/auth.js", () => ({
  UnauthorizedError: class extends Error {},
}))

// ─── Mock MCP Client ───

interface MockClientState {
  tools: Array<{ name: string; description?: string; inputSchema: object }>
  listToolsCalls: number
  closed: boolean
}

const clientStates = new Map<string, MockClientState>()

function getOrCreateState(): MockClientState {
  let s = clientStates.get("default")
  if (!s) {
    s = { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object", properties: {} } }], listToolsCalls: 0, closed: false }
    clientStates.set("default", s)
  }
  return s
}

mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    _opts: any
    constructor(opts: any) { this._opts = opts }
    setRequestHandler() {}
    async connect(t: any) { await t.start() }
    async close() { clientStates.forEach((s) => { s.closed = true }) }
    async listTools() { getOrCreateState().listToolsCalls++; return { tools: getOrCreateState().tools } }
    async callTool(p: any) { return { content: [{ type: "text" as const, text: `ok:${p.name}` }] } }
    async listPrompts() { return { prompts: [] } }
    async listResources() { return { resources: [] } }
    getServerCapabilities() { return { tools: {} } }
    getInstructions() { return undefined }
    setNotificationHandler() {}
  },
}))

mock.module("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolResultSchema: {} as any,
  ListToolsResultSchema: {} as any,
  ToolSchema: { omit: () => ({} as any) } as any,
  ToolListChangedNotificationSchema: {} as any,
}))

// ─── Recording SandboxProvider mock ───

const sandboxRunCalls: Array<{ sessionID: string; command: string }> = []
const sandboxEndpointCalls: Array<{ sessionID: string; port: number }> = []

function recordingSandboxLayer() {
  return Layer.succeed(
    SandboxProvider.Service,
    SandboxProvider.Service.of({
      getOrCreate: () => Effect.succeed({} as any),
      get: () => Effect.succeed(null),
      destroy: () => Effect.void,
      destroyById: () => Effect.void,
      destroyAll: () => Effect.void,
      runInSession: (sid: string, cmd: string, _opts?: any, _handlers?: any, _signal?: any) =>
        Effect.sync(() => { sandboxRunCalls.push({ sessionID: sid, command: cmd }) }) as any,
      interrupt: () => Effect.void,
      register: () => Effect.void,
      keepAlive: () => Effect.void,
      touch: () => Effect.void,
      release: () => Effect.void,
      isKeepAlive: () => Effect.succeed(false),
      isSnapshotSession: () => Effect.succeed(false),
      getEndpoint: (sid: string, port: number) =>
        Effect.sync(() => { sandboxEndpointCalls.push({ sessionID: sid, port }) }).pipe(
          Effect.andThen(() => Effect.succeed("http://10.0.0.1:9999")),
        ) as any,
      cleanupSessionVolume: () => Effect.void,
      runDetached: () => Effect.die(new Error("not implemented")),
    }),
  )
}

const browserLayer = Layer.succeed(McpBrowser.Service, McpBrowser.Service.of({ open: () => Effect.void }))

// ─── Import after mocks ───

const { MCP } = await import("../../src/mcp/index")
const it = testEffect(MCP.defaultLayer.pipe(Layer.provideMerge(recordingSandboxLayer()), Layer.provideMerge(browserLayer)))

// ─── Fixture data ───

const localOnly = { mcp: { shadcn: { type: "local", command: ["npx", "shadcn@latest", "mcp"], enabled: true } } }
const mixed = { mcp: { shadcn: { type: "local", command: ["npx", "shadcn@latest", "mcp"], enabled: true }, search: { type: "remote", url: "https://s.example.com/mcp", enabled: true } } }
const twoLocals = { mcp: { shadcn: { type: "local", command: ["npx", "shadcn@latest", "mcp"], enabled: true }, chrome: { type: "local", command: ["chrome-devtools-mcp"], enabled: true } } }
const withDisabled = { mcp: { shadcn: { type: "local", command: ["npx", "shadcn@latest", "mcp"], enabled: true }, off: { type: "local", command: ["echo", "nope"], enabled: false } } }

function reset() { sandboxRunCalls.length = 0; sandboxEndpointCalls.length = 0; clientStates.clear() }

beforeEach(reset)

// ─── Tests ───

describe("MCP toolsForSession - SaaS sandbox routing", () => {
  it.instance(
    "starts local MCP in sandbox via supergateway bridge",
    () => Effect.gen(function* () {
      const SID = "sess_s1" as any
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession(SID)

      expect(sandboxRunCalls.length).toBe(1)
      expect(sandboxRunCalls[0].sessionID).toBe(SID)
      expect(sandboxRunCalls[0].command).toContain("supergateway")
      expect(sandboxRunCalls[0].command).toContain("shadcn")
      expect(sandboxRunCalls[0].command).toContain("--outputTransport")
      expect(sandboxRunCalls[0].command).toContain("streamableHttp")
    }),
    { config: localOnly } as any,
  )

  it.instance(
    "resolves sandbox endpoint for MCP HTTP transport",
    () => Effect.gen(function* () {
      const SID = "sess_ep" as any
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession(SID)

      expect(sandboxEndpointCalls.length).toBe(1)
      expect(sandboxEndpointCalls[0].sessionID).toBe(SID)
      expect(sandboxEndpointCalls[0].port).toBe(9100)
    }),
    { config: localOnly } as any,
  )

  it.instance(
    "caches sandbox MCP connection per session",
    () => Effect.gen(function* () {
      const SID = "sess_c1" as any
      const mcp = yield* MCP.Service

      yield* mcp.toolsForSession(SID)
      yield* mcp.toolsForSession(SID)
      yield* mcp.toolsForSession(SID)

      expect(sandboxRunCalls.length).toBe(1)
    }),
    { config: localOnly } as any,
  )

  it.instance(
    "clearSessionCache closes the client and reconnects on the next lookup",
    () => Effect.gen(function* () {
      const SID = "sess_clear" as any
      const mcp = yield* MCP.Service

      yield* mcp.toolsForSession(SID)
      expect(sandboxRunCalls.length).toBe(1)
      expect(getOrCreateState().closed).toBe(false)

      yield* mcp.clearSessionCache(SID)
      expect(getOrCreateState().closed).toBe(true)

      yield* mcp.toolsForSession(SID)
      expect(sandboxRunCalls.filter((call) => call.command.includes("supergateway")).length).toBe(2)
    }),
    { config: localOnly } as any,
  )
})

describe("MCP toolsForSession - SaaS remote MCP", () => {
  it.instance(
    "includes remote MCP tools alongside sandbox-local tools",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const ts = yield* mcp.toolsForSession("rm1" as any)
      const keys = Object.keys(ts)

      expect(keys.some((k: string) => k.startsWith("search_"))).toBe(true)
      expect(keys.some((k: string) => k.startsWith("shadcn_"))).toBe(true)
    }),
    { config: mixed } as any,
  )

  it.instance(
    "remote MCP does NOT trigger sandbox startup",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession("rm2" as any)

      expect(sandboxRunCalls.length).toBe(1)
      expect(sandboxRunCalls[0].command).toContain("shadcn")
    }),
    { config: mixed } as any,
  )
})

describe("MCP toolsForSession - SaaS per-session isolation", () => {
  it.instance(
    "different sessions each trigger sandbox startups",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession("a_s1" as any)
      const callsA = sandboxRunCalls.filter((c) => c.sessionID === "a_s1")
      sandboxRunCalls.length = 0

      yield* mcp.toolsForSession("b_s1" as any)
      const callsB = sandboxRunCalls.filter((c) => c.sessionID === "b_s1")

      expect(callsA.length).toBeGreaterThan(0)
      expect(callsB.length).toBeGreaterThan(0)
    }),
    { config: twoLocals } as any,
  )

  it.instance(
    "each MCP gets a unique port in 9000-10000 range",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession("ports1" as any)

      const ports = sandboxEndpointCalls.map((c) => c.port)
      expect(ports.length).toBeGreaterThan(0)
      for (const p of ports) {
        expect(p).toBeGreaterThanOrEqual(9100)
        expect(p).toBeLessThan(10000)
      }
    }),
    { config: twoLocals } as any,
  )

  it.instance(
    "clearing one session leaves another session cached",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const sessionA = "clear_a" as any
      const sessionB = "clear_b" as any

      yield* mcp.toolsForSession(sessionA)
      yield* mcp.toolsForSession(sessionB)
      expect(sandboxRunCalls.length).toBe(2)

      yield* mcp.clearSessionCache(sessionA)
      yield* mcp.toolsForSession(sessionB)
      expect(sandboxRunCalls.filter((call) => call.command.includes("supergateway")).length).toBe(2)

      yield* mcp.toolsForSession(sessionA)
      expect(sandboxRunCalls.filter((call) => call.command.includes("supergateway")).length).toBe(3)
    }),
    { config: localOnly } as any,
  )
})

describe("MCP toolsForSession - SaaS disabled MCP", () => {
  it.instance(
    "disabled local MCP is silently skipped",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession("dis1" as any)

      expect(sandboxRunCalls.length).toBe(1)
      expect(sandboxRunCalls[0].command).toContain("shadcn")
    }),
    { config: withDisabled } as any,
  )
})

describe("MCP toolsForSession - SaaS empty config", () => {
  it.instance(
    "handles no mcp config gracefully",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const ts = yield* mcp.toolsForSession("empty1" as any)
      expect(ts).toBeObject()
      expect(sandboxRunCalls.length).toBe(0)
    }),
    { config: { mcp: {} } } as any,
  )
})

// ─── Shell injection hardening ───

const maliciousEnv = {
  mcp: {
    "bad;touch /tmp/x;#": {
      type: "local",
      command: ["echo", "hi"],
      enabled: true,
      environment: { "BAD-ENV;touch /tmp/pwned": "x", SAFE: "v" },
    },
  },
}

describe("MCP shell injection hardening", () => {
  it.instance(
    "quotes env keys so malicious keys cannot inject commands",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession("inj1" as any)
      expect(sandboxRunCalls.length).toBe(1)
      const cmd = sandboxRunCalls[0].command
      expect(cmd).toContain("'BAD-ENV;touch /tmp/pwned'='x'")
      expect(cmd).not.toContain("BAD-ENV;touch /tmp/pwned=x")
    }),
    { config: maliciousEnv } as any,
  )

  it.instance(
    "sanitizes MCP name in sandbox pid/log paths",
    () => Effect.gen(function* () {
      const mcp = yield* MCP.Service
      yield* mcp.toolsForSession("inj2" as any)
      expect(sandboxRunCalls.length).toBe(1)
      const cmd = sandboxRunCalls[0].command
      expect(cmd).toContain("/tmp/opencode-mcp/bad_touch__tmp_x_")
      expect(cmd).not.toContain("/tmp/opencode-mcp/bad;touch")
    }),
    { config: maliciousEnv } as any,
  )
})
