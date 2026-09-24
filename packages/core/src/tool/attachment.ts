export * as ToolAttachment from "./attachment.js"

import { createHash, randomBytes } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Effect, Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { Attachment } from "@opencode/schema/attachment"
import { Global } from "@opencode/util/global"
import { SandboxProvider } from "../sandbox/provider.js"

export const MAX_BYTES = 20 * 1024 * 1024
export const ROOT = process.env.OPENCODE_SANDBOX_ATTACHMENT_ROOT ?? "/home/sandbox/.local/share/opencode/tool-attachments"
const SNIFF_BYTES = 64 * 1024

export const ID = Attachment.ID
export type ID = Attachment.ID

export const Metadata = Schema.Struct({
  id: ID,
  sessionID: Session.ID,
  filename: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  audience: Schema.Literals(["model-and-display", "display-only"]),
})
export type Metadata = typeof Metadata.Type

export type Kind =
  | { readonly type: "text"; readonly mime: string }
  | { readonly type: "svg"; readonly mime: "image/svg+xml" }
  | { readonly type: "image"; readonly mime: string }
  | { readonly type: "pdf"; readonly mime: "application/pdf" }
  | { readonly type: "office"; readonly mime: string }
  | { readonly type: "binary"; readonly mime: "application/octet-stream" }

const officeMimes: Record<string, string> = {
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odp": "application/vnd.oasis.opendocument.presentation",
}

const startsWith = (bytes: Uint8Array, ...signature: number[]) => signature.every((byte, index) => bytes[index] === byte)
const extension = (filename: string) => path.posix.extname(filename).toLowerCase()
const textMime = (ext: string) =>
  ({
    ".json": "application/json",
    ".html": "text/html",
    ".htm": "text/html",
    ".css": "text/css",
    ".csv": "text/csv",
    ".md": "text/markdown",
    ".mdx": "text/markdown",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".xml": "application/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
  })[ext] ?? "text/plain"

