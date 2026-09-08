import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import type { Tool as AITool } from "ai"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { AntiLoop } from "../../src/session/anti-loop"
import { MessageID, SessionID } from "../../src/session/schema"
import type { Tool } from "../../src/tool/tool"
import { Plugin } from "@/plugin"
import { SessionPluginRuntime } from "@/plugin/session-plugin-runtime"
import { Permission } from "@/permission"
import { ToolRegistry } from "@/tool/registry"
import { MCP } from "@/mcp"
import { Truncate } from "@/tool/truncate"
import { RuntimeFlags } from "@/effect/runtime-flags"
import type { TaskPromptOps } from "@/tool/task"
import type { Agent } from "../../src/agent/agent"
import type { Provider } from "@/provider/provider"
import type { Session } from "@/session/session"
import type { SessionProcessor } from "@/session/processor"
import { SessionTools } from "@/session/tools"

const it = testEffect(
  LayerNode.compile(LayerNode.group([CrossSpawnSpawner.node]), []) as Layer.Layer<ChildProcessSpawner>,
)

const passthroughTrigger = <T>(_name: string, _input: unknown, value: T) => Effect.succeed(value)

const pluginService = { trigger: passthroughTrigger } as unknown as Plugin.Interface
const sessionPluginRuntimeService = {
  acquire: () => Effect.succeed({ trigger: passthroughTrigger } as unknown as SessionPluginRuntime.Runtime),
} as unknown as SessionPluginRuntime.Interface
const permissionService = {} as Permission.Interface
const mcpService = {
  clients: () => Effect.succeed({}),
  toolsForSession: () => Effect.succeed({}),
} as unknown as MCP.Interface
const truncateService = {} as Truncate.Interface

const makeRegistry = (defs: Tool.Def[]) =>
  ({ tools: () => Effect.succeed(defs) }) as unknown as ToolRegistry.Interface

const assistantMessage = {
  id: MessageID.ascending(),
  role: "assistant",
  sessionID: SessionID.make("ses_antiloop_wiring"),
} as SessionV1.Assistant

const handle = {
  message: assistantMessage,
  updateToolCall: () => Effect.succeed(undefined),
  completeToolCall: () => Effect.void,
} as unknown as SessionProcessor.Handle

const agent: Agent.Info = { name: "build", mode: "primary", options: {}, permission: [] }

const model = { providerID: "test", api: { id: "test-model" } } as unknown as Provider.Model

function makeProbe(fail: boolean) {
  let calls = 0
  const def = {
    id: fail ? "probe-fail" : "probe",
    description: "anti-loop wiring probe",
    parameters: Schema.Struct({ n: Schema.Number }),
    // Tool defs handed to a mocked registry are the post-wrap shape: typed
    // errors were already normalized by wrap in production, so assert here.
    execute: ((args: { n: number }) => {
      calls++
      if (fail) return Effect.fail(new Error(`probe boom ${calls}`))
      return Effect.succeed({ title: "ok", metadata: {}, output: `ran:${args.n}` })
    }) as Tool.Def["execute"],
  }
  return { def, count: () => calls }
}

// A tool that hangs until the caller aborts — mirrors watchdog/abort interrupts
// (Effect.interrupt, not Effect.fail) racing into ToolExecution.raceAbort.
function makeHangingProbe() {
  let calls = 0
  const def = {
    id: "probe-hang",
    description: "anti-loop hanging probe",
    parameters: Schema.Struct({ n: Schema.Number }),
    execute: ((_args: { n: number }) => {
      calls++
      return Effect.never as unknown as ReturnType<Tool.Def["execute"]>
    }) as Tool.Def["execute"],
  }
  return { def, count: () => calls }
}

// Drives execute with an AbortController and aborts it shortly after launch.
const execAborted = (
  tool: { execute?: (args: never, opts: never) => Promise<unknown> },
  args: unknown,
  i: number,
) => {
  const controller = new AbortController()
  const promise = tool.execute!(args as never, {
    toolCallId: `call-${i}`,
    abortSignal: controller.signal,
  } as never)
  setTimeout(() => controller.abort(), 5)
  return promise.then(
    () => "resolved" as const,
    () => "rejected" as const,
  )
}

function resolveTools(defs: Tool.Def[], antiLoop: AntiLoop.AntiLoop | undefined, dir: string) {
  const sessionInfo = {
    id: SessionID.make("ses_antiloop_wiring"),
    slug: "antiloop",
    projectID: "prj_test",
    directory: dir,
    title: "anti-loop wiring",
    version: "test",
    time: { created: Date.now(), updated: Date.now() },
  } as unknown as Session.Info
  return SessionTools.resolve({
    agent,
    model,
    session: sessionInfo,
    processor: handle,
    bypassAgentCheck: false,
    messages: [],
    promptOps: {} as TaskPromptOps,
    antiLoop,
  }).pipe(
    Effect.provideService(Plugin.Service, pluginService),
    Effect.provideService(SessionPluginRuntime.Service, sessionPluginRuntimeService),
    Effect.provideService(Permission.Service, permissionService),
    Effect.provideService(ToolRegistry.Service, makeRegistry(defs)),
    Effect.provideService(MCP.Service, mcpService),
    Effect.provideService(Truncate.Service, truncateService),
    Effect.provide(RuntimeFlags.layer({ experimentalCodeMode: "off" })),
  ) as Effect.Effect<Record<string, AITool>, never, never>
}

