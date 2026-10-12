// S2/S3/S4 通知专项：HTTP 驱动、实时会话 SSE、PG 精确匹配；失败保留现场。
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"

const exec = promisify(execFile)
const base = process.env.BASE ?? "http://localhost:14096"
const container = process.env.SAAS_CONTAINER ?? "opencode-saas-test"
const pg = process.env.OPENCODE_DATABASE_URL ?? "postgresql://local@127.0.0.1:5432/opencode-v2-up"
const model = process.env.MODEL ?? "Yd-GLM/glm-5.3-flash"
const output = process.env.EVIDENCE_DIR
assert(output, "请设置 EVIDENCE_DIR（保存原始 SSE、会话 ID 与 PG 后检）")
mkdirSync(output, { recursive: true })
let password = process.env.OPENCODE_PASSWORD
const events = []
const controllers = []
const sessions = []
const results = []
const sql = async (text) => (await exec("psql", [pg, "-tA", "-v", "ON_ERROR_STOP=1", "-c", text])).stdout.trim()
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`
const log = (text) => console.log(`[${new Date().toISOString()}] ${text}`)
const persist = () => writeFileSync(`${output}/result.json`, JSON.stringify({ sessions, results, events }, null, 2))
async function refreshPassword() {
  if (process.env.OPENCODE_PASSWORD) return
  const { stdout, stderr } = await exec("docker", ["logs", container], { maxBuffer: 16 * 1024 * 1024 })
  password = [...`${stdout}\n${stderr}`.matchAll(/server password (\S+)/g)].at(-1)?.[1]
  assert(password, "服务日志没有访问口令")
}
async function request(path, method = "GET", body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await response.text()
  assert(response.ok, `${method} ${path}: ${response.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : undefined
}

// 定时后检不阻塞事件流；每 10 秒输出进度，避免静默等待。不使用 sleep。
function until(label, check, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let busy = false
    let last = 0
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        const value = await check()
        if (value) {
          clearInterval(timer)
          resolve(value)
          return
        }
        if (Date.now() - started > timeout) throw new Error(`${label} 超时`)
        if (Date.now() - last > 10_000) {
          log(`${label} · 等待条件，SSE 持续订阅`)
          last = Date.now()
        }
      } catch (error) {
        clearInterval(timer)
        reject(error)
      } finally {
        busy = false
      }
    }
    const timer = setInterval(tick, 1000)
    void tick()
  })
}

async function watch(sid, tag) {
  const controller = new AbortController()
  controllers.push(controller)
  const response = await fetch(`${base}/api/session/${sid}/event`, {
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
    signal: controller.signal,
  })
  assert.equal(response.status, 200, `SSE ${tag}`)
  log(`${tag} SSE 已连接 ${sid}`)
  void (async () => {
    let buffer = ""
    const decoder = new TextDecoder()
    try {
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""
        for (const line of lines) {
          if (!line.startsWith("data:")) continue
          let event
          try {
            event = JSON.parse(line.slice(5))
          } catch {
            continue
          }
          events.push({ tag, at: Date.now(), ...event })
          if (/delta|streamed|usage.updated/.test(event.type)) continue
          const data = event.data ?? {}
          const brief = data.text ?? data.error?.message ?? data.name ?? data.reason ?? ""
          log(`${tag} ${event.type} ${String(brief).replace(/\s+/g, " ").slice(0, 180)}`)
          if (event.type === "form.created") {
            const forms = await request(`/api/session/${sid}/form`)
            for (const form of forms.data ?? []) {
              if (form.metadata?.kind !== "question") continue
              const answer = {}
              for (const field of form.fields ?? []) {
                if (field.type === "external") continue
                if (field.type === "boolean") answer[field.key] = field.default ?? true
                else if (field.type === "number" || field.type === "integer")
                  answer[field.key] = field.default ?? field.minimum ?? 1
                else if (field.type === "multiselect")
                  answer[field.key] = [field.options?.[0]?.value ?? field.default?.[0]].filter(Boolean)
                else answer[field.key] = field.options?.[0]?.value ?? field.default ?? "请按推荐方案继续"
              }
              await request(`/api/session/${sid}/form/${form.id}/reply`, "POST", { answer })
              log(`${tag} 表单已自动代答 ${form.id}`)
            }
          }
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) log(`${tag} SSE 断开 ${String(error).slice(0, 100)}`)
    }
  })()
}

