import { describe, expect, test } from "bun:test"
import { imageResizeCacheSize, resizeImageDataUrl } from "../../src/plugin/ccr/lib/image-resize"

async function makePngDataUrl(size: number, height?: number): Promise<string> {
  const photon = await import("@silvia-odwyer/photon-node")
  const h = height ?? size
  const rgba = new Uint8Array(size * h * 4)
  for (let i = 0; i < size * h; i++) {
    rgba[i * 4] = 200
    rgba[i * 4 + 1] = 40
    rgba[i * 4 + 2] = 40
    rgba[i * 4 + 3] = 255
  }
  const canvas = new photon.PhotonImage(rgba, size, h)
  const bytes = canvas.get_bytes()
  canvas.free()
  return `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`
}

async function pngDimensions(dataUrl: string): Promise<[number, number]> {
  const photon = await import("@silvia-odwyer/photon-node")
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1)
  const img = photon.PhotonImage.new_from_byteslice(Buffer.from(b64, "base64"))
  try {
    return [img.get_width(), img.get_height()]
  } finally {
    img.free()
  }
}

describe("resizeImageDataUrl", () => {
  test("resizes a large screenshot to fit 512 (Anthropic pixel billing parity)", async () => {
    const original = await makePngDataUrl(1024)
    const [w0, h0] = await pngDimensions(original)
    expect(w0).toBe(1024)

    const resized = await resizeImageDataUrl(original)
    expect(resized).toBeDefined()
    const [w1, h1] = await pngDimensions(resized!)
    expect(Math.max(w1, h1)).toBe(512)
    expect(w1).toBe(512)
    expect(h1).toBe(512)
    // -75% token parity: (512*512)/750 vs (1024*1024)/750
    expect((w1 * h1) / (w0 * h0)).toBeCloseTo(0.25, 1)
  })

  test("second call hits the content-addressed cache", async () => {
    const original = await makePngDataUrl(600)
    const first = await resizeImageDataUrl(original)
    expect(first).toBeDefined()
    const second = await resizeImageDataUrl(original)
    expect(second).toBe(first)
  })

  test("passes through images already within the edge budget", async () => {
    const small = await makePngDataUrl(128)
    const result = await resizeImageDataUrl(small)
    // unchanged input echoes back (cache hit path) — same pixels
    expect(result).toBeDefined()
    const [w, h] = await pngDimensions(result!)
    expect(w).toBe(128)
    expect(h).toBe(128)
  })

  test("area-based scaling keeps any aspect ratio at the same token cost", async () => {
    // 200x1600 长截图（320K px）：面积法 → 181x1448 (≈262K px)，
    // 不是 maxEdge 的 64x512 糊条
    const tall = await makePngDataUrl(200, 1600)
    const resized = await resizeImageDataUrl(tall)
    expect(resized).toBeDefined()
    const [w, h] = await pngDimensions(resized!)
    expect(w * h).toBeLessThanOrEqual(512 * 512)
    expect(w * h).toBeGreaterThan(512 * 512 - 2048)
    expect(w / h).toBeCloseTo(200 / 1600, 2)
  })

  test("includes maxPixels in the cache identity", async () => {
    const original = await makePngDataUrl(700)
    expect(await resizeImageDataUrl(original, 700 * 700)).toBe(original)

    const resized = await resizeImageDataUrl(original, 256 * 256)
    expect(resized).toBeDefined()
    const [width, height] = await pngDimensions(resized!)
    expect(width * height).toBeLessThanOrEqual(256 * 256)
  })

  test("returns undefined for non-image payloads", async () => {
    expect(await resizeImageDataUrl("data:text/plain;base64,SGVsbG8=")).toBeUndefined()
    expect(await resizeImageDataUrl("file:///workspace/shot.png")).toBeUndefined()
    expect(await resizeImageDataUrl("not a url at all")).toBeUndefined()
  })

  test("bounds the cache for unchanged images", async () => {
    const small = await makePngDataUrl(1)
    for (let i = 0; i < 205; i++) await resizeImageDataUrl(`${small}${" ".repeat(i)}`)
    expect(imageResizeCacheSize()).toBeLessThanOrEqual(200)
  })

  test("rejects oversized data URLs before decoding", async () => {
    const oversized = `data:image/png;base64,${"A".repeat(16 * 1024 * 1024)}`
    expect(await resizeImageDataUrl(oversized)).toBeUndefined()
  })
})
