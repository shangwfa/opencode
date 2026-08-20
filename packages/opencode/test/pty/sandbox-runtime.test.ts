import { describe, expect } from "bun:test"
import type { Sandbox } from "@alibaba-group/opensandbox"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PtyRuntime } from "@opencode-ai/server/pty-runtime"
import { Effect, Layer } from "effect"
import { SandboxPtyRuntime } from "@/pty/sandbox-runtime"
import { SandboxPtyScope } from "@/pty/sandbox-scope"
import { SandboxPtyCredential } from "@/pty/sandbox-credential"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { testEffect } from "../lib/effect"

describe("sandbox PTY runtime", () => {
  const state = {
    endpoint: "",
    keepAlive: 0,
    release: 0,
  }
  const sandbox = {} as Sandbox
  const provider = Layer.mock(SandboxProvider.Service)({
    getOrCreate: () => Effect.succeed(sandbox),
    get: () => Effect.succeed(sandbox),
    getEndpoint: () => Effect.succeed(state.endpoint),
    keepAlive: () => Effect.sync(() => state.keepAlive++).pipe(Effect.asVoid),
    isKeepAlive: () => Effect.succeed(false),
    touch: () => Effect.void,
    release: () => Effect.sync(() => state.release++).pipe(Effect.asVoid),
  })
  const scope = Layer.mock(SandboxPtyScope.Service)({
    resolve: (sessionID) => Effect.succeed({ id: sessionID, persistMode: "pvc" }),
  })
  const credential = Layer.mock(SandboxPtyCredential.Service)({ token: () => "test-token" })
  const it = testEffect(
    SandboxPtyRuntime.layer.pipe(
      Layer.provide(provider),
      Layer.provide(scope),
      Layer.provide(credential),
      Layer.provide(LayerNode.compile(EventV2.node)),
    ),
  )

  it.live("proxies lifecycle operations to the session sandbox agent", () =>
    Effect.gen(function* () {
      const sessions = new Map<string, Record<string, unknown>>()
      let eventStreams = 0
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/health") return Response.json({ status: "ready", protocolVersion: 1 })
          if (url.pathname === "/pty/events") {
            eventStreams++
            return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
          }
          if (url.pathname === "/pty" && request.method === "GET") return Response.json(Array.from(sessions.values()))
          if (url.pathname === "/pty" && request.method === "POST") {
            const input = (await request.json()) as Record<string, unknown>
            const info = {
              id: "pty_sandbox_test",
              title: input.title ?? "Terminal test",
              command: "/bin/bash",
              args: ["-l"],
              cwd: input.cwd,
              status: "running",
              pid: 42,
            }
            sessions.set(String(info.id), info)
            return Response.json(info, { status: 201 })
          }
          const id = url.pathname.split("/")[2]
          const info = sessions.get(id)
          if (!info) return Response.json({ error: "not found" }, { status: 404 })
          if (request.method === "GET") return Response.json(info)
          if (request.method === "PUT") {
            Object.assign(info, await request.json())
            return Response.json(info)
          }
          if (request.method === "DELETE") {
            sessions.delete(id)
            return new Response(null, { status: 204 })
          }
          return new Response(null, { status: 405 })
        },
      })
      state.endpoint = server.url.origin
      state.keepAlive = 0
      state.release = 0
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))

      const runtime = yield* PtyRuntime.Service
      expect(runtime.requiresTicket).toBe(true)
      expect(runtime.requiresSession).toBe(true)
      const created = yield* runtime.create("ses_sandbox_runtime", { title: "sandbox" })
      expect(created).toMatchObject({ id: "pty_sandbox_test", title: "sandbox", cwd: "/workspace" })
      expect(state.keepAlive).toBe(1)
      yield* Effect.all(Array.from({ length: 20 }, () => runtime.list("ses_sandbox_runtime")), {
        concurrency: "unbounded",
      })
      yield* Effect.sleep("50 millis")
      expect(eventStreams).toBe(1)

      expect(yield* runtime.get("ses_sandbox_runtime", created.id)).toMatchObject({ id: created.id })
      expect(yield* runtime.update("ses_sandbox_runtime", created.id, { title: "renamed" })).toMatchObject({
        title: "renamed",
      })

      yield* runtime.remove("ses_sandbox_runtime", created.id)
      expect(state.release).toBe(1)
    }),
  )

  it.live("releases the sandbox lease when a PTY exits before relay startup", () =>
    Effect.gen(function* () {
      const server = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          if (url.pathname === "/health") return Response.json({ status: "ready", protocolVersion: 1 })
          if (url.pathname === "/pty/events")
            return new Response(new ReadableStream({ start() {} }), { headers: { "content-type": "text/event-stream" } })
          if (url.pathname === "/pty" && request.method === "GET") return Response.json([])
          if (url.pathname === "/pty" && request.method === "POST")
            return Response.json({
              id: "pty_fast_exit",
              title: "fast exit",
              command: "/bin/sh",
              args: ["-lc", "exit 0"],
              cwd: "/workspace",
              status: "exited",
              pid: 43,
              exitCode: 0,
            }, { status: 201 })
          return Response.json({ error: "not found" }, { status: 404 })
        },
      })
      state.endpoint = server.url.origin
      state.keepAlive = 0
      state.release = 0
      yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)))

      const runtime = yield* PtyRuntime.Service
      yield* runtime.create("ses_fast_exit", { title: "fast exit" })
      yield* Effect.sleep("1200 millis")

      expect(state.keepAlive).toBe(1)
      expect(state.release).toBe(1)
    }),
  )
})
