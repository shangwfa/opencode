// Provider-adaptive image resize (Headroom image-compression parity, Anthropic
// flavor): Anthropic-protocol providers bill images by pixels ((w*h)/750), so
// resizing a history screenshot to fit 512x512 drops it from ~1398 to ~349
// tokens (-75%). Only images OUTSIDE the protection window are resized — the
// freshly-posted ones a user is actively discussing stay full fidelity.
//
// Uses the photon wasm already bundled by opencode (same loader pattern as
// core image/photon.ts) — no new dependency. Any failure returns undefined and
// the original image passes through untouched; this must never fail a request.

import photonWasm from "@silvia-odwyer/photon-node/photon_rs_bg.wasm" with { type: "file" }
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
;(globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH =
  (globalThis as typeof globalThis & { __OPENCODE_PHOTON_WASM_PATH?: string }).__OPENCODE_PHOTON_WASM_PATH ??
  (path.isAbsolute(photonWasm) ? photonWasm : fileURLToPath(new URL(photonWasm, import.meta.url)))

type PhotonModule = typeof import("@silvia-odwyer/photon-node")
let loading: Promise<PhotonModule> | undefined

function loadPhoton(): Promise<PhotonModule> {
  loading ??= import("@silvia-odwyer/photon-node").catch(() => {
    loading = undefined
    throw new Error("photon unavailable")
  })
  return loading
}

const MAX_PIXELS = 512 * 512
// In-memory content-addressed cache: the transform runs on EVERY request, so
// each history image pays the resize cost exactly once per process.
const cache = new Map<string, string>()
const CACHE_MAX = 200
const MAX_DATA_URL_CHARS = 16 * 1024 * 1024
const MAX_DECODE_PIXELS = 25_000_000

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/s

export function imageResizeCacheSize(): number {
  return cache.size
}

function encodedDimensions(bytes: Buffer, mime: string): [number, number] | undefined {
  if (mime === "image/png" && bytes.length >= 24 && bytes.subarray(12, 16).toString("ascii") === "IHDR") {
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)]
  }
  if (mime === "image/jpeg" && bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 8 < bytes.length; ) {
      if (bytes[offset] !== 0xff) {
        offset++
        continue
      }
      const marker = bytes[offset + 1]!
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2
        continue
      }
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) return undefined
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return [bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5)]
      }
      offset += length + 2
    }
  }
  if (mime !== "image/webp" || bytes.length < 25) return undefined
  const kind = bytes.subarray(12, 16).toString("ascii")
  if (kind === "VP8X" && bytes.length >= 30) {
    const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16)
    const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16)
    return [width, height]
  }
  if (kind === "VP8L" && bytes[20] === 0x2f) {
    const width = 1 + (((bytes[22]! & 0x3f) << 8) | bytes[21]!)
    const height = 1 + (((bytes[24]! & 0x0f) << 10) | (bytes[23]! << 2) | (bytes[22]! >> 6))
    return [width, height]
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))) {
    return [bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff]
  }
  return undefined
}

function cacheKey(dataUrl: string, maxPixels: number): string {
  return createHash("sha256").update(`${maxPixels}\u0000${dataUrl}`).digest("hex").slice(0, 24)
}

function cacheResult(key: string, value: string): void {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size <= CACHE_MAX) return
  const oldest = cache.keys().next().value
  if (oldest !== undefined) cache.delete(oldest)
}

/** Returns the original or resized data URL, or undefined for unsupported or
 *  invalid input and decode failures.
 *
 *  Area-based scaling: Anthropic bills images by PIXELS ((w*h)/750), so the
 *  budget is a pixel AREA, not a max edge — any aspect ratio lands on the
 *  same ~349 tokens with evenly spread information density. A max-edge rule
 *  would squash a 200x4000 screenshot into an illegible 25x512 strip. */
export async function resizeImageDataUrl(dataUrl: string, maxPixels: number = MAX_PIXELS): Promise<string | undefined> {
  if (!dataUrl.startsWith("data:image/")) return undefined
  if (dataUrl.length > MAX_DATA_URL_CHARS || !Number.isFinite(maxPixels) || maxPixels < 1) return undefined
  const pixelBudget = Math.floor(maxPixels)
  const key = cacheKey(dataUrl, pixelBudget)
  const hit = cache.get(key)
  if (hit !== undefined) {
    cacheResult(key, hit)
    return hit
  }

  const m = DATA_URL_RE.exec(dataUrl)
  if (!m) return undefined
  try {
    const bytes = Buffer.from(m[2], "base64")
    const dimensions = encodedDimensions(bytes, m[1])
    if (dimensions && dimensions[1] > 0 && dimensions[0] > MAX_DECODE_PIXELS / dimensions[1]) return undefined
    const photon = await loadPhoton()
    const decoded = photon.PhotonImage.new_from_byteslice(bytes)
    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      if (width * height <= pixelBudget) {
        cacheResult(key, dataUrl)
        return dataUrl
      }
      const scale = Math.sqrt(pixelBudget / (width * height))
      const resizedWidth = Math.max(1, Math.floor(width * scale))
      const resizedHeight = Math.max(1, Math.min(Math.floor(height * scale), Math.floor(pixelBudget / resizedWidth)))
      const resized = photon.resize(decoded, resizedWidth, resizedHeight, photon.SamplingFilter.Lanczos3)
      try {
        // PNG out (token cost is pixel-based, format irrelevant) so alpha survives.
        const out = `data:image/png;base64,${Buffer.from(resized.get_bytes()).toString("base64")}`
        cacheResult(key, out)
        return out
      } finally {
        resized.free()
      }
    } finally {
      decoded.free()
    }
  } catch {
    return undefined
  }
}
