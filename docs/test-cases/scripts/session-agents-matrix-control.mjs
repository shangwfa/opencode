// 现有测试服务的可恢复 operator 配置、模型故障探针与确定性崩溃窗口。
// 仅修改指定容器的临时文件；不修改依赖包，不复制/启动第二个 SaaS。
// 备份与还原：config / entry / subagent-completion 三个文件，恢复后重启并校验。
import { createServer } from "node:http"
import { readFileSync, writeFileSync, mkdirSync, chmodSync, existsSync } from "node:fs"
import * as m from "./session-agents-matrix-lib.mjs"

// JSONC 只做无损注释剥离；不引入仓库外依赖，避免解析器差异篡改原始配置。
export function readJsonc(text) {
  let out = ""
  let inString = false
  let quote = ""
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (ch === "\n") { inLine = false; out += ch }
      continue
    }
    if (inBlock) {
      if (ch === "*" && next === "/") { inBlock = false; i++ }
      continue
    }
    if (inString) {
      out += ch
      if (ch === "\\") { out += next ?? ""; i++; continue }
      if (ch === quote) inString = false
      continue
    }
    if (ch === '"' || ch === "'") { inString = true; quote = ch; out += ch; continue }
    if (ch === "/" && next === "/") { inLine = true; i++; continue }
    if (ch === "/" && next === "*") { inBlock = true; i++; continue }
    out += ch
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

export const mockModel = (id = "ok") => ({ providerID: "MatrixProbe", id })

const paths = {
  config: "/home/opencode/.config/opencode/opencode.jsonc",
  entry: "/app/packages/cli/src/index.ts",
  completion: "/app/packages/core/src/session/subagent-completion.ts",
}
// 容器内 opencode 用户对 /app 无写权限，崩溃开并文件放 /tmp。
const crashFile = "/tmp/matrix-crash.json"
const hitFile = "/tmp/matrix-crash-hit.json"

