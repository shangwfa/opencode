import photonWasm from "#photon-wasm"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const MAX_PIXELS = 512 * 512
const MAX_INPUT = 16 * 1024 * 1024
const MAX_DECODE_PIXELS = 25_000_000
const CACHE_LIMIT = 200
const cache = new Map<string, string>()
let loading: Promise<typeof import("@silvia-odwyer/photon-node")> | undefined

function encodedDimensions(bytes: Buffer, mime: string): [number, number] | undefined {
  if (mime === "image/png" && bytes.length >= 24 && bytes.subarray(12, 16).toString("ascii") === "IHDR")
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 8 < bytes.length;) {
      if (bytes[offset] !== 0xff) { offset++; continue }
      const marker = bytes[offset + 1]!
      if (marker === 0xd8 || marker === 0xd9) { offset += 2; continue }
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) return undefined
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker))
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)]
      offset += length + 2
    }
  }
  if (mime === "image/webp" && bytes.length >= 25 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP") {
    const kind = bytes.subarray(12, 16).toString()
    if (kind === "VP8X" && bytes.length >= 30)
      return [1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16), 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)]
    if (kind === "VP8L" && bytes[20] === 0x2f)
      return [1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!), 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | (bytes[22]! >> 6))]
    if (kind === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a])))
      return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
  }
  return undefined
}

function photon() {
  loading ??= (async () => {
    if (!photonWasm) throw new Error("photon wasm unavailable")
    ;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
      path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url))
    return import("@silvia-odwyer/photon-node")
  })().catch((error) => {
    loading = undefined
    throw error
  })
  return loading
}

function remember(key: string, value: string) {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

/** Shrink old history media to a fixed pixel-area budget. Any failure is a passthrough. */
export async function resizeHistoryImage(mime: string, data: string | Uint8Array): Promise<string | Uint8Array | undefined> {
  if (!/^image\/(png|jpeg|webp)$/.test(mime)) return undefined
  if (typeof data === "string" ? data.length > MAX_INPUT : data.byteLength > MAX_INPUT) return undefined
  const bytes = typeof data === "string" ? Buffer.from(data, "base64") : Buffer.from(data)
  if (bytes.length < 24) return undefined
  const dimensions = encodedDimensions(bytes, mime)
  if (dimensions && dimensions[1] > 0 && dimensions[0] > MAX_DECODE_PIXELS / dimensions[1]) return undefined
  if (dimensions && dimensions[0] > 0 && dimensions[1] > 0 && dimensions[0] * dimensions[1] <= MAX_PIXELS) {
    remember(createHash("sha256").update(`${MAX_PIXELS}\0${mime}\0`).update(bytes).digest("hex").slice(0, 24), "")
    return undefined
  }
  const key = createHash("sha256").update(`${MAX_PIXELS}\0${mime}\0`).update(bytes).digest("hex").slice(0, 24)
  const cached = cache.get(key)
  if (cache.has(key)) {
    const result = cached ?? ""
    remember(key, result)
    if (!result) return undefined
    return typeof data === "string" ? result : Buffer.from(result, "base64")
  }
  try {
    const image = await photon()
    const original = image.PhotonImage.new_from_byteslice(bytes)
    try {
      const width = original.get_width()
      const height = original.get_height()
      if (!width || !height || width > MAX_DECODE_PIXELS / height) return undefined
      if (width * height <= MAX_PIXELS) {
        remember(key, "")
        return undefined
      }
      const scale = Math.sqrt(MAX_PIXELS / (width * height))
      const resizedWidth = Math.max(1, Math.floor(width * scale))
      const resizedHeight = Math.max(1, Math.min(Math.floor(height * scale), Math.floor(MAX_PIXELS / resizedWidth)))
      const resized = image.resize(original, resizedWidth, resizedHeight, image.SamplingFilter.Lanczos3)
      try {
        const base64 = Buffer.from(resized.get_bytes()).toString("base64")
        remember(key, base64)
        return typeof data === "string" ? base64 : Buffer.from(base64, "base64")
      } finally {
        resized.free()
      }
    } finally {
      original.free()
    }
  } catch {
    return undefined
  }
}

export const historyImageCacheSize = () => cache.size
