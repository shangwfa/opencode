import { Effect, Schema } from "effect"
import type { SandboxProvider } from "../sandbox/provider.js"

/**
 * Shared sandbox markdown discovery for the Session-scoped definition sources (Agents,
 * Commands, and any later ones). The scan protocol, name validation, read bounds, fingerprint
 * parsing, and the incremental definition cache live here so those features cannot drift apart.
 * Host-side discovery (`config/plugin/*`) is a different I/O and invalidation model and stays
 * separate; it already shares the `ConfigMarkdown` decode layer.
 */

/** Upper bound on markdown files a single sandbox scan will read. */
export const MAX_SCAN_FILES = 200

/** Bound sandbox output before it reaches a log line or an error message. */
export function truncateForError(value: string, max = 500) {
  const trimmed = value.trim()
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`
}

/** A definition name may use Unicode letters/numbers plus `._/-`, but never an empty or traversing segment. */
export function validName(name: string) {
  return (
    name.length > 0 &&
    /^[\p{L}\p{N}._/-]+$/u.test(name) &&
    name.split("/").every((part) => part && part !== "." && part !== "..")
  )
}

export interface ScannedFile {
  /** Absolute path inside the sandbox. */
  readonly path: string
  /** Path below its discovery directory, keeping the `.md` suffix. */
  readonly relative: string
  /** Relative path without the `.md` suffix. */
  readonly id: string
  /** `mtime:size` from the scan; changes whenever the file content changes. */
  readonly fingerprint: string
}

export interface ScanResult {
  readonly files: ScannedFile[]
  /** Markdown entries accepted under a discovery directory, before the read cap. */
  readonly discovered: number
  /** Entries under a discovery directory whose derived name is not a usable definition ID. */
  readonly skipped: number
}

/**
 * Parses `find -printf '%p\t%T@\t%s\n'` output into scan entries. A path may contain tabs or
 * newlines, so each line is split from the right: `mtime` and `size` never contain a tab.
 * Names are validated before the read cap so unusable files cannot crowd out real definitions.
 */
export function parseScanOutput(output: string, prefixes: readonly string[], limit = MAX_SCAN_FILES): ScanResult {
  const seen = new Map<string, ScannedFile>()
  let skipped = 0
  for (const line of output.split("\n")) {
    if (!line) continue
    const sizeEnd = line.lastIndexOf("\t")
    if (sizeEnd < 0) continue
    const timeEnd = line.lastIndexOf("\t", sizeEnd - 1)
    if (timeEnd < 0) continue
    const path = line.slice(0, timeEnd)
    const fingerprint = line.slice(timeEnd + 1)
    const prefix = prefixes.find((item) => path.startsWith(item))
    if (!prefix || !path.endsWith(".md")) continue
    const relative = path.slice(prefix.length).replaceAll("\\", "/")
    const id = relative.replace(/\.md$/i, "")
    if (!validName(id)) {
      skipped++
      continue
    }
    seen.set(path, { path, relative, id, fingerprint })
  }
  const sorted = [...seen.values()].sort((a, b) => a.path.localeCompare(b.path))
  return { files: sorted.slice(0, limit), discovered: sorted.length, skipped }
}

export interface CachedDefinition<D> {
  readonly fingerprint: string
  readonly definition: D | undefined
}

/**
 * Process-local cache of sandbox markdown definitions, keyed by Session and then by sandbox
 * path. Entries expire by fingerprint, so a rewritten file is re-read on the next scan and a
 * deleted file falls out of both the cache and the result. The bound is a simple FIFO cap so
 * a long-lived process cannot grow without limit across many Sessions.
 *
 * Each Session records the start time of the scan that produced its entry. A scan that took
 * its listing earlier but finishes later must not overwrite a newer one, so a write is rejected
 * when a scan that started after it has already stored its result.
 */
export class SandboxDefinitionCache<D> {
  private readonly sessions = new Map<string, { at: number; files: Map<string, CachedDefinition<D>> }>()

  constructor(private readonly limit = 256) {}

  read(sessionID: string): Map<string, CachedDefinition<D>> {
    return this.sessions.get(sessionID)?.files ?? new Map()
  }

  write(sessionID: string, files: Map<string, CachedDefinition<D>>, at = Date.now()): boolean {
    const current = this.sessions.get(sessionID)
    if (current !== undefined && current.at > at) return false
    this.sessions.delete(sessionID)
    if (files.size > 0) this.sessions.set(sessionID, { at, files })
    while (this.sessions.size > this.limit) {
      const oldest = this.sessions.keys().next().value
      if (oldest === undefined) break
      this.sessions.delete(oldest)
    }
    return true
  }

  /**
   * Drops a Session's cached definitions. Currently *not* wired into any production path:
   * freshness comes from the fingerprint plus dropping files that disappear from the listing, so a
   * rebuilt sandbox re-reads on its own. Kept for a future sandbox-lifecycle hook (explicit
   * destroy) — treat it as reserved API, not as a covered production behavior.
   */
  invalidate(sessionID: string): void {
    this.sessions.delete(sessionID)
  }
}

export interface IncrementalScan<D> {
  readonly definitions: D[]
  /** Files that had to be read and decoded during this scan. */
  readonly changed: number
}

/**
 * A single file's load outcome. `cacheable` is false when a transient failure (sandbox read
 * error, or a path that vanished between `find` and the read) must be retried next scan
 * instead of being frozen against the current fingerprint.
 */
export interface LoadedDefinition<D> {
  readonly definition: D | undefined
  readonly cacheable: boolean
}

/**
 * Reads only the files whose fingerprint changed since the previous scan. Unchanged files
 * reuse their cached definition, files that disappeared drop out with the cache, and `force`
 * re-reads everything so an explicit refresh can recover from a change the fingerprint missed.
 * A non-cacheable outcome keeps the last known definition and leaves the stale fingerprint in
 * place, so the file is retried on the next scan without disappearing from the list.
 */
export function scanIncremental<D>(
  cache: SandboxDefinitionCache<D>,
  sessionID: string,
  files: readonly ScannedFile[],
  load: (file: ScannedFile) => Effect.Effect<LoadedDefinition<D>>,
  options: { readonly force?: boolean; readonly at?: number } = {},
): Effect.Effect<IncrementalScan<D>> {
  return Effect.gen(function* () {
    const previous = cache.read(sessionID)
    const next = new Map<string, CachedDefinition<D>>()
    const pending: ScannedFile[] = []
    for (const file of files) {
      const cached = options.force ? undefined : previous.get(file.path)
      if (cached !== undefined && cached.fingerprint === file.fingerprint) {
        next.set(file.path, cached)
        continue
      }
      pending.push(file)
    }
    const loaded = yield* Effect.forEach(
      pending,
      (file) => load(file).pipe(Effect.map((outcome) => [file, outcome] as const)),
      { concurrency: 8 },
    )
    for (const [file, outcome] of loaded) {
      if (outcome.cacheable) {
        next.set(file.path, { fingerprint: file.fingerprint, definition: outcome.definition })
        continue
      }
      // Transient failure: keep the last known definition (if any) under its old fingerprint so
      // the next scan retries this file rather than caching the failure.
      const stale = previous.get(file.path)
      if (stale !== undefined) next.set(file.path, stale)
    }
    cache.write(sessionID, next, options.at ?? Date.now())
    return {
      definitions: files.flatMap((file) => {
        const definition = next.get(file.path)?.definition
        return definition === undefined ? [] : [definition]
      }),
      changed: pending.length,
    }
  })
}

export class SandboxScanFailure extends Schema.TaggedError<SandboxScanFailure>()("Sandbox.ScanFailed", {
  message: Schema.String,
}) {}

export interface SandboxMarkdownScan<D> {
  readonly sessionID: string
  /** Host directory of the owning Session, forwarded to the sandbox command. */
  readonly directory: string
  readonly sandbox: Pick<SandboxProvider.Interface, "enabled" | "run" | "fileRead">
  /** Singular feature name used in errors and logs, e.g. `Agent` or `command`. */
  readonly label: string
  /** Absolute sandbox directories to discover markdown under. */
  readonly prefixes: readonly string[]
  readonly cache: SandboxDefinitionCache<D>
  /** Builds the feature definition, or `undefined` when the document is not a valid one. */
  readonly decode: (file: ScannedFile, content: string) => D | undefined
  /** Re-reads every file even when its fingerprint is unchanged. */
  readonly force?: boolean
}

/** Quotes discovery directories for the shell; they are fixed constants, never user input. */
function scanCommand(prefixes: readonly string[]) {
  const directories = prefixes
    .map((prefix) => prefix.replace(/\/$/, "").replaceAll("'", `'\\''`))
    .map((directory) => `'${directory}'`)
    .join(" ")
  return `for d in ${directories}; do [ ! -d "$d" ] || find "$d" -type f -name '*.md' -printf '%p\\t%T@\\t%s\\n'; done`
}

