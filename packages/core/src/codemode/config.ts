export * as CodeModeConfig from "./config.js"

import type { CodeMode } from "@opencode/codemode"

export type Executor = "server" | "sandbox"
export type Network = "disabled" | "server" | "sandbox"

export interface Config {
  readonly executor: Executor
  readonly network: Network
  /** Absent keys mean unlimited, matching the V2 line. Budgets are opt-in deployment policy. */
  readonly limits: CodeMode.ExecutionLimits
}

/**
 * An unset limit stays absent so the runtime keeps its unlimited semantics. An
 * explicitly set but unusable value is a configuration mistake: silently
 * dropping it would quietly remove a budget the deployment asked for.
 */
const limit = (name: string, value: string | undefined) => {
  if (value === undefined) return undefined
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer, received ${JSON.stringify(value)}.`)
  return parsed
}

export const load = (env: Readonly<Record<string, string | undefined>> = process.env): Config => {
  const executor: Executor = env["OPENCODE_CODEMODE_EXECUTOR"] === "server" ? "server" : "sandbox"
  const requestedNetwork = env["OPENCODE_CODEMODE_NETWORK"]
  if (executor === "sandbox" && requestedNetwork === "server")
    throw new Error("OPENCODE_CODEMODE_NETWORK=server is incompatible with the sandbox Code Mode executor.")
  if (executor === "server" && requestedNetwork === "sandbox")
    throw new Error("OPENCODE_CODEMODE_NETWORK=sandbox is incompatible with the server Code Mode executor.")
  const network: Network =
    requestedNetwork === "disabled" ? "disabled" : requestedNetwork === "server" ? "server" : executor === "sandbox" ? "sandbox" : "server"
  const timeoutMs = limit("OPENCODE_CODEMODE_TIMEOUT_MS", env["OPENCODE_CODEMODE_TIMEOUT_MS"])
  const maxToolCalls = limit("OPENCODE_CODEMODE_MAX_TOOL_CALLS", env["OPENCODE_CODEMODE_MAX_TOOL_CALLS"])
  const maxSteps = limit("OPENCODE_CODEMODE_MAX_STEPS", env["OPENCODE_CODEMODE_MAX_STEPS"])
  const maxOutputBytes = limit("OPENCODE_CODEMODE_MAX_OUTPUT_BYTES", env["OPENCODE_CODEMODE_MAX_OUTPUT_BYTES"])
  return {
    // The interpreter is session-isolated by default. Server execution is an
    // explicit compatibility override. HTTP requests follow the interpreter:
    // sandbox execution uses the Sandbox process' native fetch.
    executor,
    network,
    limits: {
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      ...(maxToolCalls === undefined ? {} : { maxToolCalls }),
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    },
  }
}
