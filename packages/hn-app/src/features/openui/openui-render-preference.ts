/**
 * OpenUI 渲染偏好（Solid createSignal → zustand 同语义重写）。
 * 源：openui-render-preference.ts；localStorage key 与读写语义不变。
 */
import { createStore, useStore } from "zustand"

export const OPENUI_RENDERING_STORAGE_KEY = "openui.render.enabled.v1"

type StorageLike = Pick<Storage, "getItem" | "setItem">

function browserStorage(): StorageLike | undefined {
  if (typeof localStorage === "undefined") return undefined
  return localStorage
}

export function readOpenUIRenderingEnabled(storage: StorageLike | null | undefined = browserStorage()) {
  if (!storage) return true
  try {
    return storage.getItem(OPENUI_RENDERING_STORAGE_KEY) !== "false"
  } catch {
    return true
  }
}

const store = createStore<{ enabled: boolean }>(() => ({
  enabled: readOpenUIRenderingEnabled(),
}))

export function isOpenUIRenderingEnabled() {
  return store.getState().enabled
}

export function setOpenUIRenderingEnabled(
  enabled: boolean,
  storage: StorageLike | null | undefined = browserStorage(),
) {
  store.setState({ enabled })
  if (!storage) return
  try {
    storage.setItem(OPENUI_RENDERING_STORAGE_KEY, String(enabled))
  } catch {
    // Storage may be blocked or full; keep the current in-memory preference.
  }
}

/** React 订阅入口 */
export function useOpenUIRenderingEnabled(): boolean {
  return useStore(store, (s) => s.enabled)
}
