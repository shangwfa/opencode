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

const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/s

function cacheKey(dataUrl: string): string {
  return createHash("sha256").update(dataUrl).digest("hex").slice(0, 24)
}

/** Returns a resized data URL, or undefined when the image needs no change
 *  (non-image mime, already within the pixel budget, or any decode failure).
 *
 *  Area-based scaling: Anthropic bills images by PIXELS ((w*h)/750), so the
 *  budget is a pixel AREA, not a max edge — any aspect ratio lands on the
 *  same ~349 tokens with evenly spread information density. A max-edge rule
 *  would squash a 200x4000 screenshot into an illegible 25x512 strip. */
export async function resizeImageDataUrl(dataUrl: string, maxPixels: number = MAX_PIXELS): Promise<string | undefined> {
  if (!dataUrl.startsWith("data:image/")) return undefined
  const key = cacheKey(dataUrl)
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const m = DATA_URL_RE.exec(dataUrl)
  if (!m) return undefined
  try {
    const photon = await loadPhoton()
    const decoded = photon.PhotonImage.new_from_byteslice(Buffer.from(m[2], "base64"))
    try {
      const width = decoded.get_width()
      const height = decoded.get_height()
      if (width * height <= maxPixels) {
        cache.set(key, dataUrl)
        return dataUrl
      }
      const scale = Math.sqrt(maxPixels / (width * height))
      const resized = photon.resize(
        decoded,
        Math.max(1, Math.round(width * scale)),
        Math.max(1, Math.round(height * scale)),
        photon.SamplingFilter.Lanczos3,
      )
      try {
        // PNG out (token cost is pixel-based, format irrelevant) so alpha survives.
        const out = `data:image/png;base64,${Buffer.from(resized.get_bytes()).toString("base64")}`
        if (cache.size >= CACHE_MAX) {
          const oldest = cache.keys().next().value
          if (oldest !== undefined) cache.delete(oldest)
        }
        cache.set(key, out)
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
