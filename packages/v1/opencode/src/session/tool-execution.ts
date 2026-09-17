import { Effect } from "effect"

const executions = new Map<string, AbortController>()

function key(sessionID: string, callID: string) {
  return `${sessionID}:${callID}`
}

export function register(sessionID: string, callID: string, controller: AbortController) {
  const id = key(sessionID, callID)
  executions.set(id, controller)
  return () => {
    if (executions.get(id) === controller) executions.delete(id)
  }
}

export function interrupt(sessionID: string, callID: string) {
  const controller = executions.get(key(sessionID, callID))
  if (!controller) return false
  controller.abort(new Error("Tool execution timed out"))
  return true
}

export function has(sessionID: string, callID: string) {
  return executions.has(key(sessionID, callID))
}

export function callIDs() {
  return Array.from(executions.keys(), (id) => id.slice(id.indexOf(":") + 1))
}

export function raceAbort<A, E, R>(signal: AbortSignal, effect: Effect.Effect<A, E, R>) {
  const aborted = Effect.callback<never>((resume) => {
    const abort = () => resume(Effect.interrupt)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", abort))
  })
  return Effect.raceFirst(effect, aborted)
}

export * as ToolExecution from "./tool-execution"