const exec = (tool: { execute?: (args: never, opts: never) => Promise<unknown> }, args: unknown, i: number) =>
  tool.execute!(args as never, {
    toolCallId: `call-${i}`,
    abortSignal: new AbortController().signal,
  } as never)

const blockMode = () => AntiLoop.make()

it.live(
  "invoke executes the first two identical calls and blocks the third with guidance",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const probe = makeProbe(false)
        const loop = blockMode()
        const tools = yield* resolveTools([probe.def], loop, dir)

        expect(yield* Effect.promise(() => exec(tools["probe"], { n: 1 }, 1))).toEqual({
          title: "ok",
          metadata: {},
          output: "ran:1",
        })
        yield* Effect.promise(() => exec(tools["probe"], { n: 1 }, 2))
        expect(probe.count()).toBe(2)

        const blocked = (yield* Effect.promise(() => exec(tools["probe"], { n: 1 }, 3))) as {
          title: string
          metadata: { antiLoop: { signal: string } }
          output: string
        }
        expect(probe.count()).toBe(2)
        expect(blocked.title).toBe("Blocked repeated probe call")
        expect(blocked.metadata.antiLoop.signal).toBe("repeat")
        expect(blocked.output).toContain("Change your approach")
      }),
    ),
)

it.live(
  "invoke rejects with CorrectedError when the blocked call is re-issued",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const probe = makeProbe(false)
        const loop = blockMode()
        const tools = yield* resolveTools([probe.def], loop, dir)

        yield* Effect.promise(() => exec(tools["probe"], { n: 1 }, 1))
        yield* Effect.promise(() => exec(tools["probe"], { n: 1 }, 2))
        yield* Effect.promise(() => exec(tools["probe"], { n: 1 }, 3))

        const exit = yield* Effect.promise(() =>
          exec(tools["probe"], { n: 1 }, 4).then(
            (v) => ({ ok: true as const, v }),
            (e: unknown) => ({ ok: false as const, e }),
          ),
        )
        expect(exit.ok).toBe(false)
        if (!exit.ok) {
          expect(exit.e).toBeInstanceOf(AntiLoop.LoopAbortedError)
          expect((exit.e as Error).message).toContain("re-issued")
        }
        expect(probe.count()).toBe(2)
      }),
    ),
)

it.live(
  "invoke records failures and blocks the fourth call of a consecutively failing tool",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const probe = makeProbe(true)
        const loop = blockMode()
        const tools = yield* resolveTools([probe.def], loop, dir)

        for (const i of [1, 2, 3]) {
          const exit = yield* Effect.promise(() =>
            exec(tools["probe-fail"], { n: i }, i).then(
              () => "resolved",
              (e: unknown) => (e instanceof Error ? e.message : "other"),
            ),
          )
          expect(exit).toBe(`probe boom ${i}`)
        }
        expect(probe.count()).toBe(3)

        const blocked = (yield* Effect.promise(() => exec(tools["probe-fail"], { n: 4 }, 4))) as {
          title: string
          metadata: { antiLoop: { signal: string } }
          output: string
        }
        expect(probe.count()).toBe(3)
        expect(blocked.metadata.antiLoop.signal).toBe("fail")
        expect(blocked.output).toContain("failed 3 times in a row")
      }),
    ),
)

it.live(
  "without a detector every identical call executes",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const probe = makeProbe(false)
        const tools = yield* resolveTools([probe.def], undefined, dir)

        for (const i of [1, 2, 3, 4]) {
          yield* Effect.promise(() => exec(tools["probe"], { n: 1 }, i))
        }
        expect(probe.count()).toBe(4)
      }),
    ),
)

it.live(
  "aborted (interrupt) calls are not recorded as failures — only real fails count",
  () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const hanging = makeHangingProbe()
        const failing = makeProbe(true)
        const loop = AntiLoop.make()
        const tools = yield* resolveTools([hanging.def, failing.def], loop, dir)

        // 3 aborted hangs (watchdog/abort interrupts) must NOT enter the fail counter
        for (const i of [1, 2, 3]) {
          const outcome = yield* Effect.promise(() => execAborted(tools["probe-hang"], { n: i }, i))
          expect(outcome).toBe("rejected")
          expect(hanging.count()).toBe(i)
        }
        // 2 real Effect failures
        for (const i of [1, 2]) {
          const outcome = yield* Effect.promise(() =>
            exec(tools["probe-fail"], { n: i }, i).then(
              () => "resolved",
              () => "rejected",
            ),
          )
          expect(outcome).toBe("rejected")
        }
        // If interrupts had been miscounted as failures we'd be at 5 consecutive
        // fails and this call would be fail-blocked. Correct behavior: only 2
        // real fails are recorded, so the next call is allowed.
        const verdict = loop.check("probe-fail", { n: 99 })
        expect(verdict.action).toBe("allow")
      }),
    ),
)
