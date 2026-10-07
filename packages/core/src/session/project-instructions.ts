export * as SessionProjectInstructions from "./project-instructions.js"

import { dirname, join } from "path"
import { Effect, Schema } from "effect"
import { Instructions } from "../instructions/index.js"
import { AbsolutePath } from "../schema.js"

export class File extends Schema.Class<File>("SessionProjectInstructions.File")({
  path: AbsolutePath,
  content: Schema.String,
}) {}

const Files = Schema.Array(File)

/**
 * Session-scoped AGENTS.md overlay sourced from the session's own sandbox filesystem.
 *
 * The Location-scoped discovery plugin reads through the server-side FSUtil, which cannot see
 * sandbox paths; in SaaS every session owns its sandbox, so the project-level AGENTS.md chain
 * (the working directory up to the project root) is read per session through the sandbox files
 * API - the same mechanism the sandbox command/skill scanners use. The discovery channel keeps
 * serving server-visible files (the global AGENTS.md) and stays authoritative for local,
 * non-sandbox deployments.
 */
export const Key = Instructions.Key.make("core/project-agents-md")

export interface LoadInput {
  readonly sessionID: string
  /** Working directory of the session; the ancestor walk starts here (nearest first). */
  readonly directory: string
  /** Project root; the walk stops after it. */
  readonly projectDirectory: string
  readonly sandbox: {
    readonly enabled: boolean
    readonly fileRead: (sessionID: string, path: string) => Effect.Effect<string | null, Error>
  }
}

function ancestorDirectories(start: string, stop: string): string[] {
  if (start === stop) return [start]
  return [start, ...ancestorDirectories(dirname(start), stop)]
}

const render = (files: ReadonlyArray<File>) =>
  files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")

export const load = (input: LoadInput): Instructions.List =>
  Instructions.make<ReadonlyArray<File>>({
    key: Key,
    codec: Schema.toCodecJson(Files),
    read: Effect.gen(function* () {
      if (!input.sandbox.enabled) return Instructions.removed
      const candidates = ancestorDirectories(input.directory, input.projectDirectory).map((directory) =>
        join(directory, "AGENTS.md"),
      )
      const files: File[] = []
      for (const path of new Set(candidates)) {
        // A missing file reads as null; a transient sandbox error skips that hop for this turn
        // instead of failing the whole instruction selection.
        const content = yield* input.sandbox.fileRead(input.sessionID, path).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("sandbox AGENTS.md read failed", { sessionID: input.sessionID, path, cause }).pipe(
              Effect.as(null),
            ),
          ),
        )
        if (content !== null && content !== undefined && content.length > 0)
          files.push(new File({ path: AbsolutePath.make(path), content }))
      }
      return files.length === 0 ? Instructions.removed : files
    }),
    render: {
      initial: render,
      changed: (_previous, files) => render(files),
      removed: () => "Previously loaded project instructions no longer apply.",
    },
  })