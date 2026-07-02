export * as Pty from "./pty"

import { makeLocationNode } from "./effect/app-node"
import type { Disp, Proc } from "#pty"
import { Context, Effect, Layer, Schema, Types } from "effect"
import { Pty } from "@opencode-ai/schema/pty"
import { Config } from "./config"
import { EventV2 } from "./event"
import { Location } from "./location"
import { PtyID } from "./pty/schema"
import { lazy } from "./util/lazy"

const BUFFER_LIMIT = 1024 * 1024 * 2
const BUFFER_CHUNK = 64 * 1024
const encoder = new TextEncoder()
const pty = lazy(() => import("#pty"))

type Socket = {
  readyState: number
  data?: unknown
  send: (data: string | Uint8Array | ArrayBuffer) => void
  close: (code?: number, reason?: string) => void
}

type Active = {
  info: Info
  process: Proc
  buffer: string
  bufferCursor: number
  cursor: number
  subscribers: Map<unknown, Socket>
  listeners: Disp[]
}

const sock = (ws: Socket) => (ws.data && typeof ws.data === "object" ? ws.data : ws)

const meta = (cursor: number) => {
  const json = JSON.stringify({ cursor })
  const bytes = encoder.encode(json)
  const out = new Uint8Array(bytes.length + 1)
  out[0] = 0
  out.set(bytes, 1)
  return out
}

export const Info = Pty.Info
export type Info = Types.DeepMutable<typeof Info.Type>

export const CreateInput = Pty.CreateInput

export type CreateInput = Types.DeepMutable<typeof CreateInput.Type>

export type PreparedCreate = {
  readonly command: string
  readonly args: string[]
  readonly cwd: string
  readonly title?: string
  readonly env: Record<string, string>
}

export const UpdateInput = Pty.UpdateInput

export type UpdateInput = Types.DeepMutable<typeof UpdateInput.Type>

export const Event = Pty.Event

export type AttachInput = {
  // Absolute output cursor to replay from. -1 tails from the current end; omitted replays the full retained buffer.
  readonly cursor?: number
  // Callbacks fire synchronously from the native PTY data path; keep them non-blocking.
  readonly onData: (chunk: string) => void
  // Fired once when the session stops producing output: process exit (exitCode set), removal, or service teardown.
  readonly onEnd: (event: { exitCode?: number }) => void
}

export type Attachment = {
  // Retained output from the requested cursor to the current end.
  readonly replay: string
  // Absolute output cursor after replay.
  readonly cursor: number
  readonly write: (data: string) => void
  // Starts live delivery after the caller has applied replay and cursor metadata.
  readonly activate: () => void
  readonly detach: () => void
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Pty.NotFoundError", {
  ptyID: PtyID,
}) {}

