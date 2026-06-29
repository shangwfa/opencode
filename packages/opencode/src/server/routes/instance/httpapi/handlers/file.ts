import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SandboxProvider } from "@/tool/sandbox-provider"
import { toSandboxPath } from "@/tool/sandbox-path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Effect, Duration, Layer, Option } from "effect"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder, HttpApiError } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import type { SessionID } from "@/session/schema"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      if (Flag.OPENCODE_SANDBOX_ENABLED) {
        yield* Effect.logWarning("findText not supported in sandbox mode; use session-scoped search instead")
        return yield* new HttpApiError.BadRequest({})
      }
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      if (Flag.OPENCODE_SANDBOX_ENABLED) {
        yield* Effect.logWarning("findFile not supported in sandbox mode; use session-scoped search instead")
        return yield* new HttpApiError.BadRequest({})
      }
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })))
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
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
            .map((l: any) => (typeof l === "string" ? l : l.text ?? ""))
            .join("")
            .split("\n")
            .map((t: string) => t.trim())
            .filter((t: string) => t.length > 0)
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
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.project.directory, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.project.directory, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.project.directory, path.resolve(location.directory, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
        }),
      )
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
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "text" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.flatMap((item) =>
          Effect.gen(function* () {
            const text = item.content.includes(0)
              ? Option.none<string>()
              : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.content)).pipe(
                  Effect.option,
                )
            return { item, text }
          }),
        ),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value.trim() }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
).pipe(Layer.provide(locationServiceMapLayer))
