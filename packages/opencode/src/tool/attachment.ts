export * as ToolAttachment from "./attachment"

import { Identifier } from "@/id/id"
import { resolveSandboxOpts } from "@/session/sandbox-opts"
import { SessionID } from "@/session/schema"
import { SandboxProvider } from "./sandbox-provider"
import type { Sandbox } from "@alibaba-group/opensandbox"
import { Effect, Schema } from "effect"
import path from "path"

export const MAX_BYTES = 20 * 1024 * 1024
const ROOT = "/home/sandbox/.local/share/opencode/tool-attachments"

export const ID = Schema.String.check(Schema.isPattern(/^att_[0-9A-Za-z]+$/)).pipe(Schema.brand("ToolAttachmentID"))
export type ID = typeof ID.Type

export const Metadata = Schema.Struct({
  id: ID,
  sessionID: SessionID,
  filename: Schema.String,
  mime: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  audience: Schema.Literals(["model-and-display", "display-only"]),
})
export type Metadata = typeof Metadata.Type

export class Error extends Schema.TaggedErrorClass<Error>()("ToolAttachment.Error", {
  operation: Schema.Literals(["store", "read", "remove", "decode"]),
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Failed to ${this.operation} tool attachment`
  }
}

export class TooLargeError extends Schema.TaggedErrorClass<TooLargeError>()("ToolAttachment.TooLargeError", {
  filename: Schema.String,
  maximumBytes: Schema.Number,
}) {
  override get message() {
    return `Media exceeds ${this.maximumBytes} byte ingestion limit: ${this.filename}`
  }
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("ToolAttachment.NotFoundError", {
  id: Schema.String,
}) {
  override get message() {
    return `Attachment not found: ${this.id}`
  }
}

export type FileKind =
  | { readonly type: "text"; readonly mime: string }
  | { readonly type: "svg"; readonly mime: "image/svg+xml" }
  | { readonly type: "image"; readonly mime: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }
  | { readonly type: "pdf"; readonly mime: "application/pdf" }
  | { readonly type: "office"; readonly mime: string }
  | { readonly type: "binary"; readonly mime: string }

export type AttachmentSandbox = {
  readonly files: Pick<Sandbox["files"], "createDirectories" | "deleteFiles" | "readBytesStream" | "writeFiles">
}

const startsWith = (bytes: Uint8Array, prefix: readonly number[]) =>
  prefix.every((value, index) => bytes[index] === value)

const office = new Map([
  [".doc", "application/msword"],
  [".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  [".xls", "application/vnd.ms-excel"],
  [".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  [".ppt", "application/vnd.ms-powerpoint"],
  [".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  [".odt", "application/vnd.oasis.opendocument.text"],
  [".ods", "application/vnd.oasis.opendocument.spreadsheet"],
  [".odp", "application/vnd.oasis.opendocument.presentation"],
])

const blocked = new Map([
  [".zip", "application/zip"],
  [".gz", "application/gzip"],
  [".wasm", "application/wasm"],
  [".exe", "application/vnd.microsoft.portable-executable"],
  [".dll", "application/vnd.microsoft.portable-executable"],
  [".so", "application/x-sharedlib"],
  [".bin", "application/octet-stream"],
])

export function classify(filename: string, bytes: Uint8Array): FileKind {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { type: "image", mime: "image/png" }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { type: "image", mime: "image/jpeg" }
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return { type: "image", mime: "image/gif" }
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50]))
    return { type: "image", mime: "image/webp" }
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { type: "pdf", mime: "application/pdf" }

  const extension = path.posix.extname(filename).toLowerCase()
  const officeMime = office.get(extension)
  if (officeMime) return { type: "office", mime: officeMime }
  const blockedMime = blocked.get(extension)
  if (blockedMime) return { type: "binary", mime: blockedMime }
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return { type: "binary", mime: "application/x-elf" }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return { type: "binary", mime: "application/zip" }
  if (startsWith(bytes, [0x1f, 0x8b])) return { type: "binary", mime: "application/gzip" }
  if (startsWith(bytes, [0x00, 0x61, 0x73, 0x6d])) return { type: "binary", mime: "application/wasm" }
  if (startsWith(bytes, [0x4d, 0x5a])) return { type: "binary", mime: "application/vnd.microsoft.portable-executable" }

  const text = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.min(bytes.length, 4096))).trimStart()
  if (extension === ".svg" || text.startsWith("<svg") || (text.startsWith("<?xml") && text.includes("<svg")))
    return { type: "svg", mime: "image/svg+xml" }
  return { type: "text", mime: textMime(extension) }
}

export function isManagedUrl(url: string) {
  return url.startsWith("/session/") && url.includes("/attachment/")
}

export function parseByteRange(value: string | undefined, size: number) {
  if (!value) return undefined
  const match = value.match(/^bytes=(\d*)-(\d*)$/)
  if (!match || size === 0 || (!match[1] && !match[2])) return null
  if (!match[1]) {
    const length = Number(match[2])
    if (!Number.isSafeInteger(length) || length <= 0) return null
    const start = Math.max(size - length, 0)
    return { start, end: size - 1, header: `bytes=${start}-${size - 1}` }
  }
  const start = Number(match[1])
  const requestedEnd = match[2] ? Number(match[2]) : size - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= size || requestedEnd < start)
    return null
  const end = Math.min(requestedEnd, size - 1)
  return { start, end, header: `bytes=${start}-${end}` }
}

function textMime(extension: string) {
  if (extension === ".json") return "application/json"
  if (extension === ".html" || extension === ".htm") return "text/html"
  if (extension === ".css") return "text/css"
  if (extension === ".csv") return "text/csv"
  if (extension === ".md" || extension === ".mdx") return "text/markdown"
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "text/javascript"
  if (extension === ".ts" || extension === ".tsx") return "text/typescript"
  return "text/plain"
}

export const store = Effect.fn("ToolAttachment.store")(function* (input: {
  readonly sandbox: AttachmentSandbox
  readonly sessionID: SessionID
  readonly sourcePath: string
  readonly filename: string
  readonly mime: string
  readonly size?: number
  readonly audience: Metadata["audience"]
}) {
  if (input.size !== undefined && input.size > MAX_BYTES)
    return yield* new TooLargeError({ filename: input.filename, maximumBytes: MAX_BYTES })

  const id = ID.make(Identifier.create("att", "ascending"))
  const directory = attachmentDirectory(input.sessionID)
  const file = attachmentFile(input.sessionID, id)
  const hasher = new Bun.CryptoHasher("sha256")
  let size = 0
  const bytes = (async function* () {
    for await (const chunk of input.sandbox.files.readBytesStream(input.sourcePath)) {
      size += chunk.length
      if (size > MAX_BYTES) throw new TooLargeError({ filename: input.filename, maximumBytes: MAX_BYTES })
      hasher.update(chunk)
      yield chunk
    }
  })()

  yield* Effect.tryPromise({
    try: async () => {
      await input.sandbox.files.createDirectories([{ path: directory, mode: 700 }])
      await input.sandbox.files.writeFiles([{ path: file, data: bytes, mode: 600 }])
    },
    catch: (cause) => (cause instanceof TooLargeError ? cause : new Error({ operation: "store", cause })),
  }).pipe(
    Effect.catch((error) =>
      Effect.tryPromise({
        try: () => input.sandbox.files.deleteFiles([file]),
        catch: () => undefined,
      }).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
    ),
  )

  const metadata = Metadata.make({
    id,
    sessionID: input.sessionID,
    filename: sanitizeFilename(input.filename),
    mime: input.mime,
    size,
    sha256: hasher.digest("hex"),
    audience: input.audience,
  })
  yield* Effect.tryPromise({
    try: () =>
      input.sandbox.files.writeFiles([
        { path: attachmentMetadata(input.sessionID, id), data: JSON.stringify(metadata), mode: 600 },
      ]),
    catch: (cause) => new Error({ operation: "store", cause }),
  }).pipe(
    Effect.catch((error) =>
      Effect.tryPromise({
        try: () => input.sandbox.files.deleteFiles([file]),
        catch: () => undefined,
      }).pipe(Effect.ignore, Effect.andThen(Effect.fail(error))),
    ),
  )
  return { metadata, url: `/session/${input.sessionID}/attachment/${id}` }
})

export const open = Effect.fn("ToolAttachment.open")(function* (input: {
  readonly provider: SandboxProvider.Interface
  readonly sessionID: SessionID
  readonly id: ID
}) {
  const opts = yield* Effect.tryPromise({
    try: () => resolveSandboxOpts(input.sessionID),
    catch: (cause) => new Error({ operation: "read", cause }),
  })
  const sandbox = yield* input.provider
    .getOrCreate(opts.id, {
      pvcMode: opts.pvcMode,
      appId: opts.appId,
      sandbox: opts.sandbox,
    })
    .pipe(Effect.mapError((cause) => new Error({ operation: "read", cause })))
  const raw = yield* Effect.tryPromise({
    try: () => sandbox.files.readFile(attachmentMetadata(input.sessionID, input.id)),
    catch: () => new NotFoundError({ id: input.id }),
  })
  const metadata = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Metadata))(raw).pipe(
    Effect.mapError((cause) => new Error({ operation: "decode", cause })),
  )
  if (metadata.sessionID !== input.sessionID || metadata.id !== input.id)
    return yield* new NotFoundError({ id: input.id })
  return {
    metadata,
    bytes: (range?: string) =>
      sandbox.files.readBytesStream(attachmentFile(input.sessionID, input.id), {
        ...(range ? { range } : {}),
      }),
  }
})

function attachmentDirectory(sessionID: SessionID) {
  return `${ROOT}/${sessionID}`
}

function attachmentFile(sessionID: SessionID, id: ID) {
  return `${attachmentDirectory(sessionID)}/${id}.data`
}

function attachmentMetadata(sessionID: SessionID, id: ID) {
  return `${attachmentDirectory(sessionID)}/${id}.json`
}

function sanitizeFilename(filename: string) {
  return path.posix.basename(filename).replace(/[\u0000-\u001f\u007f]/g, "_") || "attachment"
}
