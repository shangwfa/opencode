import * as fs from "node:fs"
import { Effect } from "effect"
import { execute, type DiagnosticKind, type ExecutionLimits, type Result } from "../codemode.js"
import { toolError } from "../tool-error.js"
import { isTool, make } from "../tool.js"
import type { Tools } from "../tools.js"

/**
 * Confined Code Mode agent for sandboxed execution.
 *
 * The host writes one `options.json` into the directory named by
 * `OPENCODE_CODEMODE_DIR` and spawns this entrypoint with Node. Tool calls
 * leave as `@req` stdout lines and results arrive as `resp-<id>.json` files;
 * the final `CodeMode.Result` leaves as one `@done` stdout line. The process
 * keeps no ambient capabilities: everything except the protocol directory and
 * the listed tools stays outside the program's reach.
 */

type CatalogEntry = {
  readonly path: string
  readonly description: string
}

type AgentOptions = {
  readonly code: string
  readonly limits?: ExecutionLimits
  readonly tools?: ReadonlyArray<CatalogEntry>
}

const emitDone = (result: Result): never => {
  process.stdout.write(`@done ${JSON.stringify(result)}\n`)
  process.exit(0)
}

const failure = (kind: DiagnosticKind, message: string): Result => ({
  ok: false,
  error: { kind, message },
  toolCalls: [],
})

const buildTools = (
  entries: ReadonlyArray<CatalogEntry>,
  call: (name: string, input: unknown) => Effect.Effect<unknown, unknown>,
): Tools => {
  const root: Record<string, unknown> = {}
  for (const entry of entries) {
    const segments = entry.path.split(".")
    let node = root
    for (const segment of segments.slice(0, -1)) {
      const child = node[segment]
      if (child === undefined || child === null || typeof child !== "object" || isTool(child as never)) {
        const group: Record<string, unknown> = {}
        node[segment] = group
        node = group
        continue
      }
      node = child as Record<string, unknown>
    }
    const name = entry.path
    node[segments[segments.length - 1]!] = make({
      description: entry.description,
      // Render-only shapes: input validation happens host-side at the bridge.
      input: { type: "object" },
      output: {},
      execute: (input: unknown) => call(name, input),
    })
  }
  return root as Tools
}

const bridge = (dir: string, timeoutMs: number | undefined) => {
  let next = 0
  // Fallback deadline so a dead host cannot wedge the agent forever; the
  // interpreter's own limit governs when it is shorter.
  const deadline = Date.now() + (timeoutMs ?? 120_000)
  return (name: string, input: unknown): Effect.Effect<unknown, unknown> =>
    Effect.callback((resume) => {
      const id = ++next
      process.stdout.write(`@req ${JSON.stringify({ id, tool: name, input: input ?? {} })}\n`)
      const path = `${dir}/resp-${id}.json`
      const poll = setInterval(() => {
        if (Date.now() > deadline) {
          clearInterval(poll)
          resume(Effect.fail(toolError(`Tool '${name}' bridge response timed out.`)))
          return
        }
        let raw: unknown
        try {
          raw = JSON.parse(fs.readFileSync(path, "utf8"))
        } catch {
          return // Missing or partially written; the host renames atomically.
        }
        clearInterval(poll)
        const response = raw as { __error?: string; value?: unknown }
        if (typeof response.__error === "string") resume(Effect.fail(toolError(response.__error)))
        else resume(Effect.succeed(response.value))
      }, 20)
    })
}

export const main = (): void => {
  const dir = process.env["OPENCODE_CODEMODE_DIR"]
  if (dir === undefined || dir === "") {
    emitDone(failure("ExecutionFailure", "OPENCODE_CODEMODE_DIR is not set."))
    return
  }
  let options: AgentOptions
  try {
    options = JSON.parse(fs.readFileSync(`${dir}/options.json`, "utf8")) as AgentOptions
  } catch (cause) {
    emitDone(failure("ExecutionFailure", `Failed to read agent options: ${cause instanceof Error ? cause.message : String(cause)}`))
    return
  }
  const tools = buildTools(options.tools ?? [], bridge(dir, options.limits?.timeoutMs))
  execute({ code: options.code, tools, limits: options.limits }).pipe(Effect.runPromise).then(
    (result) => emitDone(result),
    (cause) =>
      emitDone(failure("ExecutionFailure", cause instanceof Error ? cause.message : String(cause))),
  )
}