export async function control() {
  const backup = `${m.directory}/private-backup`
  mkdirSync(backup, { recursive: true, mode: 0o700 })
  chmodSync(backup, 0o700)
  const requests = []
  const pending = new Set()
  let server
  let original
  let armed = false

  const copyIn = async (key, text, target = paths[key]) => {
    const file = `${backup}/working-${key}`
    writeFileSync(file, text, { mode: 0o600 })
    await run(["cp", file, `${m.container}:${target}`])
    await run(["exec", "-u", "root", m.container, "chown", "opencode:opencode", target])
  }

  const containerState = async () => (await m.exec("docker", ["inspect", "-f", "{{.State.Status}}", m.container], { timeout: 15_000 })).stdout.trim()

  // 所有容器操作带超时，防 execFile Promise 丢失导致还原挂起（阶段二实际发生）。
  const run = (args, timeout = 60_000) => m.exec("docker", args, { timeout, maxBuffer: 32 * 1024 * 1024 })

  // 重启前等待非本轮会话退出活跃（前序用例的子会话可能仍在收尾）；超时才拒绝。
  const waitIdle = async (allowOurs) => {
    const ours = new Set(m.sessions.map(x => x.sid))
    await m.until("服务空闲（等待其他会话收尾）", async () => {
      const active = (await m.api("/api/session/active")).data
      const ids = Object.keys(active)
      if (!allowOurs) return ids.length === 0 ? true : undefined
      return ids.every(id => ours.has(id)) ? true : undefined
    }, 180_000)
    const active = (await m.api("/api/session/active")).data
    const ids = Object.keys(active)
    if (!allowOurs) {
      m.assert.equal(ids.length, 0, `服务仍有活跃会话，拒绝重启：${ids.join(",")}`)
    } else {
      const unrelated = ids.filter(id => !ours.has(id))
      m.assert.equal(unrelated.length, 0, `存在非本轮活跃会话，拒绝操作：${unrelated.join(",")}`)
    }
  }

  const ready = async () => {
    await m.until("现有服务启动与鉴权", async () => {
      try { await m.authenticate(); return (await m.raw("/api/info")).status === 200 } catch { return false }
    }, 90_000)
    for (const { sid } of m.sessions) {
      try { if ((await m.raw(`/api/session/${sid}`)).status === 200) await m.watch(sid) } catch {}
    }
  }

  const assertIdle = async (allowOurs) => {
    const active = (await m.api("/api/session/active")).data
    const ids = Object.keys(active)
    if (!allowOurs) {
      m.assert.equal(ids.length, 0, `服务仍有活跃会话，拒绝重启：${ids.join(",")}`)
    } else {
      const ours = new Set(m.sessions.map(x => x.sid))
      const unrelated = ids.filter(id => !ours.has(id))
      m.assert.equal(unrelated.length, 0, `存在非本轮活跃会话，拒绝操作：${unrelated.join(",")}`)
    }
  }

  const restart = async (kill = false, allowActive = false) => {
    await waitIdle(allowActive)
    await m.close(false)
    if (kill) {
      m.log("故障注入：SIGKILL 指定 opencode-saas-test（不触碰沙箱容器）")
      await run(["kill", "--signal", "KILL", m.container])
      await run(["start", m.container])
    } else {
      await run(["restart", m.container], 120_000)
    }
    await ready()
  }

  // 进程内 SIGKILL 后依赖 restart policy 或手动 start 拉起，两者都兼容。
  const crashRecover = async () => {
    await m.until("宕机容器恢复运行", async () => {
      const state = await containerState()
      if (state === "running") return true
      if (state === "exited") await run(["start", m.container])
      return false
    }, 60_000)
    await ready()
  }

  // OpenAI chat completions 协议探针：按请求 body.model 区分故障语义。
  const mock = createServer(async (req, res) => {
    try {
      let raw = ""
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      requests.push({ at: Date.now(), path: req.url, headers: { ...req.headers, authorization: "[REDACTED]" }, body })
      m.save("probe-requests", requests)
      const id = body.model ?? "ok"
      m.log(`模型 HTTP 探针 ${id} ${req.url} 请求#${requests.length}`)
      if (id === "forbidden" || id === "rate-limit") {
        res.writeHead(id === "forbidden" ? 403 : 429, { "content-type": "application/json", "retry-after": "0" })
        res.end(JSON.stringify({ error: { message: `MATRIX_${id}`, type: "matrix_test" } }))
        return
      }
      if (id === "timeout") {
        pending.add(res)
        res.on("close", () => pending.delete(res))
        return
      }
      const content = id === "title" ? "Matrix generated title"
        : id === "compact" ? "MATRIX_COMPACT_SUMMARY: retained the task and pending work."
        : id === "summary" ? "MATRIX_CHECKPOINT_SUMMARY: retained original task."
        : "MATRIX_PROBE_RESPONSE"
      const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: `chatcmpl-matrix-${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: id, choices: [{ index: 0, delta, finish_reason }] })}\n\n`
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ id: "chatcmpl-matrix", object: "chat.completion", created: Math.floor(Date.now() / 1000), model: id, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }))
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(chunk({ role: "assistant", content: id === "disconnect" || id === "hold" ? "MATRIX_STREAM_STARTED" : content }))
      if (id === "disconnect") { res.destroy(); return }
      if (id === "hold") { pending.add(res); res.on("close", () => pending.delete(res)); return }
      res.write(chunk({}, "stop"))
      res.end("data: [DONE]\n\n")
    } catch (e) { m.log(`模型探针错误：${String(e)}`); res.destroy() }
  })

  const probeProvider = () => ({
    npm: "@ai-sdk/openai-compatible",
    name: "MatrixProbe",
    options: { baseURL: "http://host.docker.internal:19197/v1", apiKey: "matrix-test-not-a-secret", timeout: 3000 },
    models: Object.fromEntries(
      ["ok", "forbidden", "rate-limit", "disconnect", "timeout", "hold", "title", "compact", "summary"].map(id => [
        id, { name: `matrix-${id}`, limit: { context: 32768, input: 32768, output: 2048 } },
      ]),
    ),
  })

  return {
    requests,
    restart,
    crashRecover,
    ready,
    copyIn,
    async install() {
      await m.authenticate()
      await assertIdle(false)
      for (const [key, path] of Object.entries(paths)) {
        const file = `${backup}/${key}`
        m.assert(!existsSync(file), "备份目录已存在，禁止覆盖上轮备份；请更换 EVIDENCE_DIR")
        await run(["cp", `${m.container}:${path}`, file])
        chmodSync(file, 0o600)
      }
      const inspected = JSON.parse((await run(["inspect", m.container])).stdout)[0]
      m.save("operator-environment", {
        image: inspected.Config.Image,
        imageID: inspected.Image,
        restartPolicy: inspected.HostConfig.RestartPolicy.Name,
        originalFiles: Object.values(paths),
        credentialBackup: "private-backup（仅本机 0600，不提交）",
      })
      original = readJsonc(readFileSync(`${backup}/config`, "utf8"))
      m.assert(original && typeof original === "object", "operator JSONC 解析失败")
      await new Promise((resolve, reject) => { mock.once("error", reject); mock.listen(19197, "0.0.0.0", resolve) })
      server = mock
      armed = true
      // 入口补丁只注入快照开关；其余配置走 JSONC。保留原始入口为本地文件，还原时删除。
      await copyIn("bootstrap-original", readFileSync(`${backup}/entry`, "utf8"), "/app/packages/cli/src/matrix-original-index.ts")
      await copyIn("entry", `process.env.OPENCODE_SANDBOX_SNAPSHOT_ENABLED = "true"\nawait import("./matrix-original-index.ts")\n`)
      await this.configure({})
      const config = await m.api("/api/config")
      m.save("config-after-install", {
        default_agent: config.data?.default_agent,
        providerKeys: Object.keys(config.data?.provider ?? config.data?.providers ?? {}),
        snapshotEnabledEnv: true,
      })
    },
    // overrides 直接覆盖顶层字段；provider 始终合并 MatrixProbe（可被 overrides.provider 覆盖）。
    async configure(overrides = {}, reboot = true) {
      const merged = {
        ...original,
        ...overrides,
        provider: { ...(original.provider ?? {}), MatrixProbe: probeProvider(), ...(overrides.provider ?? {}) },
      }
      await copyIn("config", JSON.stringify(merged, null, 2))
      if (reboot) await restart()
    },
    // 注入确定性崩溃窗口：子任务通知投递的关键行前后 SIGKILL。
    async fault(window, parentID) {
      const source = readFileSync(`${backup}/completion`, "utf8")
      const anchors = { admission: "yield* sessions.synthetic({", job: "if (input.notificationID) yield* jobs.completeBackground" }
      for (const text of Object.values(anchors)) m.assert(source.includes(text), `通知注入锚点缺失：${text}`)
      const helper = `\nimport { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs"\nfunction matrixCrash(windowID: string, parent: string) {\n  const path = "${crashFile}"\n  if (!existsSync(path)) return\n  const cfg = JSON.parse(readFileSync(path, "utf8"))\n  if (cfg.window !== windowID || cfg.parentID !== parent) return\n  unlinkSync(path)\n  writeFileSync("${hitFile}", JSON.stringify({ window: windowID, parent, at: Date.now() }))\n  process.kill(process.pid, "SIGKILL")\n}\n`
      const patched = source + helper
        .concat("")
      const withAdmission = patched.replace(anchors.admission, `matrixCrash("before-admission", recovery.parentSessionID)\n  ${anchors.admission}`)
      const injected = withAdmission.replace(anchors.job, `matrixCrash("after-admission", recovery.parentSessionID)\n  ${anchors.job}`)
      m.assert.notEqual(injected, withAdmission, "通知注入锚点缺失")
      m.assert(injected.includes("matrixCrash(\"before-admission\"") && injected.includes("matrixCrash(\"after-admission\""), "注入点不完整")
      await copyIn("completion", injected)
      if (window) await this.arm(window, parentID)
    },
    async arm(window, parentID) {
      await copyIn("crash-arm", JSON.stringify({ window, parentID }), crashFile)
    },
    async crashHit() {
      try {
        const out = await run(["exec", m.container, "cat", hitFile])
        return JSON.parse(out.stdout)
      } catch { return undefined }
    },
    async clearCrashFiles() {
      await run(["exec", m.container, "sh", "-c", `rm -f ${crashFile} ${hitFile}`])
    },
    async restore() {
      if (!armed) return
      m.log("恢复现有服务的原始配置与全部容器内测试注入文件")
      pending.forEach(res => res.destroy())
      await this.clearCrashFiles().catch(() => undefined)
      for (const key of Object.keys(paths)) await copyIn(key, readFileSync(`${backup}/${key}`, "utf8"))
      await run(["exec", "-u", "root", m.container, "rm", "-f", "/app/packages/cli/src/matrix-original-index.ts"]).catch(e => m.log(`移除入口副本失败（继续）：${String(e).slice(0, 120)}`))
      const entryNow = (await run(["exec", m.container, "head", "-c", "80", paths.entry])).stdout
      m.assert(!entryNow.includes("SANDBOX_SNAPSHOT_ENABLED"), "入口未还原")
      await restart(false, true)
      const config = await m.api("/api/config")
      m.save("operator-restored", {
        at: Date.now(),
        files: Object.values(paths),
        providerKeys: Object.keys(config.data?.provider ?? config.data?.providers ?? {}),
        defaultAgentRestored: (config.data?.default_agent ?? undefined) === (original.default_agent ?? undefined),
      })
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
    },
  }
}