function readDefinition<D>(
  input: SandboxMarkdownScan<D>,
  file: ScannedFile,
): Effect.Effect<LoadedDefinition<D>, never, never> {
  return Effect.gen(function* () {
    const { decode, label, sandbox, sessionID } = input
    if (!validName(file.id)) {
      yield* Effect.logDebug(`Skipped sandbox ${label} file with an invalid ID`, {
        sessionID,
        sourcePath: file.relative,
      })
      return { definition: undefined, cacheable: true }
    }
    const raw = yield* sandbox.fileRead(sessionID, file.path).pipe(
      Effect.tapError(() =>
        Effect.logWarning(`Failed to read sandbox ${label} file`, { sessionID, sourcePath: file.relative }),
      ),
      Effect.catch(() => Effect.succeed(null)),
    )
    // `null` also covers a path that vanished between `find` and this read: retry next scan
    // rather than freeze a transient miss against the current fingerprint.
    if (raw === null) return { definition: undefined, cacheable: false }
    const definition = decode(file, raw)
    if (definition === undefined) {
      yield* Effect.logWarning(`Skipped sandbox ${label} file that is not a valid definition`, {
        sessionID,
        sourcePath: file.relative,
      })
      return { definition: undefined, cacheable: true }
    }
    return { definition, cacheable: true }
  })
}

