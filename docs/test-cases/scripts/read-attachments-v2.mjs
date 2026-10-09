// V2 read 工具多格式与受管附件 E2E：真实模型触发 read（3 个分组回合），覆盖文本分页/空文件/SVG/非法 UTF-8/
// PNG/PDF/Office 附件化/Range/ETag/416/SHA-256/二进制与超限拒绝/PG payload 安全/PVC 持久化/SaaS 重启持久化。
// 旧 V1 /session/:id/exec 与 /message 已移除；本脚本全部走 V2 /api/... 路由。
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"

const BASE = (process.env.BASE ?? "http://localhost:14106").replace(/\/$/, "")
const PG_URL = process.env.PG_URL
const RESTART_CONTAINER = process.env.ATTACH_RESTART_CONTAINER
const AUTH = process.env.OPENCODE_AUTH ?? (process.env.OPENCODE_PASSWORD ? `opencode:${process.env.OPENCODE_PASSWORD}` : undefined)
const headers = {
  "content-type": "application/json",
  ...(AUTH ? { authorization: `Basic ${Buffer.from(AUTH).toString("base64")}` } : {}),
}
const parsedModel = JSON.parse(process.env.MODEL ?? '{"providerID":"Yd-DeepSeek","id":"deepseek-v4-flash"}')
const model = { providerID: parsedModel.providerID, id: parsedModel.id ?? parsedModel.modelID }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const nonce = randomUUID().replaceAll("-", "").slice(0, 12)

function check(ok, description) {
  assert(ok, `FAIL: ${description}`)
  console.log(`PASS: ${description}`)
}
function pg(sql) {
  const result = spawnSync("psql", [PG_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", sql], { encoding: "utf8" })
  if (result.status !== 0) throw new Error(`psql failed: ${result.stderr}`)
  return result.stdout.trim()
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

async function api(path, method = "GET", body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(300_000),
  })
  const text = response.status === 204 ? "" : await response.text()
  let data
  try {
    data = text ? JSON.parse(text) : undefined
  } catch {
    data = text
  }
  return { status: response.status, data, text }
}

async function runShell(sessionID, command) {
  await api(`/api/session/${sessionID}/shell`, "POST", { command, timeoutSeconds: 120 })
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
    const item = messages.filter((m) => m.type === "shell" && m.command === command).at(-1)
    if (item && item.status !== "running") {
      assert.equal(item.status, "exited", JSON.stringify(item).slice(0, 300))
      assert.equal(item.exit, 0, JSON.stringify(item).slice(0, 300))
      return item.output?.output ?? ""
    }
    await sleep(500)
  }
  throw new Error(`Sandbox shell timed out: ${command.slice(0, 60)}`)
}

