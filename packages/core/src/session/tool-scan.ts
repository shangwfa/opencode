import { Effect } from "effect"
import { SessionTool } from "@opencode/schema/session-tool"
import type { SandboxProvider } from "../sandbox/provider.js"
import type { Session } from "../session.js"
import { SandboxDefinitionCache, type CachedDefinition } from "./scan.js"

const directories = ["/workspace/.opencode/tool", "/workspace/.opencode/tools"] as const
const maxFiles = 200
const cache = new SandboxDefinitionCache<SessionTool.Info>()

interface Entry {
  readonly path: string
  readonly name: SessionTool.Name
  readonly fingerprint: string
  readonly size: number
  readonly sourceRank: number
  readonly extensionRank: number
}

/** `tools/` is the canonical spelling; legacy `tool/` files remain compatible. */
export function parseSandboxToolScan(output: string) {
  const entries = new Map<string, Entry>()
  let skipped = 0
  for (const line of output.split("\n")) {
    if (!line) continue
    const sizeEnd = line.lastIndexOf("\t")
    const timeEnd = sizeEnd < 0 ? -1 : line.lastIndexOf("\t", sizeEnd - 1)
    if (sizeEnd < 0 || timeEnd < 0) continue
    const path = line.slice(0, timeEnd)
    const prefix = directories.find((directory) => path.startsWith(`${directory}/`))
    if (!prefix) continue
    const filename = path.slice(prefix.length + 1)
    if (filename.includes("/") || filename.includes("\\")) continue
    const extension = filename.endsWith(".ts") ? ".ts" : filename.endsWith(".js") ? ".js" : undefined
    if (!extension) continue
    const rawName = filename.slice(0, -extension.length)
    let name: SessionTool.Name
    try {
      name = SessionTool.Name.make(rawName)
    } catch {
      skipped++
      continue
    }
    const entry: Entry = {
      path,
      name,
      fingerprint: line.slice(timeEnd + 1),
      size: Number(line.slice(sizeEnd + 1)),
      sourceRank: prefix.endsWith("/tools") ? 1 : 0,
      extensionRank: extension === ".ts" ? 1 : 0,
    }
    const previous = entries.get(name)
    if (
      !previous ||
      entry.sourceRank > previous.sourceRank ||
      (entry.sourceRank === previous.sourceRank && entry.extensionRank > previous.extensionRank)
    )
      entries.set(name, entry)
  }
  return { entries: [...entries.values()].toSorted((a, b) => a.name.localeCompare(b.name)), skipped }
}

/** Scan project tools in the owning Session Sandbox; source code never executes in the SaaS process. */
export function scanSandboxTools(
  session: Session.Info,
  sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">,
) {
  return Effect.gen(function* () {
    if (!sandbox.enabled) return []
    const startedAt = Date.now()
    const roots = directories.map((directory) => `'${directory}'`).join(" ")
    const result = yield* sandbox.run({
      sessionID: session.id,
      command: `for d in ${roots}; do [ ! -d "$d" ] || find "$d" -maxdepth 1 -type f \\( -name '*.ts' -o -name '*.js' \\) -printf '%p\\t%T@\\t%s\\n'; done`,
      cwd: "/workspace",
      hostWorkdir: session.location.directory,
      timeoutMs: 10_000,
      retryPolicy: "safe-read",
    })
    if (result.timedOut) return yield* Effect.fail(new Error("Sandbox session tool scan timed out"))
    if (result.exitCode !== 0)
      return yield* Effect.fail(new Error(`Sandbox session tool scan failed: ${result.output.slice(0, 500)}`))

    const parsed = parseSandboxToolScan(result.output)
    const files = parsed.entries.slice(0, maxFiles)
    if (parsed.entries.length > maxFiles)
      yield* Effect.logWarning("Sandbox session tool scan truncated", {
        sessionID: session.id,
        discovered: parsed.entries.length,
        limit: maxFiles,
      })
    if (parsed.skipped > 0)
      yield* Effect.logWarning("Sandbox session tool scan skipped invalid names", {
        sessionID: session.id,
        skipped: parsed.skipped,
      })

    const previous = cache.read(session.id)
    const next = new Map<string, CachedDefinition<SessionTool.Info>>()
    const changed = files.filter((file) => previous.get(file.path)?.fingerprint !== file.fingerprint)
    const loaded = yield* Effect.forEach(
      changed,
      (file) =>
        Effect.gen(function* () {
          if (file.size > SessionTool.MaxCodeBytes) {
            yield* Effect.logWarning("Sandbox session tool source exceeds the size limit", {
              sessionID: session.id,
              name: file.name,
              size: file.size,
              limit: SessionTool.MaxCodeBytes,
            })
            return [file, undefined] as const
          }
          const code = yield* sandbox.fileRead(session.id, file.path)
          if (code === null)
            return yield* Effect.fail(new Error(`Sandbox session tool disappeared during scan: ${file.name}`))
          const size = Buffer.byteLength(code, "utf8")
          if (size > SessionTool.MaxCodeBytes) {
            yield* Effect.logWarning("Sandbox session tool source exceeds the size limit", {
              sessionID: session.id,
              name: file.name,
              size,
              limit: SessionTool.MaxCodeBytes,
            })
            return [file, undefined] as const
          }
          const now = Date.now()
          return [
            file,
            SessionTool.Info.make({
              id: SessionTool.ID.create(),
              name: file.name,
              description: "",
              code,
              time: { created: now, updated: now },
            }),
          ] as const
        }),
      { concurrency: 8 },
    )
    for (const file of files) {
      const cached = previous.get(file.path)
      const current = loaded.find(([entry]) => entry.path === file.path)?.[1]
      const definition = cached?.fingerprint === file.fingerprint ? cached.definition : current
      if (definition !== undefined || current === undefined)
        next.set(file.path, { fingerprint: file.fingerprint, definition })
    }
    cache.write(session.id, next, startedAt)
    const definitions = files.flatMap((file) => {
      const definition = next.get(file.path)?.definition
      return definition ? [definition] : []
    })
    yield* Effect.logInfo("Sandbox session tool scan completed", {
      sessionID: session.id,
      discovered: parsed.entries.length,
      changed: changed.length,
      loaded: definitions.length,
      durationMs: Date.now() - startedAt,
    })
    return definitions
  })
}