/**
 * Discovers markdown definitions in a Session sandbox in one shell call, then reads only the
 * files whose fingerprint changed. A scan failure is typed so an explicit refresh can report it.
 */
export function scanSandboxMarkdown<D>(input: SandboxMarkdownScan<D>): Effect.Effect<D[], SandboxScanFailure> {
  return Effect.gen(function* () {
    const { cache, directory, label, prefixes, sandbox, sessionID } = input
    if (!sandbox.enabled) return []
    const startedAt = Date.now()
    const result = yield* sandbox
      .run({
        sessionID,
        command: scanCommand(prefixes),
        cwd: "/workspace",
        hostWorkdir: directory,
        timeoutMs: 10_000,
        // Discovery is read-only and idempotent, so the provider may repair a
        // stale command context and replay this one command once.
        retryPolicy: "safe-read",
      })
      .pipe(
        Effect.mapError(
          (error) => new SandboxScanFailure({ message: `Sandbox ${label} scan failed: ${String(error)}` }),
        ),
      )
    if (result.timedOut)
      return yield* Effect.fail(new SandboxScanFailure({ message: `Sandbox ${label} scan timed out` }))
    if (result.exitCode !== 0)
      return yield* Effect.fail(
        new SandboxScanFailure({ message: `Sandbox ${label} scan failed: ${truncateForError(result.output)}` }),
      )
    const { files, discovered, skipped } = parseScanOutput(result.output, prefixes)
    if (files.length < discovered)
      yield* Effect.logWarning(`Sandbox ${label} scan truncated`, { sessionID, discovered, limit: files.length })
    if (skipped > 0)
      yield* Effect.logWarning(`Sandbox ${label} scan skipped unusable definition names`, { sessionID, skipped })
    const { definitions, changed } = yield* scanIncremental(
      cache,
      sessionID,
      files,
      (file) => readDefinition(input, file),
      // `startedAt` is the listing time: a scan that listed earlier must not overwrite a newer one.
      { force: input.force === true, at: startedAt },
    )
    // Counts and timing only; file contents stay out of logs.
    yield* Effect.logInfo(`Sandbox ${label} scan completed`, {
      sessionID,
      source: "sandbox" as const,
      discovered,
      changed,
      cached: files.length - changed,
      loaded: definitions.length,
      forced: input.force === true,
      durationMs: Date.now() - startedAt,
    })
    return definitions
  })
}

/**
 * Read-path discovery: a sandbox hiccup must not fail prompt admission or permission
 * resolution, so this degrades to no definitions and logs why. Explicit refreshes should use
 * `scanSandboxMarkdown` so they can report the failure.
 */
export function scanSandboxMarkdownBestEffort<D>(input: SandboxMarkdownScan<D>): Effect.Effect<D[]> {
  return scanSandboxMarkdown(input).pipe(
    Effect.catchTag("Sandbox.ScanFailed", (error) =>
      Effect.logWarning(`Sandbox ${input.label} scan failed; continuing without definitions`, {
        sessionID: input.sessionID,
        message: error.message,
      }).pipe(Effect.as([] as D[])),
    ),
  )
}
