import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { CodeModeRunner } from "../../../packages/core/src/codemode/runner.ts"

const require = createRequire(new URL("../../../packages/core/package.json", import.meta.url))
const { Effect } = await import(pathToFileURL(require.resolve("effect")).href)
const { Sandbox, ConnectionConfig } = await import(pathToFileURL(require.resolve("@alibaba-group/opensandbox")).href)

export async function probeRunnerReadiness({ sandboxID, sessionID, domain, apiKey, save }) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  const result = {
    scope: "真实平台SDK命令/端点 + 实际CodeModeRunner.start/execute，绕过模型；不冒充完整SaaS provider服务",
    samples: [],
  }
  const sandbox = await Sandbox.connect({
    sandboxId: sandboxID,
    connectionConfig: new ConnectionConfig({ domain, apiKey, protocol: "http", useServerProxy: true }),
    skipHealthCheck: true,
  })
  const commandID = await sandbox.commands.createSession({ workingDirectory: "/workspace" })
  const run = async (command) => {
    const execution = await sandbox.commands.runInSession(commandID, command, { timeout: 15000 })
    assert(!execution.error, "SDK命令失败")
    return { exitCode: 0, timedOut: false, output: JSON.stringify(execution.logs ?? {}) }
  }
  try {
    const delayedFile = "/tmp/opencode-codemode-readiness-delayed.mjs"
    await run(`printf %s ${quote('await new Promise(resolve=>setTimeout(resolve,2000));await import("/opt/opencode-codemode-runner.mjs")')} > ${quote(delayedFile)}`)
    for (const delayMs of [0, 2000])
      for (let index = 0; index < (delayMs ? 3 : 5); index++) {
        await run(CodeModeRunner.stopCommand())
        const sample = { delayMs, index, attempts: [] }
        result.samples.push(sample)
        save(result)
        const started = performance.now()
        const provider = {
          run: (input) =>
            Effect.tryPromise({
              try: () =>
            run(delayMs ? input.command.replaceAll("/opt/opencode-codemode-runner.mjs", delayedFile) : input.command),
              catch: (error) => error,
            }),
          endpoint: () =>
            Effect.tryPromise({
              try: async () => {
                const resolved = await sandbox.getEndpoint(CodeModeRunner.port)
                return {
                  _tag: "resolved",
                  sandboxId: sandboxID,
                  endpoint: resolved.endpoint.replace("host.docker.internal", "127.0.0.1"),
                }
              },
              catch: (error) => error,
            }),
        }
        const endpoint = await Effect.runPromise(
          CodeModeRunner.start({ provider, sessionID, hostWorkdir: "/workspace" }),
        )
        sample.startReturnedMs = performance.now() - started
        const deadline = performance.now() + 15000
        while (performance.now() < deadline) {
          const atMs = performance.now() - started
          const controller = new AbortController()
          const timeout = setTimeout(() => controller.abort(), 4000)
          try {
            const executed = await CodeModeRunner.execute({
              endpoint: endpoint.endpoint,
              executionID: `cme_readiness_${crypto.randomUUID()}`,
              code: "return 7",
              web: false,
              tools: [],
              limits: {},
              signal: controller.signal,
              tool: async () => {
                throw new Error("探针不得调用工具")
              },
            })
            assert.equal(executed.ok, true)
            assert.equal(executed.value, 7)
            sample.attempts.push({ atMs, elapsedMs: performance.now() - started - atMs, ok: true })
            sample.firstSuccessMs = performance.now() - started
            break
          } catch (error) {
            sample.attempts.push({
              atMs,
              elapsedMs: performance.now() - started - atMs,
              ok: false,
              error: String(error),
            })
          } finally {
            clearTimeout(timeout)
            save(result)
          }
          await Bun.sleep(100)
        }
        assert(sample.firstSuccessMs !== undefined, "15秒内Runner未能执行纯计算")
      sample.firstAttemptPassed = sample.attempts[0]?.ok === true
      save(result)
      if (process.env.PROBE_EXPECT_RUNNER_READY === "true") assert(sample.firstAttemptPassed, "start返回后首次执行必须成功，不得靠重试")
      }
    result.summary = [0, 2000].map((delayMs) => {
      const samples = result.samples.filter((s) => s.delayMs === delayMs)
      return {
        delayMs,
        n: samples.length,
        firstAttemptFailures: samples.filter((s) => !s.firstAttemptPassed).length,
        startReturnedMs: samples.map((s) => s.startReturnedMs),
        firstSuccessMs: samples.map((s) => s.firstSuccessMs),
      }
    })
    save(result)
    return result
  } finally {
    await run(CodeModeRunner.stopCommand()).catch(() => {})
    await run("rm -f /tmp/opencode-codemode-readiness-delayed.mjs").catch(() => {})
    await sandbox.commands.deleteSession(commandID).catch(() => {})
    await sandbox.close()
  }
}
