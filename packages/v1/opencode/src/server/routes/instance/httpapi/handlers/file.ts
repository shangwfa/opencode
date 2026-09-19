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
import { WorkspaceSearchPayload, WorkspaceSearchResult } from "../groups/file"
import { ServiceUnavailableError } from "../errors"
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
      query: {
        query: string
        sessionID: string
        dirs?: "true" | "false"
        type?: "file" | "directory"
        limit?: number
      }
    }) {
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : ctx.query.dirs === "true" ? undefined : "file")
      const started = performance.now()

      const sessionID = ctx.query.sessionID as SessionID
      const sp = yield* Effect.serviceOption(SandboxProvider.Service)
      if (sp._tag === "None")
        return yield* Effect.die(new Error("SandboxProvider not available"))

      const escapedQuery = ctx.query.query.replace(/'/g, "'\\''")
      const wantsFiles = type !== "directory"
      const wantsDirs = type === "directory" || ctx.query.dirs === "true"
      const cmds: string[] = []
      if (wantsFiles)
        cmds.push(`rg --files --hidden /workspace 2>/dev/null | grep -iF -- '${escapedQuery}' | head -${limit}`)
      if (wantsDirs)
        cmds.push(
          `find /workspace -type d -not -path '*/.git/*' 2>/dev/null | sed 's|/workspace/||; s|$|/|' | grep -iF -- '${escapedQuery}' | head -${limit}`,
        )
      const cmd = cmds.join("; ")
      const result = yield* sp.value.runInSession(sessionID, cmd, { timeoutSeconds: 15 }).pipe(Effect.orDie)
      const stdout = result.logs.stdout.map((line: any) => (typeof line === "string" ? line : line.text)).join("\n").trim()
      const items = Array.from(
        new Set(
          stdout
            .split("\n")
            .filter(Boolean)
            .map((line: string) => line.replace(/^\/workspace\//, "").trim())
            .filter(Boolean),
        ),
      ).slice(0, limit)
      yield* Effect.logInfo("find file (sandbox)", {
        query: ctx.query.query,
        type,
        sessionID,
        limit,
        results: items.length,
        duration: Math.round(performance.now() - started),
      })
      return items.map((entry: string) => ({
        name: path.basename(entry),
        path: entry,
        absolute: path.posix.join("/workspace", entry),
        type: entry.endsWith("/") ? ("directory" as const) : ("file" as const),
        ignored: false,
      }))
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const searchWorkspace = Effect.fn("FileHttpApi.searchWorkspace")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof WorkspaceSearchPayload.Type
    }) {
      const started = performance.now()
      const sessionID = ctx.params.sessionID
      const sp = yield* Effect.serviceOption(SandboxProvider.Service)
      if (sp._tag === "None") return yield* Effect.die(new Error("SandboxProvider not available"))

      const isCaseSensitive = ctx.payload.isCaseSensitive ?? false
      const isRegExp = ctx.payload.isRegExp ?? false
      const isWholeWord = ctx.payload.isWholeWord ?? false
      const contextLines = ctx.payload.contextLines ?? 2
      const maxResults = ctx.payload.maxResults ?? 200

      const args = ["rg", "--json", "--hidden", "-g", shellQuote("!.git/*"), "--max-filesize", "10M", isCaseSensitive ? "-s" : "-i"]
      if (!isRegExp) args.push("-F")
      if (isWholeWord) args.push("-w")
      if (contextLines > 0) args.push("-C", String(contextLines))
      args.push("-m", String(maxResults))
      for (const glob of ctx.payload.include ?? []) args.push("-g", shellQuote(glob))
      for (const glob of ctx.payload.exclude ?? []) args.push("-g", shellQuote(glob.startsWith("!") ? glob : "!" + glob))
      args.push("--", shellQuote(ctx.payload.query), "/workspace")

      const result = yield* sp.value
        .runInSession(sessionID, args.join(" ") + " | head -c 16777216", { timeoutSeconds: 60 })
        .pipe(Effect.orDie)
      const stdout = result.logs.stdout.map((line: any) => (typeof line === "string" ? line : line.text)).join("\n")
      const parsed = parseRipgrepOutput(stdout, maxResults)
      const durationMs = Math.round(performance.now() - started)
      yield* Effect.logInfo("workspace search (sandbox)", {
        query: ctx.payload.query,
        sessionID,
        isRegExp,
        isCaseSensitive,
        isWholeWord,
        maxResults,
        files: parsed.files.length,
        matches: parsed.matches,
        truncated: parsed.truncated,
        duration: durationMs,
      })
      return {
        files: parsed.files,
        truncated: parsed.truncated,
        stats: { files_with_matches: parsed.files.length, matches: parsed.matches, duration_ms: durationMs },
      } as typeof WorkspaceSearchResult.Type
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string; sessionID?: string } }) {
      const sessionID = ctx.query.sessionID as SessionID | undefined
      if (Flag.OPENCODE_SANDBOX_ENABLED && sessionID) {
        const instance = yield* InstanceState.context
        const sp = yield* Effect.serviceOption(SandboxProvider.Service)
        if (sp._tag === "Some") {
          const sandboxPath = toSandboxPath(
            path.isAbsolute(ctx.query.path) ? ctx.query.path : path.join(instance.directory, ctx.query.path),
            instance.directory,
          )
          // 列目录走 runDetached（独立 command session，exec/async 同通道）而非
          // runInSession：前台 pnpm install 等长命令独占 commandSemaphore 时，
          // runInSession 的 ls 会排队超时，文件树被 install 阻塞数十秒到几分钟。
          // 远端 execd 无 /directories/list 路由（实测 404），files API 替代不了
          // 列目录，故用独立 session 的 ls 绕开命令队列。
          const result = yield* sp.value
            .runDetached(sessionID, `ls -1ap "${sandboxPath}" 2>/dev/null`, { timeoutSeconds: 10 })
            .pipe(
              Effect.mapError((error) =>
                new ServiceUnavailableError({
                  message: error instanceof Error ? error.message : String(error),
                  service: "sandbox",
                }),
              ),
            )
          const items = result.logs.stdout
            .map((l: any) => (typeof l === "string" ? l : l.text ?? ""))
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
      .handle("search", searchWorkspace)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
).pipe(Layer.provide(locationServiceMapLayer))

const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'"

type SearchContextLineOut = { line_number: number; text: string }
type SearchMatchOut = {
  line_number: number
  text: string
  ranges: Array<{ start: number; end: number }>
  before: SearchContextLineOut[]
  after: SearchContextLineOut[]
}
type SearchFileOut = { path: string; matches: SearchMatchOut[] }

const rgString = (v: unknown) => (typeof v === "string" ? v : undefined)
const rgNumber = (v: unknown) => (typeof v === "number" ? v : undefined)

// Parses `rg --json` NDJSON: match events carry submatches (highlight ranges);
// context events between matches are attributed to before/after by line number.
const parseRipgrepOutput = (stdout: string, maxResults: number) => {
  const files: SearchFileOut[] = []
  let current: SearchFileOut | undefined
  let pendingBefore: SearchContextLineOut[] = []
  let lastMatchLine = 0
  let total = 0
  let truncated = false
  for (const raw of stdout.split("\n")) {
    const line = raw.trim()
    if (!line.startsWith("{")) continue
    const ev = Option.getOrUndefined(Option.liftThrowable((s: string) => JSON.parse(s) as unknown)(line))
    if (typeof ev !== "object" || ev === null) continue
    const type = rgString((ev as { type?: unknown }).type)
    const data = (ev as { data?: unknown }).data
    if (type === undefined || typeof data !== "object" || data === null) continue
    if (type === "begin") {
      const p = rgString((data as { path?: unknown }).path && ((data as { path: { text?: unknown } }).path.text))
      if (p === undefined) continue
      current = { path: p.replace(/^\/workspace\//, ""), matches: [] }
      files.push(current)
      pendingBefore = []
      lastMatchLine = 0
    } else if (type === "match" && current) {
      if (total >= maxResults) {
        truncated = true
        continue
      }
      const text = rgString((data as { lines?: unknown }).lines && (data as { lines: { text?: unknown } }).lines.text)
      const lineNumber = rgNumber((data as { line_number?: unknown }).line_number) ?? 0
      const submatches = Array.isArray((data as { submatches?: unknown }).submatches) ? (data as { submatches: unknown[] }).submatches : []
      current.matches.push({
        line_number: lineNumber,
        text: (text ?? "").replace(/\r?\n$/, ""),
        ranges: submatches.flatMap((s: unknown) => {
          if (typeof s !== "object" || s === null) return []
          const start = rgNumber((s as { start?: unknown }).start)
          const end = rgNumber((s as { end?: unknown }).end)
          if (start === undefined || end === undefined) return []
          return [{ start, end }]
        }),
        before: pendingBefore,
        after: [],
      })
      pendingBefore = []
      lastMatchLine = lineNumber
      total++
    } else if (type === "context" && current) {
      const text = rgString((data as { lines?: unknown }).lines && (data as { lines: { text?: unknown } }).lines.text)
      const ctxLine = {
        line_number: rgNumber((data as { line_number?: unknown }).line_number) ?? 0,
        text: (text ?? "").replace(/\r?\n$/, ""),
      }
      if (ctxLine.line_number > lastMatchLine && current.matches.length > 0) current.matches[current.matches.length - 1].after.push(ctxLine)
      else pendingBefore.push(ctxLine)
    }
  }
  return { files: files.filter((f) => f.matches.length > 0), matches: total, truncated }
}