const removeSession = async (sid) => {
  if (!PG_URL) {
    await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
    return
  }
  for (let attempt = 0; attempt < 60; attempt++) {
    await api(`/api/session/${sid}`, "DELETE").catch(() => undefined)
    if (pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sid)}`) === "0") return
    await sleep(1000)
  }
}

async function drainStream(response) {
  assert.equal(response.status, 200, `prompt_stream HTTP ${response.status}`)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events = []
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const blocks = buffer.split(/\r?\n\r?\n/)
    buffer = blocks.pop() ?? ""
    for (const block of blocks) {
      const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
      if (!data || data === "[DONE]") continue
      try {
        events.push(JSON.parse(data))
      } catch {}
    }
  }
  assert(events.some((e) => e.type === "session.execution.succeeded"), `execution did not succeed: ${events.map((e) => e.type).slice(-8).join(",")}`)
  return events
}

// 一轮分组 read：返回按文件顺序对应的 read tool parts（模型可能重复读同一文件，取每文件最后一次；
// 同时断言没有读目标清单之外的文件）
async function readRound(sessionID, files) {
  const before = new Set(((await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []).map((m) => m.id))
  const list = files.map((f) => `/workspace/read-fixtures/${f}`).join(", ")
  const response = await fetch(`${BASE}/api/session/${sessionID}/prompt_stream`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      text: `Read each of these files with the read tool, one call per file, in this exact order: ${list}. Do not read any other file. After the last read, reply with the single word done.`,
      metadata: {},
      delivery: "queue",
    }),
    signal: AbortSignal.timeout(300_000),
  })
  await drainStream(response)
  const messages = (await api(`/api/session/${sessionID}/message?order=asc`)).data.data ?? []
  const parts = messages
    .filter((m) => !before.has(m.id) && m.type === "assistant")
    .flatMap((m) => m.content ?? [])
    .filter((p) => p.type === "tool" && p.name === "read")
  const targets = new Set(files.map((f) => `/workspace/read-fixtures/${f}`))
  assert(
    parts.every((p) => String(p.state?.input?.path ?? "").startsWith("/workspace/read-fixtures/")),
    `model read outside the fixture directory: ${parts.map((p) => p.state?.input?.path).join(", ")}`,
  )
  const matched = files.map((f) => {
    const target = `/workspace/read-fixtures/${f}`
    return parts.filter((p) => p.state?.input?.path === target).at(-1)
  })
  assert(matched.every(Boolean), `missing read parts for: ${files.filter((f, i) => !matched[i]).join(", ")}`)
  return matched
}

const partText = (part) =>
  (part.state?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")

const download = async (url, extraHeaders = {}) => {
  const response = await fetch(`${BASE}${url}`, { headers: { ...headers, ...extraHeaders } })
  return { response, bytes: Buffer.from(await response.arrayBuffer()) }
}

const sessionID = (await api("/api/session", "POST", { title: `read-attach-${nonce}`, location: { directory: "/workspace" }, model })).data.data.id
let pngUrl

try {
  // ---------- fixtures（V1 §4 的 V2 等价：控制面 shell） ----------
  await runShell(
    sessionID,
    `mkdir -p /workspace/read-fixtures && cd /workspace/read-fixtures && ` +
      `printf 'alpha\\nbeta\\ngamma\\n' > text.txt && : > empty.txt && ` +
      `printf '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>\\n' > vector.svg && ` +
      `printf '//4=' | base64 -d > invalid-utf8.txt && ` +
      `printf 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' | base64 -d > pixel.png && ` +
      `printf 'JVBERi0xLjQKMSAwIG9iago8PD4+CmVuZG9iagolJUVPRgo=' | base64 -d > sample.pdf && ` +
      `printf 'UEsDBAo=' | base64 -d > sample.docx && ` +
      `printf '\\x7fELF\\x02\\x01\\x01' > program && ` +
      `printf 'iVBORw0KGgo=' | base64 -d > oversized.png && dd if=/dev/zero bs=1048576 count=21 >> oversized.png 2>/dev/null`,
  )
  check(true, "fixture 准备完成（文本/空文件/SVG/非法 UTF-8/PNG/PDF/DOCX/ELF/超限 PNG）")

  // ---------- 单回合触发全部 read（模型可能重复调用或乱序，按文件路径取每文件最后一次） ----------
  const [textPart, emptyPart, svgPart, pngPart, pdfPart, docxPart, elfPart, invalidPart, oversizePart] = await readRound(
    sessionID,
    ["text.txt", "empty.txt", "vector.svg", "pixel.png", "sample.pdf", "sample.docx", "program", "invalid-utf8.txt", "oversized.png"],
  )
  check(textPart.state.status === "completed", "T-READ-01 文本读取 completed")
  check(textPart.state.metadata?.kind === "text" && textPart.state.metadata?.mime === "text/plain", "T-READ-01 kind=text mime=text/plain")
  check(/alpha/.test(partText(textPart)) && /beta/.test(partText(textPart)), "T-READ-01 输出包含文件内容")
  check(emptyPart.state.status === "completed" && /0 lines/.test(partText(emptyPart)), "T-READ-02 空文件输出 0 lines（V2 文案 `Read file ..., 0 lines`）")
  check(
    svgPart.state.status === "completed" &&
      svgPart.state.metadata?.kind === "svg" &&
      svgPart.state.metadata?.mime === "image/svg+xml" &&
      !svgPart.state.metadata?.attachments,
    "T-READ-03 SVG 走文本路径且不产生附件",
  )

  // ---------- 附件组（T-READ-05~07 + T-FE-01~03） ----------
  const pngMeta = pngPart.state.metadata
  const pdfMeta = pdfPart.state.metadata
  const docxMeta = docxPart.state.metadata
  check(pngPart.state.status === "completed" && pngMeta?.kind === "image" && pngMeta?.mime === "image/png", "T-READ-05 PNG kind=image")
  pngUrl = pngMeta?.attachments?.[0]?.url
  check(
    typeof pngUrl === "string" && pngUrl.startsWith(`/api/session/${sessionID}/attachment/att_`),
    "T-READ-05 附件 URL 为受管相对路径 /api/session/{sid}/attachment/att_*",
  )
  check(!/base64,|\/workspace\//.test(JSON.stringify(pngMeta)), "T-READ-05 metadata 无 Data URL 与 Sandbox 路径")
  const png = await download(pngUrl)
  check(png.response.status === 200 && png.bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), "T-READ-05 下载字节保持 PNG signature")
  check(png.response.headers.get("content-type")?.startsWith("image/png"), "T-FE-01 下载 content-type=image/png")

  check(pdfPart.state.status === "completed" && pdfMeta?.kind === "pdf" && pdfMeta?.attachments?.[0]?.mime === "application/pdf", "T-READ-06 PDF kind=pdf")
  const pdf = await download(pdfMeta.attachments[0].url)
  check(pdf.response.status === 200 && pdf.bytes.subarray(0, 5).toString("latin1") === "%PDF-", "T-READ-06 下载内容以 %PDF- 开头")
  check(/inline/i.test(pdf.response.headers.get("content-disposition") ?? ""), "T-FE-02 PDF Content-Disposition=inline")

  check(docxPart.state.status === "completed" && docxMeta?.kind === "office" && docxMeta?.textExtracted === false, "T-READ-07 Office textExtracted=false")
  const docx = await download(docxMeta.attachments[0].url)
  check(/attachment/i.test(docx.response.headers.get("content-disposition") ?? ""), "T-FE-03/T-READ-07 Office Content-Disposition=attachment")

  // ---------- 下载协议（T-READ-08~11） ----------
  const range = await download(pngUrl, { Range: "bytes=0-7" })
  check(range.response.status === 206, "T-READ-08 Range 返回 206")
  check((range.response.headers.get("accept-ranges") ?? "").toLowerCase() === "bytes", "T-READ-08 accept-ranges=bytes")
  check((range.response.headers.get("content-range") ?? "").startsWith("bytes 0-7/"), "T-READ-08 content-range 正确")
  check(range.bytes.length === 8 && range.bytes.subarray(0, 8).equals(png.bytes.subarray(0, 8)), "T-READ-08 Range 字节与签名一致")

  const badRange = await fetch(`${BASE}${pngUrl}`, { headers: { ...headers, Range: "bytes=999999-" } })
  check(badRange.status === 416, "T-READ-09 非法 Range 返回 416")

  const etag = png.response.headers.get("etag")
  check(Boolean(etag), "T-READ-10 响应携带 ETag")
  const notModified = await fetch(`${BASE}${pngUrl}`, { headers: { ...headers, "If-None-Match": etag } })
  check(notModified.status === 304, "T-READ-10 If-None-Match 返回 304")

  const sandboxSha = (await runShell(sessionID, "sha256sum /workspace/read-fixtures/pixel.png")).split(/\s+/)[0]
  check(sha256(png.bytes) === sandboxSha, "T-READ-11 下载 SHA-256 与源文件一致")

  // ---------- 拒绝组（T-READ-04/12/13） ----------
  check(elfPart.state.status === "error" && /binary file/i.test(elfPart.state.error?.message ?? ""), "T-READ-12 ELF 拒绝为 binary file")
  check(!elfPart.state.metadata?.attachments, "T-READ-12 二进制拒绝不产生附件")
  check(invalidPart.state.status === "error" && /utf-8/i.test(invalidPart.state.error?.message ?? ""), "T-READ-04 非法 UTF-8 明确失败")
  check(oversizePart.state.status === "error" && /ingestion limit|exceeds/i.test(oversizePart.state.error?.message ?? ""), "T-READ-13 超过 20MB 拒绝")
  check(!oversizePart.state.metadata?.attachments, "T-READ-13 超限不产生部分附件")

  // ---------- PG 与 payload 安全（T-READ-14） ----------
  if (PG_URL) {
    const hits = pg(
      `SELECT count(*) FROM session_message WHERE session_id=${quote(sessionID)} AND ` +
        `(data::text LIKE '%data:image/%' OR data::text LIKE '%base64,%' OR data::text LIKE '%\\u0000%')`,
    )
    check(hits === "0", "T-READ-14 session_message 无 Base64/Data URL/null byte")
  }

  // ---------- PVC 持久化（T-READ-15） ----------
  await api(`/api/session/${sessionID}/kill-sandbox`, "POST", {})
  const boot = await api(`/api/experimental/session/${sessionID}/keep-alive`, "POST", { enabled: true, boot: true })
  check(boot.status === 200, "T-READ-15 沙箱重建（kill + keep-alive boot）")
  const pngAfterRebuild = await download(pngUrl)
  check(sha256(pngAfterRebuild.bytes) === sandboxSha, "T-READ-15 沙箱重建后附件字节不变")

  // ---------- SaaS 重启持久化（T-READ-16，需 ATTACH_RESTART_CONTAINER） ----------
  if (RESTART_CONTAINER) {
    const restarted = spawnSync("docker", ["restart", RESTART_CONTAINER], { encoding: "utf8" })
    assert.equal(restarted.status, 0, `docker restart failed: ${restarted.stderr}`)
    let ready = false
    for (let i = 0; i < 60 && !ready; i++) {
      try {
        ready = (await api("/api/info")).status === 200
      } catch {}
      if (!ready) await sleep(2000)
    }
    check(ready, "T-READ-16 SaaS 重启后恢复就绪")
    const pngAfterRestart = await download(pngUrl)
    check(sha256(pngAfterRestart.bytes) === sandboxSha, "T-READ-16 SaaS 重启后附件字节不变")
  } else {
    console.log("SKIP: T-READ-16 需设置 ATTACH_RESTART_CONTAINER 指向可丢弃容器")
  }

  // ---------- T-FE-04 认证 ----------
  const noAuth = await fetch(`${BASE}${pngUrl}`)
  check(noAuth.status === 200 || noAuth.status === 401, `T-FE-04 附件访问鉴权行为符合部署配置（无凭证=${noAuth.status}）`)
} finally {
  await api(`/api/session/${sessionID}/shell`, "POST", { command: "rm -rf /workspace/read-fixtures", timeoutSeconds: 30 }).catch(() => undefined)
  await removeSession(sessionID)
  if (PG_URL) {
    check(pg(`SELECT count(*) FROM session_v2 WHERE id=${quote(sessionID)}`) === "0", "清理：测试 session 零残留")
  }
}