export class ExitedError extends Schema.TaggedErrorClass<ExitedError>()("Pty.ExitedError", {
  ptyID: PtyID,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<Info[]>
  readonly get: (id: PtyID) => Effect.Effect<Info, NotFoundError>
  readonly create: (input: PreparedCreate) => Effect.Effect<Info>
  readonly update: (id: PtyID, input: UpdateInput) => Effect.Effect<Info, NotFoundError>
  readonly remove: (id: PtyID) => Effect.Effect<void, NotFoundError>
  readonly resize: (id: PtyID, cols: number, rows: number) => Effect.Effect<void, NotFoundError>
  readonly write: (id: PtyID, data: string) => Effect.Effect<void, NotFoundError>
  readonly connect: (
    id: PtyID,
    ws: Socket,
    cursor?: number,
  ) => Effect.Effect<
    { onMessage: (message: string | ArrayBuffer) => void; onClose: () => void } | undefined,
    NotFoundError
  >
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Pty") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const location = yield* Location.Service
    const context = yield* Effect.context()
    const runFork = Effect.runForkWith(context)
    const sessions = new Map<PtyID, Active>()

    function teardown(session: Active) {
      for (const listener of session.listeners) listener.dispose()
      session.listeners.length = 0
      try {
        session.process.kill()
      } catch {}
      for (const [sub, ws] of session.subscribers.entries()) {
        try {
          if (sock(ws) === sub) ws.close()
        } catch {}
      }
      session.subscribers.clear()
    }

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const session of sessions.values()) teardown(session)
        sessions.clear()
      }),
    )

    const requireSession = Effect.fn("Pty.requireSession")(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return yield* new NotFoundError({ ptyID: id })
      return session
    })

    const removeSession = Effect.fnUntraced(function* (id: PtyID) {
      const session = sessions.get(id)
      if (!session) return false
      sessions.delete(id)
      yield* Effect.logInfo("removing session", { id })
      teardown(session)
      yield* events.publish(Event.Deleted, { id: session.info.id })
      return true
    })

    const remove = Effect.fn("Pty.remove")(function* (id: PtyID) {
      yield* requireSession(id)
      yield* removeSession(id)
    })

    const list = Effect.fn("Pty.list")(function* () {
      return Array.from(sessions.values()).map((session) => session.info)
    })

    const get = Effect.fn("Pty.get")(function* (id: PtyID) {
      return (yield* requireSession(id)).info
    })

    const create = Effect.fn("Pty.create")(function* (input: PreparedCreate) {
      const id = PtyID.ascending()
      yield* Effect.logInfo("creating session", { id, cmd: input.command, args: input.args, cwd: input.cwd })
      const { spawn } = yield* Effect.promise(() => pty())
      const proc = yield* Effect.sync(() =>
        spawn(input.command, input.args, {
          name: "xterm-256color",
          cwd: input.cwd,
          env: input.env,
        }),
      )
      const info = {
        id,
        title: input.title || `Terminal ${id.slice(-4)}`,
        command: input.command,
        args: input.args,
        cwd: input.cwd,
        status: "running",
        pid: proc.pid,
      } as const
      const session: Active = {
        info,
        process: proc,
        buffer: "",
        bufferCursor: 0,
        cursor: 0,
        subscribers: new Map(),
        listeners: [],
      }
      sessions.set(id, session)
      session.listeners.push(
        proc.onData((chunk) => {
          session.cursor += chunk.length
          for (const [key, ws] of session.subscribers.entries()) {
            if (ws.readyState !== 1 || sock(ws) !== key) {
              session.subscribers.delete(key)
              continue
            }
            try {
              ws.send(chunk)
            } catch {
              session.subscribers.delete(key)
            }
          }
          session.buffer += chunk
          if (session.buffer.length <= BUFFER_LIMIT) return
          const excess = session.buffer.length - BUFFER_LIMIT
          session.buffer = session.buffer.slice(excess)
          session.bufferCursor += excess
        }),
        proc.onExit(({ exitCode }) => {
          if (session.info.status === "exited") return
          runFork(
            Effect.gen(function* () {
              yield* Effect.logInfo("session exited", { id, exitCode })
              session.info.status = "exited"
              yield* events.publish(Event.Exited, { id, exitCode })
              yield* removeSession(id)
            }),
          )
        }),
      )
      yield* events.publish(Event.Created, { info })
      return info
    })

    const update = Effect.fn("Pty.update")(function* (id: PtyID, input: UpdateInput) {
      const session = yield* requireSession(id)
      if (input.title) session.info.title = input.title
      if (input.size) session.process.resize(input.size.cols, input.size.rows)
      yield* events.publish(Event.Updated, { info: session.info })
      return session.info
    })

    const resize = Effect.fn("Pty.resize")(function* (id: PtyID, cols: number, rows: number) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") session.process.resize(cols, rows)
    })

    const write = Effect.fn("Pty.write")(function* (id: PtyID, data: string) {
      const session = yield* requireSession(id)
      if (session.info.status === "running") session.process.write(data)
    })

    const connect = Effect.fn("Pty.connect")(function* (id: PtyID, ws: Socket, cursor?: number) {
      const session = yield* requireSession(id).pipe(Effect.tapError(() => Effect.sync(() => ws.close())))
      yield* Effect.logInfo("client connected to session", { id, directory: location.directory })
      const sub = sock(ws)
      session.subscribers.delete(sub)
      session.subscribers.set(sub, ws)
      const cleanup = () => session.subscribers.delete(sub)
      const start = session.bufferCursor
      const end = session.cursor
      const from =
        cursor === -1 ? end : typeof cursor === "number" && Number.isSafeInteger(cursor) ? Math.max(0, cursor) : 0
      const data = (() => {
        if (!session.buffer || from >= end) return ""
        const offset = Math.max(0, from - start)
        if (offset >= session.buffer.length) return ""
        return session.buffer.slice(offset)
      })()
      if (data) {
        try {
          for (let i = 0; i < data.length; i += BUFFER_CHUNK) ws.send(data.slice(i, i + BUFFER_CHUNK))
        } catch {
          cleanup()
          ws.close()
          return
        }
      }
      try {
        ws.send(meta(end))
      } catch {
        cleanup()
        ws.close()
        return
      }
      return {
        onMessage: (message: string | ArrayBuffer) => {
          session.process.write(typeof message === "string" ? message : new TextDecoder().decode(message))
        },
        onClose: () => {
          cleanup()
        },
      }
    })

    return Service.of({ list, get, create, update, remove, resize, write, connect })
  }),
)

export const locationLayer = layer.pipe(Layer.provide(Config.locationLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Location.node, Config.node] })
