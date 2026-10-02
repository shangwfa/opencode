import { expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import { Session } from "@opencode/schema/session"
import type { SandboxProvider } from "@opencode/core/sandbox/provider"
import { scanSandboxTools } from "@opencode/core/session/tool-scan"

const scanPath = "/workspace/.opencode/tools/priority-tool.ts"
const session = { id: Session.ID.create(), location: { directory: "/workspace" } } as Session.Info

function sandbox(
  output: string | (() => string),
  fileRead: SandboxProvider.Interface["fileRead"],
  exitCode = 0,
): SandboxProvider.Interface {
  return {
    enabled: true,
    run: () => Effect.succeed({ timedOut: false, exitCode, output: typeof output === "function" ? output() : output }) as any,
    fileRead,
  } as unknown as SandboxProvider.Interface
}

test("reads sandbox tool changes and reuses unchanged source from its bounded cache", async () => {
  let fingerprint = "1\t20"
  let source = "export default {description:'v1',args:{},execute(){return 'v1'}}"
  let reads = 0
  const provider = sandbox(
    () => `${scanPath}\t${fingerprint}`,
    () => {
      reads++
      return Effect.succeed(source)
    },
  )

  const first = await Effect.runPromise(scanSandboxTools(session, provider))
  const same = await Effect.runPromise(scanSandboxTools(session, provider))
  expect(first[0]?.code).toBe(source)
  expect(same[0]?.code).toBe(source)
  expect(reads).toBe(1)

  fingerprint = "2\t20"
  source = "export default {description:'v2',args:{},execute(){return 'v2'}}"
  const changed = await Effect.runPromise(scanSandboxTools(session, provider))
  expect(changed[0]?.code).toBe(source)
  expect(reads).toBe(2)
})

test("fails closed when sandbox tool discovery fails", async () => {
  const provider = sandbox("sandbox unavailable", () => Effect.succeed(null), 1)

  const result = await Effect.runPromiseExit(scanSandboxTools(session, provider))
  expect(Exit.isFailure(result)).toBe(true)
})
