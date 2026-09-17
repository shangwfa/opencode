import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Queue } from "effect"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"

type Socket = Pty.AttachInput & { data: unknown }

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/tmp") })),
)
const configLayer = Layer.mock(Config.Service)({ entries: () => Effect.succeed([]) })
const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Pty.node, EventV2.node]), [
    [Config.node, configLayer],
    [Location.node, locationLayer],
  ]),
)
const ptyTest = process.platform === "win32" ? it.live.skip : it.live

const createPty = Effect.fn("PtyOutputIsolationTest.createPty")(function* (command: string) {
  const pty = yield* Pty.Service
  return yield* Effect.acquireRelease(
    pty.create({ command, args: [], cwd: "/tmp", env: { TERM: "xterm-256color", OPENCODE_TERMINAL: "1" } }),
    (info) => pty.remove(info.id).pipe(Effect.ignore),
  )
})

const decodeOutput = (data: string | Uint8Array | ArrayBuffer) =>
  typeof data === "string"
    ? data
    : Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data)).toString("utf8")

const makeSocket = Effect.fn("PtyOutputIsolationTest.makeSocket")(function* (data: unknown) {
  const output = yield* Queue.unbounded<string>()
  const socket: Socket = {
    data,
    onData: (data) => Queue.offerUnsafe(output, decodeOutput(data)),
    onEnd: () => {},
  }
  return { socket, output }
})

const attach = Effect.fn("PtyOutputIsolationTest.attach")(function* (
  pty: Pty.Interface,
  id: Pty.Info["id"],
  socket: Socket,
) {
  const attachment = yield* pty.attach(id, socket)
  if (attachment.replay) socket.onData(attachment.replay)
  attachment.activate()
  return attachment
})

const waitForOutput = (output: Queue.Queue<string>, text: string, duration: Duration.Input = "5 seconds") =>
  Effect.gen(function* () {
    let received = ""
    while (!received.includes(text)) received += yield* Queue.take(output)
    return received
  }).pipe(
    Effect.timeoutOrElse({
      duration,
      orElse: () => Effect.fail(new Error(`timeout waiting for output containing ${JSON.stringify(text)}`)),
    }),
  )

describe("pty output isolation", () => {
  ptyTest("does not leak output when websocket objects are reused", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const a = yield* createPty("cat")
      const b = yield* createPty("cat")
      const shared = yield* makeSocket({ events: { connection: "a" } })
      const outB = yield* Queue.unbounded<string>()

      yield* attach(pty, a.id, shared.socket)
      shared.socket.data = { events: { connection: "b" } }
      shared.socket.onData = (data) => Queue.offerUnsafe(outB, decodeOutput(data))
      yield* attach(pty, b.id, shared.socket)
      yield* pty.write(a.id, "AAA\n")

      const verify = yield* makeSocket({ events: { connection: "verify-a" } })
      yield* attach(pty, a.id, verify.socket)
      expect(yield* waitForOutput(verify.output, "AAA")).toContain("AAA")
      expect(yield* waitForOutput(outB, "AAA", "100 millis").pipe(Effect.option)).toMatchObject({ _tag: "None" })
    }),
  )

  ptyTest("does not leak output when Bun recycles websocket objects before re-connect", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      const first = yield* makeSocket({ events: { connection: "a" } })
      const recycled = yield* Queue.unbounded<string>()

      yield* attach(pty, info.id, first.socket)
      first.socket.data = { events: { connection: "b" } }
      first.socket.onData = (data) => Queue.offerUnsafe(recycled, decodeOutput(data))
      yield* pty.write(info.id, "AAA\n")

      const verify = yield* makeSocket({ events: { connection: "verify" } })
      yield* attach(pty, info.id, verify.socket)
      expect(yield* waitForOutput(verify.output, "AAA")).toContain("AAA")
      expect(yield* waitForOutput(recycled, "AAA", "100 millis").pipe(Effect.option)).toMatchObject({ _tag: "None" })
    }),
  )

  ptyTest("treats in-place socket data mutation as the same connection", () =>
    Effect.gen(function* () {
      const pty = yield* Pty.Service
      const info = yield* createPty("cat")
      const data = { connId: 1 }
      const socket = yield* makeSocket(data)

      yield* attach(pty, info.id, socket.socket)
      data.connId = 2
      yield* pty.write(info.id, "AAA\n")

      expect(yield* waitForOutput(socket.output, "AAA")).toContain("AAA")
    }),
  )
})
