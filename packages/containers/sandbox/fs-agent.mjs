#!/usr/bin/env node
// opencode sandbox fs-agent — runs INSIDE the sandbox container.
//
// Invoked by the host WorkspaceDriver as:
//   docker exec -i <container> node /opt/opencode-sandbox/fs-agent.mjs
// with one JSON request on stdin and one JSON response on stdout.
//
// The protocol mirrors the host-side Environment FilesImpl contract
// (packages/core/src/environment/files.ts):
//   request:  { op: "stat" | "read" | "list" | "write" | "remove" | "move" | "mkdir",
//               path?, from?, to?, offset?, length?, bytes? /* base64 */ }
//   response: { ok: true, result } | { ok: false, error: { kind, path, actual?, message? } }
//
// Semantics deliberately match environment/local.ts (lstat for stat, stat
// follows final symlinks for read/list targets, move joins into directories).
import fs from "node:fs/promises"
import path from "node:path"
import process from "node:process"

const fileType = (entry) => {
  if (entry.isFile()) return "file"
  if (entry.isDirectory()) return "directory"
  if (entry.isSymbolicLink()) return "symlink"
  return "other"
}

const isMissing = (cause) =>
  cause !== null &&
  typeof cause === "object" &&
  "code" in cause &&
  (cause.code === "ENOENT" || cause.code === "ENOTDIR")

const fail = (kind, path, extra = {}) => ({ ok: false, error: { kind, path, ...extra } })

const respond = async (request) => {
  const { op } = request
  if (op === "stat") {
    const stats = await fs.lstat(request.path)
    return { ok: true, result: { type: fileType(stats), size: stats.size, mtimeMs: stats.mtimeMs } }
  }
  if (op === "read") {
    const target = await fs.stat(request.path)
    const info = { type: fileType(target), size: target.size, mtimeMs: target.mtimeMs }
    if (info.type !== "file") return fail("WrongKind", request.path, { actual: info.type })
    const range = request.offset === undefined ? undefined : { offset: request.offset, length: request.length }
    if (range === undefined) {
      const bytes = await fs.readFile(request.path)
      return { ok: true, result: { info, bytes: bytes.toString("base64") } }
    }
    const handle = await fs.open(request.path, "r")
    try {
      const buffer = Buffer.alloc(range.length)
      const result = await handle.read(buffer, 0, range.length, range.offset)
      return { ok: true, result: { info, bytes: buffer.subarray(0, result.bytesRead).toString("base64") } }
    } finally {
      await handle.close()
    }
  }
  if (op === "list") {
    const entries = await fs.readdir(request.path, { withFileTypes: true })
    return { ok: true, result: entries.map((entry) => ({ name: entry.name, type: fileType(entry) })) }
  }
  if (op === "write") {
    await fs.mkdir(path.dirname(request.path), { recursive: true })
    await fs.writeFile(request.path, Buffer.from(request.bytes, "base64"))
    return { ok: true, result: null }
  }
  if (op === "remove") {
    await fs.rm(request.path, { recursive: true, force: true })
    return { ok: true, result: null }
  }
  if (op === "move") {
    await fs.stat(request.from)
    let destination = request.to
    try {
      if (fileType(await fs.stat(request.to)) === "directory") destination = path.join(request.to, path.basename(request.from))
    } catch (cause) {
      if (!isMissing(cause)) throw cause
    }
    await fs.rename(request.from, destination)
    return { ok: true, result: null }
  }
  if (op === "mkdir") {
    await fs.mkdir(request.path, { recursive: true })
    return { ok: true, result: null }
  }
  return fail("Failed", String(request.path ?? ""), { message: `unknown op ${String(op)}` })
}

let input = ""
process.stdin.setEncoding("utf8")
process.stdin.on("data", (data) => (input += data))
process.stdin.on("end", () => {
  respond(JSON.parse(input))
    .then((response) => {
      process.stdout.write(JSON.stringify(response))
      process.exit(0)
    })
    .catch((cause) => {
      const request = {}
      try {
        Object.assign(request, JSON.parse(input))
      } catch {}
      const kind = isMissing(cause) ? "NotFound" : "Failed"
      process.stdout.write(JSON.stringify(fail(kind, String(request.path ?? request.from ?? ""), kind === "Failed" ? { message: String(cause) } : {})))
      process.exit(0)
    })
})
