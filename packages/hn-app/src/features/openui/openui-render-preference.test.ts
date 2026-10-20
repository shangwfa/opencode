import { afterEach, describe, expect, test } from "vitest"
import {
  isOpenUIRenderingEnabled,
  OPENUI_RENDERING_STORAGE_KEY,
  readOpenUIRenderingEnabled,
  setOpenUIRenderingEnabled,
} from "./openui-render-preference"

function memoryStorage(initial?: string) {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(OPENUI_RENDERING_STORAGE_KEY, initial)
  return {
    getItem(key: string) {
      return values.get(key) ?? null
    },
    setItem(key: string, value: string) {
      values.set(key, value)
    },
  }
}

afterEach(() => {
  setOpenUIRenderingEnabled(true, memoryStorage())
})

describe("OpenUI rendering preference", () => {
  test("defaults to enabled and restores a persisted choice", () => {
    expect(readOpenUIRenderingEnabled(memoryStorage())).toBe(true)
    expect(readOpenUIRenderingEnabled(memoryStorage("true"))).toBe(true)
    expect(readOpenUIRenderingEnabled(memoryStorage("false"))).toBe(false)
  })

  test("updates the reactive value and persists it", () => {
    const storage = memoryStorage()

    setOpenUIRenderingEnabled(false, storage)
    expect(isOpenUIRenderingEnabled()).toBe(false)
    expect(storage.getItem(OPENUI_RENDERING_STORAGE_KEY)).toBe("false")

    setOpenUIRenderingEnabled(true, storage)
    expect(isOpenUIRenderingEnabled()).toBe(true)
    expect(storage.getItem(OPENUI_RENDERING_STORAGE_KEY)).toBe("true")
  })

  test("keeps the in-memory preference when storage is unavailable", () => {
    setOpenUIRenderingEnabled(false, null)
    expect(isOpenUIRenderingEnabled()).toBe(false)
  })
})
