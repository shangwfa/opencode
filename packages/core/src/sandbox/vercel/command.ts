import type { ActiveConnection } from "./client.js"

export type CommandRef = {
  readonly sandboxName: string
  readonly generation: string
  readonly commandID: string
}

function current(active: ActiveConnection, task?: CommandRef) {
  if (active.session.sessionId !== active.generation || (task && (
    task.generation !== active.generation || task.sandboxName !== active.sandbox.name
  ))) throw new Error("Vercel command belongs to a different sandbox generation")
}

function integer(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid Vercel command ${label}`)
}

/** Low-level submission only. This is not RunInput.detached, which must await its launcher. */
export async function start(active: ActiveConnection, input: {
  readonly cmd: string
  readonly args?: string[]
  readonly cwd?: string
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
}) {
  current(active)
  integer(input.timeoutMs ?? 0, "timeout")
  input.signal?.throwIfAborted()
  const command = await active.session.runCommand({
    ...input,
    // The public contract uses 0 for unlimited; Vercel rejects an explicit timeout below 100ms.
    timeoutMs: input.timeoutMs === 0 ? undefined : input.timeoutMs,
    cwd: input.cwd ?? "/workspace", detached: true,
  })
  return {
    sandboxName: active.sandbox.name,
    generation: active.generation,
    commandID: command.cmdId,
  } satisfies CommandRef
}

/** Drain all logs, retain only a bounded UTF-8 prefix; the producer can persist full output. */
export async function observe(active: ActiveConnection, task: CommandRef, input: {
  readonly maxBytes: number
  readonly signal?: AbortSignal
  readonly onOutput?: (chunk: { stream: "stdout" | "stderr"; data: string }) => Promise<void>
}) {
  current(active, task)
  integer(input.maxBytes, "output limit")
  input.signal?.throwIfAborted()
  const command = await active.session.getCommand(task.commandID, { signal: input.signal })
  if (command.cmdId !== task.commandID) throw new Error("Vercel command identity mismatch")
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  for await (const log of command.logs({ signal: input.signal })) {
    await input.onOutput?.(log)
    const data = Buffer.from(log.data)
    const keep = Math.min(data.length, input.maxBytes - bytes)
    // Copy the prefix: retaining a slice could keep an arbitrarily large source chunk alive.
    if (keep > 0) chunks.push(Buffer.from(data.subarray(0, keep)))
    bytes += keep
    if (keep < data.length) truncated = true
  }
  const finished = await command.wait({ signal: input.signal })
  // Do not emit a replacement character when the byte limit cuts through a UTF-8 character.
  const output = new TextDecoder().decode(Buffer.concat(chunks, bytes), { stream: true })
  return { exitCode: finished.exitCode, output, truncated }
}

/** Check the persisted PG ownership before calling; this guard only verifies the pinned VM. */
export async function cancel(active: ActiveConnection, task: CommandRef, input: {
  readonly signal?: AbortSignal
  readonly graceMs?: number
} = {}) {
  current(active, task)
  integer(input.graceMs ?? 1_000, "termination grace")
  const deadline = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000)
  deadline.throwIfAborted()
  const command = await active.session.getCommand(task.commandID, { signal: deadline })
  if (command.cmdId !== task.commandID) throw new Error("Vercel command identity mismatch")
  if (command.exitCode !== null) return { exitCode: command.exitCode }
  await command.kill("SIGTERM", { abortSignal: deadline })
  const grace = AbortSignal.timeout(input.graceMs ?? 1_000)
  try {
    const finished = await command.wait({ signal: AbortSignal.any([deadline, grace]) })
    return { exitCode: finished.exitCode }
  } catch (error) {
    if (!grace.aborted || deadline.aborted || error !== grace.reason) throw error
  }
  await command.kill("SIGKILL", { abortSignal: deadline })
  const finished = await command.wait({ signal: deadline })
  return { exitCode: finished.exitCode }
}