export function classify(filename: string, bytes: Uint8Array): Kind {
  const ext = extension(filename)
  if (startsWith(bytes, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { type: "image", mime: "image/png" }
  if (startsWith(bytes, 0xff, 0xd8, 0xff)) return { type: "image", mime: "image/jpeg" }
  if (startsWith(bytes, 0x47, 0x49, 0x46, 0x38)) return { type: "image", mime: "image/gif" }
  if (startsWith(bytes, 0x42, 0x4d)) return { type: "image", mime: "image/bmp" }
  if (startsWith(bytes, 0x52, 0x49, 0x46, 0x46) && startsWith(bytes.subarray(8), 0x57, 0x45, 0x42, 0x50))
    return { type: "image", mime: "image/webp" }
  if (startsWith(bytes, 0x25, 0x50, 0x44, 0x46, 0x2d)) return { type: "pdf", mime: "application/pdf" }
  if (officeMimes[ext]) return { type: "office", mime: officeMimes[ext] }

  if (
    startsWith(bytes, 0x7f, 0x45, 0x4c, 0x46) ||
    startsWith(bytes, 0x50, 0x4b, 0x03, 0x04) ||
    startsWith(bytes, 0x1f, 0x8b) ||
    startsWith(bytes, 0x00, 0x61, 0x73, 0x6d) ||
    startsWith(bytes, 0x4d, 0x5a) ||
    [".zip", ".gz", ".wasm", ".exe", ".dll", ".so", ".bin"].includes(ext)
  )
    return { type: "binary", mime: "application/octet-stream" }

  const sample = bytes.subarray(0, SNIFF_BYTES)
  if (sample.includes(0)) return { type: "binary", mime: "application/octet-stream" }
  if (sample.length > 0) {
    let nonPrintable = 0
    for (const byte of sample) if (byte < 9 || (byte > 13 && byte < 32)) nonPrintable++
    if (nonPrintable / sample.length > 0.3) return { type: "binary", mime: "application/octet-stream" }
  }

  const text = new TextDecoder().decode(sample).trimStart()
  if (ext === ".svg" || text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg")))
    return { type: "svg", mime: "image/svg+xml" }
  return { type: "text", mime: textMime(ext) }
}

export class TooLargeError extends Schema.TaggedError<TooLargeError>()("ToolAttachment.TooLargeError", {
  filename: Schema.String,
  maximumBytes: Schema.Number,
}) {
  override get message() {
    return `Media exceeds ${this.maximumBytes} byte ingestion limit: ${this.filename}`
  }
}

export class NotFoundError extends Schema.TaggedError<NotFoundError>()("ToolAttachment.NotFoundError", {
  id: Schema.String,
}) {}

const directory = (sessionID: Session.ID) => `${ROOT}/${sessionID}`
const dataPath = (sessionID: Session.ID, id: ID) => `${directory(sessionID)}/${id}.data`
const metadataPath = (sessionID: Session.ID, id: ID) => `${directory(sessionID)}/${id}.json`
const localDirectory = (sessionID: Session.ID) => path.join(Global.Path.data, "tool-attachments", sessionID)
const localDataPath = (sessionID: Session.ID, id: ID) => path.join(localDirectory(sessionID), `${id}.data`)
const localMetadataPath = (sessionID: Session.ID, id: ID) => path.join(localDirectory(sessionID), `${id}.json`)
const safeFilename = (filename: string) =>
  path.posix.basename(filename).replace(/[\u0000-\u001f\u007f"\\]/g, "_").slice(0, 255) || "attachment"
const verifiedBytes = (encoded: string, metadata: Metadata) => {
  const bytes = Buffer.from(encoded, "base64")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (bytes.byteLength !== metadata.size || sha256 !== metadata.sha256) return undefined
  return bytes
}

export const store = Effect.fn("ToolAttachment.store")(function* (input: {
  provider: SandboxProvider.Interface
  sessionID: Session.ID
  sourcePath: string
  filename: string
}) {
  const stat = yield* input.provider.fileStat(input.sessionID, input.sourcePath)
  if (stat?.size !== undefined && stat.size > MAX_BYTES)
    return yield* new TooLargeError({ filename: input.filename, maximumBytes: MAX_BYTES })
  const bytes = yield* input.provider.fileReadBytes(input.sessionID, input.sourcePath)
  if (!bytes) return yield* new NotFoundError({ id: input.sourcePath })
  if (bytes.byteLength > MAX_BYTES)
    return yield* new TooLargeError({ filename: input.filename, maximumBytes: MAX_BYTES })

  const id = ID.make(`att_${randomBytes(16).toString("hex")}`)
  const kind = classify(input.filename, bytes.subarray(0, SNIFF_BYTES))
  const audience = kind.type === "office" ? "display-only" : "model-and-display"
  const metadata: Metadata = {
    id,
    sessionID: input.sessionID,
    filename: safeFilename(input.filename),
    mime: kind.mime,
    size: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    audience,
  }
  const encoded = Buffer.from(bytes).toString("base64")
  yield* input.provider.fileWrite(input.sessionID, dataPath(input.sessionID, id), encoded).pipe(
    Effect.tapError(() => input.provider.fileDelete(input.sessionID, dataPath(input.sessionID, id)).pipe(Effect.ignore)),
  )
  yield* input.provider.fileWrite(input.sessionID, metadataPath(input.sessionID, id), JSON.stringify(metadata)).pipe(
    Effect.tapError(() => input.provider.fileDelete(input.sessionID, dataPath(input.sessionID, id)).pipe(Effect.ignore)),
  )
  return { metadata, url: `/api/session/${input.sessionID}/attachment/${id}` }
})

export const storeLocal = Effect.fn("ToolAttachment.storeLocal")(function* (input: {
  sessionID: Session.ID
  filename: string
  bytes: Uint8Array
}) {
  if (input.bytes.byteLength > MAX_BYTES)
    return yield* new TooLargeError({ filename: input.filename, maximumBytes: MAX_BYTES })
  const kind = classify(input.filename, input.bytes.subarray(0, SNIFF_BYTES))
  if (kind.type !== "image" && kind.type !== "pdf" && kind.type !== "office")
    return yield* new NotFoundError({ id: input.filename })
  const id = ID.make(`att_${randomBytes(16).toString("hex")}`)
  const metadata: Metadata = {
    id,
    sessionID: input.sessionID,
    filename: safeFilename(input.filename),
    mime: kind.mime,
    size: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
    audience: kind.type === "office" ? "display-only" : "model-and-display",
  }
  yield* Effect.tryPromise({
    try: async () => {
      await fs.mkdir(localDirectory(input.sessionID), { recursive: true })
      await fs.writeFile(localDataPath(input.sessionID, id), Buffer.from(input.bytes).toString("base64"), { mode: 0o600 })
      await fs.writeFile(localMetadataPath(input.sessionID, id), JSON.stringify(metadata), { mode: 0o600 })
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  }).pipe(
    Effect.tapError(() =>
      Effect.promise(() =>
        Promise.all([
          fs.rm(localDataPath(input.sessionID, id), { force: true }),
          fs.rm(localMetadataPath(input.sessionID, id), { force: true }),
        ]),
      ).pipe(Effect.ignore),
    ),
  )
  return { metadata, url: `/api/session/${input.sessionID}/attachment/${id}` }
})

export const open = Effect.fn("ToolAttachment.open")(function* (input: {
  provider: SandboxProvider.Interface
  sessionID: Session.ID
  id: ID
}) {
  const raw = yield* input.provider.fileRead(input.sessionID, metadataPath(input.sessionID, input.id))
  if (!raw) return yield* new NotFoundError({ id: input.id })
  const decoded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata))(raw).pipe(
    Effect.catch(() => Effect.fail(new NotFoundError({ id: input.id }))),
  )
  if (decoded.id !== input.id || decoded.sessionID !== input.sessionID)
    return yield* new NotFoundError({ id: input.id })
  const encoded = yield* input.provider.fileRead(input.sessionID, dataPath(input.sessionID, input.id))
  if (!encoded) return yield* new NotFoundError({ id: input.id })
  const bytes = verifiedBytes(encoded, decoded)
  if (!bytes) return yield* new NotFoundError({ id: input.id })
  return { metadata: decoded, bytes }
})

export const openLocal = Effect.fn("ToolAttachment.openLocal")(function* (input: {
  sessionID: Session.ID
  id: ID
}) {
  const decoded = yield* Effect.tryPromise({
    try: async () => {
      const metadataRaw = await fs.readFile(localMetadataPath(input.sessionID, input.id), "utf8")
      const metadata = Schema.decodeUnknownSync(Schema.fromJsonString(Metadata))(metadataRaw)
      if (metadata.id !== input.id || metadata.sessionID !== input.sessionID) throw new Error("metadata mismatch")
      const encoded = await fs.readFile(localDataPath(input.sessionID, input.id), "utf8")
      const bytes = verifiedBytes(encoded, metadata)
      if (!bytes) throw new Error("attachment integrity mismatch")
      return { metadata, bytes }
    },
    catch: () => new NotFoundError({ id: input.id }),
  })
  return decoded
})

export const forModel = Effect.fn("ToolAttachment.forModel")(function* (input: {
  provider: SandboxProvider.Interface
  sessionID: Session.ID
  id: ID
}) {
  const file = yield* open(input)
  if (file.metadata.audience !== "model-and-display") return
  return { metadata: file.metadata, data: file.bytes.toString("base64") }
})

export const forModelLocal = Effect.fn("ToolAttachment.forModelLocal")(function* (input: {
  sessionID: Session.ID
  id: ID
}) {
  const file = yield* openLocal(input)
  if (file.metadata.audience !== "model-and-display") return
  return { metadata: file.metadata, data: file.bytes.toString("base64") }
})

export function parseByteRange(value: string | undefined, size: number) {
  if (!value) return undefined
  const match = /^bytes=(\d*)-(\d*)$/.exec(value)
  if (!match || size === 0 || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const length = Number(match[2])
    if (!Number.isSafeInteger(length) || length <= 0) return null
    const start = Math.max(size - length, 0)
    return { start, end: size - 1 }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start)
    return null
  return { start, end: Math.min(requestedEnd, size - 1) }
}
