export * as SandboxPtyRuntime from "./sandbox-runtime"

import { Pty } from "@opencode-ai/core/pty"
import { PtyProtocol } from "@opencode-ai/core/pty/protocol"
import { EventV2 } from "@opencode-ai/core/event"
import { PtyRuntime } from "@opencode-ai/server/pty-runtime"
import { Effect, Layer } from "effect"
import type { SessionID } from "@/session/schema"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { SandboxPtyScope } from "./sandbox-scope"

const port = 4097

class MissingPty extends Error {}
class ExitedPty extends Error {}

export const layer = Layer.effect(
  PtyRuntime.Service,
  Effect.gen(function* () {
    const sandbox = yield* SandboxProvider.Service
    const scope = yield* SandboxPtyScope.Service
    const events = yield* EventV2.Service
    const context = yield* Effect.context()
    const runPromise = Effect.runPromiseWith(context)
    const runFork = Effect.runForkWith(context)
    const starts = new Map<SessionID, Promise<string>>()
    const relays = new Map<SessionID, AbortController>()
    const eventCursors = new Map<SessionID, number>()
    const agentInstances = new Map<SessionID, string>()
    const agentURL = (endpoint: string, path: string, sessionID?: string) => {
      const url = new URL(`${endpoint}${path}`)
      if (sessionID) url.searchParams.set("sessionID", sessionID)
      return url
    }

    const publish = (event: { type?: unknown; data?: unknown }) => {
      if (!event.data || typeof event.data !== "object") return Effect.void
      if (event.type === Pty.Event.Created.type)
        return events.publish(Pty.Event.Created, event.data as typeof Pty.Event.Created.data.Type)
      if (event.type === Pty.Event.Updated.type)
        return events.publish(Pty.Event.Updated, event.data as typeof Pty.Event.Updated.data.Type)
      if (event.type === Pty.Event.Exited.type)
        return events.publish(Pty.Event.Exited, event.data as typeof Pty.Event.Exited.data.Type)
      if (event.type === Pty.Event.Deleted.type)
        return events.publish(Pty.Event.Deleted, event.data as typeof Pty.Event.Deleted.data.Type)
      return Effect.void
    }

    const startRelay = async (root: SessionID, endpoint: string) => {
      if (relays.has(root)) return
      const controller = new AbortController()
      relays.set(root, controller)
      const list = () =>
        fetch(agentURL(endpoint, "/pty", "*")).then(
          (response) => response.json() as Promise<Pty.Info[]>,
        )
      const reconcile = async () => {
        const active = await list()
        if (active.some((item) => item.status === "running")) {
          await runPromise(sandbox.touch(root))
          return
        }
        await runPromise(sandbox.release(root))
        const confirmed = await list()
        if (confirmed.some((item) => item.status === "running")) {
          await runPromise(sandbox.keepAlive(root))
          return
        }
        if (relays.get(root) !== controller) return
        relays.delete(root)
        controller.abort()
      }
      const heartbeat = setInterval(() => void reconcile().catch(() => {}), 60_000)
      const initial = setTimeout(() => void reconcile().catch(() => {}), 1_000)
      controller.signal.addEventListener("abort", () => {
        clearInterval(heartbeat)
        clearTimeout(initial)
      }, { once: true })
      runFork(
        Effect.tryPromise({
          try: async () => {
            while (!controller.signal.aborted) {
              try {
                const response = await fetch(`${endpoint}/pty/events`, {
                  signal: controller.signal,
                  headers: eventCursors.has(root
                    ? { "last-event-id": String(eventCursors.get(root)) }
                    : undefined),
                })
                if (response.status === 409) {
                  const gap = await response.json() as { oldest?: unknown }
                  if (typeof gap.oldest === "number" && Number.isSafeInteger(gap.oldest))
                    eventCursors.set(root, gap.oldest - 1)
                  else eventCursors.delete(root)
                  await reconcile()
                  continue
                }
                if (!response.ok || !response.body) throw new Error(`PTY event relay failed with ${response.status}`)
                const instance = response.headers.get("x-opencode-pty-agent-instance")
                const previous = agentInstances.get(root)
                if (instance && previous && instance !== previous) {
                  agentInstances.set(root, instance)
                  eventCursors.delete(root)
                  await response.body.cancel()
                  await reconcile()
                  continue
                }
                if (instance) agentInstances.set(root, instance)
                const reader = response.body.getReader()
                const decoder = new TextDecoder()
                let buffer = ""
                while (!controller.signal.aborted) {
                  const next = await reader.read()
                  if (next.done) break
                  buffer += decoder.decode(next.value, { stream: true })
                  const frames = buffer.split("\n\n")
                  buffer = frames.pop() ?? ""
                  for (const frame of frames) {
                    const id = frame.split("\n").find((item) => item.startsWith("id: "))
                    const line = frame.split("\n").find((item) => item.startsWith("data: "))
                    if (!line) continue
                    try {
                      const event = JSON.parse(line.slice(6)) as { type?: unknown; data?: unknown }
                      await runPromise(publish(event))
                      const cursor = Number(id?.slice(4))
                      if (Number.isSafeInteger(cursor)) eventCursors.set(root, cursor)
                      if (event.type !== Pty.Event.Exited.type && event.type !== Pty.Event.Deleted.type) continue
                      await reconcile()
                    } catch {}
                  }
                }
              } catch {
                if (!controller.signal.aborted) await Bun.sleep(1_000)
              }
            }
          },
          catch: (cause) => cause,
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (relays.get(root) === controller) relays.delete(root)
            }),
          ),
          Effect.ignore,
        ),
      )
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const relay of relays.values()) relay.abort()
        relays.clear()
        starts.clear()
        agentInstances.clear()
      }),
    )

    const resolve = (sessionID: string, create: boolean) =>
      Effect.tryPromise({
        try: async () => {
          const root = await runPromise(scope.resolve(sessionID as SessionID))
          const existing = create
            ? await runPromise(
                sandbox.getOrCreate(root.id, {
                  pvcMode: root.pvcMode,
                  appId: root.appId,
                  sandbox: root.sandbox,
                }),
              )
            : await runPromise(sandbox.get(root.id))
          if (!existing) throw new MissingPty()
          await runPromise(sandbox.touch(root.id))

          const cached = starts.get(root.id)
          if (cached) {
            const endpoint = await cached
            const healthy = await fetch(`${endpoint}/health`, {
              signal: AbortSignal.timeout(1_000),
            })
              .then((response) => response.ok)
              .catch(() => false)
            if (healthy) {
              await startRelay(root.id, endpoint)
              return { root: root.id, endpoint }
            }
            starts.delete(root.id)
            relays.get(root.id)?.abort()
            relays.delete(root.id)
          }

          const start = (async () => {
            const endpoint = await runPromise(sandbox.getEndpoint(root.id, port))
            const healthy = await fetch(`${endpoint}/health`, {
              signal: AbortSignal.timeout(1_000),
            })
              .then((response) => response.ok)
              .catch(() => false)
            if (!healthy) {
              await runPromise(
                sandbox.runInSession(
                  root.id,
                  `flock -w 10 /tmp/opencode-pty-agent.lock sh -c 'if [ -f /tmp/opencode-pty-agent.pid ] && kill -0 "$(cat /tmp/opencode-pty-agent.pid)" 2>/dev/null; then exit 0; fi; setsid bun /opt/opencode-pty-agent/index.ts >/tmp/opencode-pty-agent.log 2>&1 & echo $! >/tmp/opencode-pty-agent.pid'`,
                  { workingDirectory: "/workspace", timeoutSeconds: 10 },
                ),
              )
              for (let attempt = 0; attempt < 40; attempt++) {
                const ready = await fetch(`${endpoint}/health`, {
                  signal: AbortSignal.timeout(1_000),
                })
                  .then((response) => response.ok)
                  .catch(() => false)
                if (ready) return endpoint
                await Bun.sleep(250)
              }
              throw new Error("Sandbox PTY agent did not become ready")
            }
            return endpoint
          })().catch((cause) => {
            starts.delete(root.id)
            throw cause
          })
          starts.set(root.id, start)
          const endpoint = await start
          await startRelay(root.id, endpoint)
          return { root: root.id, endpoint }
        },
        catch: (cause) => cause,
      })

    const request = <A>(
      sessionID: string,
      path: string,
      options: RequestInit | undefined,
      create = false,
    ): Effect.Effect<A, Pty.NotFoundError> =>
      Effect.gen(function* () {
        const target = yield* resolve(sessionID, create)
        const response = yield* Effect.tryPromise({
          try: () =>
            fetch(agentURL(target.endpoint, path, sessionID), {
              ...options,
              headers: options?.headers,
              signal: AbortSignal.timeout(10_000),
            }),
          catch: (cause) => cause,
        }).pipe(Effect.orDie)
        if (response.status === 404) return yield* Effect.fail(new MissingPty())
        if (response.status === 409) return yield* Effect.fail(new ExitedPty())
        if (!response.ok) return yield* Effect.die(new Error(`Sandbox PTY request failed with ${response.status}`))
        if (response.status === 204) return undefined as A
        return (yield* Effect.tryPromise({ try: () => response.json() as Promise<A>, catch: (cause) => cause }).pipe(
          Effect.orDie,
        )) as A
      }).pipe(
        Effect.catch((cause) => {
          if (cause instanceof MissingPty)
            return Effect.fail(new Pty.NotFoundError({ ptyID: (path.split("/")[2] ?? "pty_missing") as Pty.Info["id"] }))
          if (cause instanceof ExitedPty)
            return Effect.fail(new Pty.NotFoundError({ ptyID: path.split("/")[2] as Pty.Info["id"] }))
          return Effect.die(cause)
        }),
      )

    const attach: PtyRuntime.Interface["attach"] = (sessionID, id, input) =>
      Effect.gen(function* () {
        const info = yield* request<Pty.Info>(sessionID, `/pty/${id}`, undefined)
        if (info.status === "exited") return yield* new Pty.ExitedError({ ptyID: id })
        const target = yield* resolve(sessionID, false).pipe(Effect.orDie)
        return yield* Effect.tryPromise({
          try: (signal) =>
            new Promise<Pty.Attachment>((resolveAttachment, reject) => {
              const url = new URL(`${target.endpoint}/pty/${id}/connect`)
              url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
              url.searchParams.set("sessionID", sessionID)
              if (input.cursor !== undefined) url.searchParams.set("cursor", String(input.cursor))
              const socket = new WebSocket(url)
              socket.binaryType = "arraybuffer"
              const replay: string[] = []
              const pending: string[] = []
              let cursor: number | undefined
              let active = false
              let settled = false
              const abort = () => {
                socket.close(1000)
                reject(new Error("Sandbox PTY connection interrupted"))
              }
              signal.addEventListener("abort", abort, { once: true })

              socket.addEventListener("message", (event) => {
                if (event.data instanceof ArrayBuffer) {
                  const bytes = new Uint8Array(event.data)
                  if (bytes[0] !== 0) return
                  try {
                    const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(1))) as { cursor?: unknown }
                    if (typeof meta.cursor !== "number" || !Number.isSafeInteger(meta.cursor)) return
                    cursor = meta.cursor
                    settled = true
                    signal.removeEventListener("abort", abort)
                    resolveAttachment({
                      replay: replay.join(""),
                      cursor,
                      write: (data) => socket.send(data),
                      activate: () => {
                        if (active) return
                        active = true
                        for (const chunk of pending) input.onData(chunk)
                        pending.length = 0
                      },
                      detach: () => socket.close(1000),
                    })
                  } catch {}
                  return
                }
                if (typeof event.data !== "string") return
                if (cursor === undefined) {
                  replay.push(event.data)
                  return
                }
                if (active) input.onData(event.data)
                else pending.push(event.data)
              })
              socket.addEventListener("close", () => {
                signal.removeEventListener("abort", abort)
                if (!settled) reject(new MissingPty())
                else input.onEnd({})
              })
              socket.addEventListener("error", () => {
                if (!settled) reject(new Error("Failed to connect to sandbox PTY"))
              })
            }),
          catch: (cause) => cause,
        }).pipe(
          Effect.catch((cause) =>
            cause instanceof MissingPty ? Effect.fail(new Pty.NotFoundError({ ptyID: id })) : Effect.die(cause),
          ),
        )
      })

    return PtyRuntime.Service.of({
      requiresTicket: true,
      requiresSession: true,
      list: (sessionID) =>
        request<Pty.Info[]>(sessionID, "/pty", undefined).pipe(
          Effect.catchTag("Pty.NotFoundError", () => Effect.succeed([])),
        ),
      get: (sessionID, id) => request(sessionID, `/pty/${id}`, undefined),
      create: (sessionID, input) =>
        Effect.gen(function* () {
          const root = yield* scope.resolve(sessionID as SessionID).pipe(Effect.orDie)
          const kept = yield* sandbox.isKeepAlive(root.id)
          yield* sandbox.keepAlive(root.id)
          const created = yield* request<Pty.Info>(
            sessionID,
            "/pty",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ ...input, cwd: "/workspace" }),
            },
            true,
          ).pipe(
            Effect.catchTag("Pty.NotFoundError", Effect.die),
            Effect.tapCause(() => kept ? Effect.void : sandbox.release(root.id)),
          )
          yield* resolve(sessionID, false).pipe(Effect.orDie)
          return created
        }),
      update: (sessionID, id, input) =>
        request(sessionID, `/pty/${id}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      remove: (sessionID, id) =>
        request<void>(sessionID, `/pty/${id}`, { method: "DELETE" }).pipe(
          Effect.tap(() =>
            Effect.promise(async () => {
              const root = await runPromise(scope.resolve(sessionID as SessionID))
              const target = await runPromise(resolve(sessionID, false))
              const all = (await fetch(agentURL(target.endpoint, "/pty", "*")).then((response) => response.json())) as Pty.Info[]
              if (!all.some((item) => item.status === "running")) {
                relays.get(root.id)?.abort()
                relays.delete(root.id)
                await runPromise(sandbox.release(root.id))
                const confirmed = (await fetch(agentURL(target.endpoint, "/pty", "*")).then((response) => response.json())) as Pty.Info[]
                if (confirmed.some((item) => item.status === "running")) {
                  await runPromise(sandbox.keepAlive(root.id))
                  await startRelay(root.id, target.endpoint)
                }
              }
            }).pipe(Effect.ignore),
          ),
        ),
      attach,
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(SandboxPtyScope.layer))
