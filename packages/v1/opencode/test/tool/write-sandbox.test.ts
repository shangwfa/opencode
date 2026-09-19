import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { WriteTool } from "../../src/tool/write"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Truncate } from "@/tool/truncate"
import { Agent } from "../../src/agent/agent"
import { SessionID, MessageID } from "../../src/session/schema"
import { SandboxApiException } from "@alibaba-group/opensandbox"
import type { Sandbox } from "@alibaba-group/opensandbox"
import { provideInstance, testInstanceStoreLayer } from "../fixture/fixture"

// Records every publish so tests can assert watcher event kinds (add/change).
const published: { type: string; data: any }[] = []
const bridgeStub = Layer.succeed(
  EventV2Bridge.Service,
  EventV2Bridge.Service.of({
    publish: (definition: any, data: any) =>
      Effect.sync(() => {
        published.push({ type: definition.type, data })
      }),
    listen: () => Effect.succeed(() => {}),
  } as any),
)

const layers = Layer.mergeAll(
  LayerNode.compile(FSUtil.node),
  LayerNode.compile(CrossSpawnSpawner.node),
  bridgeStub,
  Layer.succeed(Truncate.Service, {
    output: (text: string) => Effect.succeed({ content: text, truncated: false }),
    limits: () => Effect.succeed({ maxBytes: 50000, maxLines: 2000 }),
  } as any),
  Layer.succeed(Agent.Service, {
    get: () => Effect.succeed({ model: undefined, permission: [], tools: [] } as any),
  } as any),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_test",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function makeSandbox(opts: { readFile: () => Promise<string> }): { sb: Sandbox; written: Map<string, string> } {
  const written = new Map<string, string>()
  const sb = {
    files: {
      readFile: opts.readFile,
      writeFiles: async (entries: { path: string; data: string }[]) => {
        for (const entry of entries) written.set(entry.path, entry.data)
      },
    },
    commands: {},
  } as unknown as Sandbox
  return { sb, written }
}

async function execWrite(readFile: () => Promise<string>, content: string) {
  published.length = 0
  const { sb, written } = makeSandbox({ readFile })
  const init = await Effect.runPromise(Effect.scoped(WriteTool.pipe(Effect.provide(layers), Effect.provide(testInstanceStoreLayer))))
  const tool = await Effect.runPromise(
    Effect.scoped(init.init().pipe(Effect.provide(layers), provideInstance("/workspace"), Effect.provide(testInstanceStoreLayer))),
  )
  const runEffect = tool
    .execute({ filePath: "/workspace/file.txt", content }, { ...ctx, sandbox: Promise.resolve(sb) } as any)
    .pipe(Effect.provide(layers), provideInstance("/workspace"), Effect.provide(testInstanceStoreLayer))
  return {
    written,
    events: published,
    result: await Effect.runPromise(Effect.scoped(runEffect)),
  }
}

describe("tool.write sandbox mode (exists semantics)", () => {
  test("404 from readFile maps to a new file (add event, exists=false)", async () => {
    const { result, written, events } = await execWrite(
      () => Promise.reject(new SandboxApiException({ message: "not found", statusCode: 404 })),
      "brand new",
    )
    expect(result.metadata.exists).toBe(false)
    expect(written.get("/workspace/file.txt")).toBe("brand new")
    const watcher = events.find((e) => e.type.includes("watcher"))
    expect(watcher?.data.event).toBe("add")
  })

  test("empty existing file maps to exists=true (change event, not add)", async () => {
    const { result, written, events } = await execWrite(() => Promise.resolve(""), "now has content")
    expect(result.metadata.exists).toBe(true)
    expect(written.get("/workspace/file.txt")).toBe("now has content")
    const watcher = events.find((e) => e.type.includes("watcher"))
    expect(watcher?.data.event).toBe("change")
  })

  test("non-empty existing file maps to exists=true", async () => {
    const { result } = await execWrite(() => Promise.resolve("old content"), "new content")
    expect(result.metadata.exists).toBe(true)
  })

  test("transport errors propagate and nothing is written", async () => {
    published.length = 0
    const { sb, written: sink } = makeSandbox({ readFile: () => Promise.reject(new Error("socket hang up")) })
    const init = await Effect.runPromise(Effect.scoped(WriteTool.pipe(Effect.provide(layers), Effect.provide(testInstanceStoreLayer))))
    const tool = await Effect.runPromise(
      Effect.scoped(init.init().pipe(Effect.provide(layers), provideInstance("/workspace"), Effect.provide(testInstanceStoreLayer))),
    )
    let error: unknown
    await Effect.runPromise(
      tool
        .execute({ filePath: "/workspace/file.txt", content: "x" }, { ...ctx, sandbox: Promise.resolve(sb) } as any)
        .pipe(
          Effect.provide(layers),
          provideInstance("/workspace"),
          Effect.provide(testInstanceStoreLayer),
          Effect.catch((e) =>
            Effect.sync(() => {
              error = e
            }),
          ),
        ),
    )
    expect((error as Error)?.message).toContain("socket hang up")
    expect(sink.size).toBe(0)
  })
})
