import { expect, test } from "bun:test"
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { launcher } from "../src/session/tool-sandbox"

test("Tool Host reuses the current generation and restarts a daemon retained by pause/resume", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "tool-host-generation-"))
  const pidFile = path.join(directory, "host.pid")
  try {
    await writeFile(path.join(directory, "session-tool-host.mjs"), "console.log(process.env.OPENCODE_SESSION_TOOL_SANDBOX_ID);setInterval(()=>{},1000)")
    const flock = path.join(directory, "flock")
    // The Linux lock is exercised by Docker E2E; this fixture runs on macOS too.
    await writeFile(flock, '#!/bin/sh\nshift 4\nexec sh -c "$1"\n')
    await chmod(flock, 0o755)
    const run = async (generation: string) => {
      const command = launcher(generation, directory).replaceAll("/tmp/opencode-session-tool-host", path.join(directory, "host"))
      const task = Bun.spawn(["sh", "-c", command], { env: { ...process.env, PATH: `${directory}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" })
      expect(await task.exited).toBe(0)
      return (await readFile(pidFile, "utf8")).trim()
    }
    const first = await run("vm:first")
    expect(await run("vm:first")).toBe(first)
    expect(await run("vm:resumed")).not.toBe(first)
    expect(await readFile(`${pidFile}.generation`, "utf8")).toBe("vm:resumed")
  } finally {
    const pid = Number(await readFile(pidFile, "utf8").catch(() => ""))
    if (pid > 0) { try { process.kill(pid, "SIGKILL") } catch {} }
    await rm(directory, { recursive: true, force: true })
  }
}, 10000)
