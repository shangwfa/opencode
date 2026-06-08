import { Effect } from "effect"
import * as Tool from "./tool"
import * as Log from "@opencode-ai/core/util/log"
import { InstanceState } from "@/effect/instance-state"

import { Config } from "@/config/config"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Shell } from "@/shell/shell"
import { ShellID } from "./shell/id"

import * as Truncate from "./truncate"
import { ShellPrompt, type Parameters } from "./shell/prompt"
import { toSandboxCwd } from "./sandbox-path"
import { SandboxProvider } from "./sandbox-provider"

export { Parameters } from "./shell/prompt"

const MAX_METADATA_LENGTH = 30_000
const MAX_TIMEOUT_MS = 5 * 60 * 1000
const COMMAND_NOT_FOUND_RE = /command not found|No such file or directory/i
export const log = Log.create({ service: "shell-tool" })

function checkCommandNotFound(text: string): string | undefined {
  const m = text.match(COMMAND_NOT_FOUND_RE)
  if (m) {
    const line = text.trim().split("\n").find(l => COMMAND_NOT_FOUND_RE.test(l))
    return line ?? m[0]
  }
}

export const ShellTool = Tool.define(
  ShellID.ToolID,
  Effect.gen(function* () {
    const config = yield* Config.Service
    const trunc = yield* Truncate.Service
    const flags = yield* RuntimeFlags.Service
    const defaultTimeoutMs = flags.bashDefaultTimeoutMs ?? 2 * 60 * 1000

    const runSandbox = Effect.fn("ShellTool.runSandbox")(function* (
      sandboxProvider: SandboxProvider.Interface,
      input: {
        command: string
        cwd: string
        timeout: number
        description: string
        background?: boolean | undefined
      },
      ctx: Tool.Context,
    ) {
      let output = ""
      let expired = false

      yield* ctx.metadata({
        metadata: { output: "", description: input.description },
      })

      const fullCommand = input.background
        ? `cd ${input.cwd} && ( nohup sh -c '${input.command.replace(/'/g, "'\\''")}' </dev/null > /tmp/opencode-bg-${ctx.callID ?? Date.now()}.log 2>&1 & ) && echo "started background"`
        : `cd ${input.cwd} && ${input.command}`

      const result = input.background
        ? yield* sandboxProvider.runDetached(
            ctx.sandboxSessionID ?? ctx.sessionID,
            fullCommand,
            { timeoutSeconds: Math.ceil((input.timeout + 5000) / 1000) },
            {
              onStdout: (msg: { text: string }) => {
                output += msg.text
                ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
              },
              onStderr: (msg: { text: string }) => {
                const cmdErr = checkCommandNotFound(msg.text)
                if (cmdErr) throw new Error(`Command failed: ${cmdErr}`)
                output += msg.text
                ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
              },
            },
            ctx.abort,
          )
        : yield* Effect.gen(function* () {
            const sb = yield* Effect.tryPromise({ try: () => ctx.sandbox!, catch: (e) => new Error(`Initialization failed: ${e instanceof Error ? e.message : String(e)}`) })
            return yield* sandboxProvider.runInSession(
              ctx.sandboxSessionID ?? ctx.sessionID,
              fullCommand,
              { timeoutSeconds: Math.ceil((input.timeout + 5000) / 1000) },
              {
                onStdout: (msg: { text: string }) => {
                  output += msg.text
                  ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
                },
                onStderr: (msg: { text: string }) => {
                  const cmdErr = checkCommandNotFound(msg.text)
                  if (cmdErr) throw new Error(`Command failed: ${cmdErr}`)
                  output += msg.text
                  ctx.metadata({ metadata: { output: output.slice(-MAX_METADATA_LENGTH), description: input.description } })
                },
              },
              ctx.abort,
            )
          })

      if (input.background) yield* sandboxProvider.keepAlive(ctx.sandboxSessionID ?? ctx.sessionID)

      const exitCode = result.exitCode ?? null
      if (exitCode === null) expired = true

      const meta: string[] = []
      if (expired) meta.push(`bash tool terminated command after exceeding timeout ${Math.min(input.timeout, MAX_TIMEOUT_MS)} ms.`)
      if (meta.length > 0) output += "\n\n<bash_metadata>\n" + meta.join("\n") + "\n</bash_metadata>"

      return {
        title: input.description,
        metadata: { output: output.slice(-MAX_METADATA_LENGTH), exit: exitCode, description: input.description },
        output,
      }
    })

    return () =>
      Effect.gen(function* () {
        const cfg = yield* config.get()
        const shell = Shell.acceptable(cfg.shell)
        const name = Shell.name(shell)
        const limits = yield* trunc.limits()
        const prompt = ShellPrompt.render(name, process.platform, limits, defaultTimeoutMs)
        log.info("shell tool using shell", { shell })

        return {
          description: prompt.description,
          parameters: prompt.parameters,
          execute: (params: Parameters, ctx: Tool.Context) =>
            Effect.gen(function* () {
              const instanceCtx = yield* InstanceState.context
              if (params.timeout !== undefined && params.timeout < 0) {
                throw new Error(`Invalid timeout value: ${params.timeout}. Timeout must be a positive number.`)
              }
              const timeout = Math.min(params.timeout ?? defaultTimeoutMs, MAX_TIMEOUT_MS)

              const sandboxProviderOpt = yield* Effect.serviceOption(SandboxProvider.Service)
              if (sandboxProviderOpt._tag === "None") throw new Error("Execution environment not available")
              const sandboxProvider = sandboxProviderOpt.value
              const sandboxCwd = toSandboxCwd(params.workdir, instanceCtx.directory)
              return yield* runSandbox(
                sandboxProvider,
                {
                  command: params.command,
                  cwd: sandboxCwd,
                  timeout,
                  description: params.description,
                  background: params.background,
                },
                ctx,
              ).pipe(Effect.orDie)
            }),
        }
      })
  }),
)