async function run(kind) {
  const created = await request("/api/session", "POST", {
    title: `notification-${kind}-${Date.now()}`,
    location: { directory: "/workspace" },
  })
  const parent = created.data.id
  sessions.push({ kind, parent })
  persist()
  const slash = model.indexOf("/")
  await request(`/api/session/${parent}/model`, "POST", {
    model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) },
  })
  await request(`/api/experimental/session/${parent}/keep-alive`, "POST", { enabled: true })
  await request(`/api/session/${parent}/agents`, "POST", {
    id: "session/notice-owner",
    config: {
      mode: "primary",
      system:
        "For each subagent notification, reply exactly PARENT_NOTICE_ACK. Do not retry subagents, do not call tools, and do not ask questions.",
    },
  })
  await request(`/api/session/${parent}/agent`, "POST", { agent: "session/notice-owner" })
  await request(`/api/session/${parent}/agents`, "POST", {
    id: "session/helper",
    config: {
      mode: "subagent",
      system:
        "Follow the task. Never ask questions. If the task asks for a shell command, FIRST call execute with code: return { marker: 'NOTIFICATION_CODE_MODE_OK' }; then call the native shell tool. Do not omit the execute call.",
    },
  })
  const command = `notify-${kind}`
  const slow = kind === "interrupt" || kind === "restart"
  const marker = `/workspace/notification-${kind}.started`
  const template = slow
    ? `Run this shell command once. It performs a deliberately long computation for an interruption test; do not ask questions: python3 -c 'import os,time; p="${marker}"; existed=os.path.exists(p); open(p,"w").write("started"); end=time.time()+(0 if existed else 90); exec("while time.time()<end: pass"); print("NOTIFY_DONE")'. Then reply NOTIFY_DONE.`
    : "Reply NOTIFY_DONE without calling tools or asking questions."
  await request(`/api/session/${parent}/commands`, "POST", {
    name: command,
    template,
    subtask: true,
    agent: "session/helper",
    model: kind === "failure" ? `${model.slice(0, slash)}/no-such-model` : model,
  })
  await watch(parent, `${kind}/parent`)
  await request(`/api/session/${parent}/command`, "POST", { name: command, text: "" })
  const child = await until(`${kind} 子会话`, () =>
    sql(`SELECT id FROM session_v2 WHERE parent_id=${quote(parent)} ORDER BY time_created DESC LIMIT 1`),
  )
  sessions.at(-1).child = child
  persist()
  await watch(child, `${kind}/child`)
  if (slow) {
    // PG 的真实工具 part，不能以模板文本或模型复述证明工具开始。
    await until(`${kind} 真实 shell 开始`, () =>
      sql(
        `SELECT count(*) FROM session_message WHERE session_id=${quote(child)} AND type='assistant' AND EXISTS (SELECT 1 FROM jsonb_array_elements(data::jsonb->'content') p WHERE p->>'type'='tool' AND p->>'name'='shell' AND p#>>'{state,status}'='running')`,
      ).then((n) => Number(n) > 0),
    )
    const binding = await sql(`SELECT row_to_json(s)::text FROM sandbox s WHERE session_id=${quote(parent)}`)
    assert(binding, "父会话必须绑定远端沙箱")
    sessions.at(-1).sandboxBefore = JSON.parse(binding)
    assert.equal(
      Number(await sql(`SELECT count(*) FROM sandbox WHERE session_id=${quote(child)}`)),
      0,
      "子会话不得另建沙箱",
    )
    log(`${kind} 远端沙箱 ${sessions.at(-1).sandboxBefore.id} · ${sessions.at(-1).sandboxBefore.host}`)
    persist()
    if (kind === "interrupt") await request(`/api/session/${child}/interrupt`, "POST")
    else {
      const before = await sql(
        `SELECT value FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(child)}`,
      )
      assert(before, "重启前必须持久化 background job")
      log("restart · 已取证 running job，重启 SaaS 容器")
      await exec("docker", ["restart", container], { timeout: 60_000 })
      await until("restart 服务就绪", async () => {
        try {
          await refreshPassword()
          await request("/api/info")
          return true
        } catch {
          return false
        }
      })
      await watch(parent, "restart/parent-after")
      await watch(child, "restart/child-after")
    }
  }
  const notice = await until(
    `${kind} 父通知`,
    async () => {
      const text = await sql(
        `SELECT data::jsonb->>'text' FROM session_message WHERE session_id=${quote(parent)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)} ORDER BY seq DESC LIMIT 1`,
      )
      return text || undefined
    },
    180_000,
  )
  assert.match(
    notice,
    kind === "failure"
      ? /state="error"/
      : kind === "interrupt"
        ? /state="cancelled"/
        : /state="(completed|cancelled|error)"/,
  )
  const count = Number(
    await sql(
      `SELECT count(*) FROM session_message WHERE session_id=${quote(parent)} AND type='synthetic' AND data::jsonb->>'text' LIKE ${quote(`<subagent sessionID="${child}"%`)}`,
    ),
  )
  assert.equal(count, 1, "通知必须恰好一次")
  const pending = Number(
    await sql(
      `SELECT count(*) FROM kv WHERE key LIKE 'job.background/%' AND value::jsonb#>>'{recovery,childSessionID}'=${quote(child)}`,
    ),
  )
  assert.equal(pending, 0, "通知后持久化 job 应清除")
  const terminal = await sql(
    `SELECT type FROM event WHERE aggregate_id=${quote(child)} AND type ~ '^session.execution.(succeeded|failed|interrupted)' ORDER BY seq DESC LIMIT 1`,
  )
  assert(terminal, "子会话必须存在终态")
  const messages = await request(`/api/session/${child}/message?order=asc`)
  writeFileSync(`${output}/${kind}-child-messages.json`, JSON.stringify(messages, null, 2))
  const context = await request(`/api/session/${parent}/context`)
  writeFileSync(`${output}/${kind}-parent-context.json`, JSON.stringify(context, null, 2))
  const contextHasNotice = (context.data ?? []).some((m) => m.type === "synthetic" && m.text === notice)
  const toolParts = (messages.data ?? []).flatMap((m) => (m.content ?? []).filter((p) => p.type === "tool"))
  const codeMode = toolParts.some(
    (p) =>
      p.name === "execute" &&
      p.state?.status === "completed" &&
      JSON.stringify(p.state.content ?? []).includes("NOTIFICATION_CODE_MODE_OK"),
  )
  if (slow) assert(codeMode, "必须有 execute 真实成功输出，不能以用户模板证明 Code Mode 生效")
  const bindingAfter = await sql(`SELECT row_to_json(s)::text FROM sandbox s WHERE session_id=${quote(parent)}`)
  const sandboxAfter = bindingAfter ? JSON.parse(bindingAfter) : undefined
  if (slow) assert.equal(sandboxAfter?.id, sessions.at(-1).sandboxBefore.id, "父子共享沙箱且服务重启不换沙箱")
  await until(`${kind} 父恢复执行完成`, () =>
    sql(
      `SELECT count(*) FROM event WHERE aggregate_id=${quote(parent)} AND type LIKE 'session.execution.succeeded%'`,
    ).then((n) => Number(n) > 0),
  )
  results.push({
    kind,
    parent,
    child,
    terminal,
    notice,
    count,
    pending,
    contextHasNotice,
    codeMode,
    sandboxAfter,
    passed: true,
  })
  persist()
  log(`${kind} PASS · ${terminal}，父通知恰好一次，job 清零`)
}

try {
  await until("初始服务就绪", async () => {
    try {
      await refreshPassword()
      await request("/api/info")
      return true
    } catch {
      return false
    }
  })
  if (process.env.CLEANUP_FROM) {
    const previous = JSON.parse(readFileSync(process.env.CLEANUP_FROM, "utf8"))
    for (const { parent, child } of previous.sessions ?? []) {
      if (child) await request(`/api/session/${child}/interrupt`, "POST")
      await request(`/api/session/${parent}`, "DELETE")
      log(`仅清理指定验收会话 ${parent}`)
    }
  } else {
    for (const kind of (process.env.CASES ?? "failure,interrupt,restart,success").split(",")) await run(kind)
    for (const { parent } of sessions) await request(`/api/session/${parent}`, "DELETE")
  }
  log(`全部通过，证据：${output}`)
} catch (error) {
  results.push({ passed: false, error: String(error) })
  log(`FAIL · ${error}；现场保留：${output}`)
  process.exitCode = 1
} finally {
  controllers.forEach((controller) => controller.abort())
  persist()
}
