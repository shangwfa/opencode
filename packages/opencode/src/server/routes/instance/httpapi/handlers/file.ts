import * as InstanceState from "@/effect/instance-state"
import { File } from "@/file"
import { Ripgrep } from "@/file/ripgrep"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { toSandboxPath } from "@/tool/sandbox-path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Duration } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { SessionID } from "@/session/schema"
import path from "path"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* File.Service
    const ripgrep = yield* Ripgrep.Service

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .search({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).items
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      return yield* svc.search({
        query: ctx.query.query,
        limit: ctx.query.limit ?? 10,
        dirs: ctx.query.dirs !== "false",
        type: ctx.query.type,
      })
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string; sessionID?: string } }) {
      const sessionID = ctx.query.sessionID as SessionID | undefined
      if (Flag.OPENCODE_SANDBOX_ENABLED && sessionID) {
        const instance = yield* InstanceState.context
        const sp = yield* Effect.serviceOption(SandboxProvider.Service)
        if (sp._tag === "Some") {
          const sb = yield* sp.value.getOrCreate(sessionID).pipe(Effect.orDie)
          const sandboxPath = toSandboxPath(
            path.isAbsolute(ctx.query.path) ? ctx.query.path : path.join(instance.directory, ctx.query.path),
            instance.directory,
          )
          const result = yield* sp.value
            .runInSession(sessionID, `ls -1ap "${sandboxPath}" 2>/dev/null`, { timeoutSeconds: 10 })
            .pipe(Effect.orDie)
          const items = result.logs.stdout
            .map((l: any) => l.text)
            .join("\n")
            .split("\n")
            .filter((t: string) => t && !t.startsWith("total "))
            .filter((t: string) => t !== "." && t !== ".." && t !== "./" && t !== "../")
            .sort()
          return items.map((entry: string) => {
            const isDir = entry.endsWith("/")
            const name = isDir ? entry.slice(0, -1) : entry
            const filePath = ctx.query.path ? `${ctx.query.path}/${name}` : name
            const absHost = `${instance.directory}/${filePath}`
            return {
              name,
              path: filePath,
              absolute: toSandboxPath(absHost, instance.directory),
              type: isDir ? ("directory" as const) : ("file" as const),
              ignored: false,
            }
          }) as any
        }
      }
      return yield* svc.list(ctx.query.path)
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string; sessionID?: string } }) {
      const sessionID = ctx.query.sessionID as SessionID | undefined
      if (Flag.OPENCODE_SANDBOX_ENABLED && sessionID) {
        const instance = yield* InstanceState.context
        const sp = yield* Effect.serviceOption(SandboxProvider.Service)
        if (sp._tag === "Some") {
          const sb = yield* sp.value.getOrCreate(sessionID).pipe(Effect.orDie)
          const full = path.isAbsolute(ctx.query.path)
            ? ctx.query.path
            : path.join(instance.directory, ctx.query.path)
          const sandboxPath = toSandboxPath(full, instance.directory)
          const text = yield* Effect.tryPromise({
            try: () => sb.files.readFile(sandboxPath) as Promise<string>,
            catch: () => new Error("read failed"),
          }).pipe(
            Effect.catch(() => Effect.succeed("")),
            Effect.timeoutOrElse({
              duration: Duration.seconds(15),
              orElse: () => Effect.succeed(""),
            }),
          )
          return { type: "text" as const, content: text } as any
        }
      }
      return yield* svc.read(ctx.query.path)
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return yield* svc.status()
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
)
