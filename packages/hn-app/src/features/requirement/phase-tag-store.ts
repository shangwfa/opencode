/**
 * 阶段标签全局状态（Solid createSignal → zustand 同语义重写）。
 * 源：phase-tag-store.ts（latestPhaseTag / phaseTags / phaseTagsByParent 三组 signal）。
 */
import { createStore, useStore } from "zustand"
import type { PhaseTag } from "./phase-tag"

type PhaseTagState = {
  latestPhaseTag: PhaseTag | null
  phaseTags: PhaseTag[]
  /** 按 parent id 分组的标签映射 */
  phaseTagsByParent: Map<string, PhaseTag[]>
}

export const phaseTagStore = createStore<PhaseTagState>(() => ({
  latestPhaseTag: null,
  phaseTags: [],
  phaseTagsByParent: new Map(),
}))

export function setLatestPhaseTag(tag: PhaseTag | null) {
  phaseTagStore.setState({ latestPhaseTag: tag })
}

export function setPhaseTags(tags: PhaseTag[]) {
  phaseTagStore.setState({ phaseTags: tags })
}

export function setPhaseTagsByParent(map: Map<string, PhaseTag[]>) {
  phaseTagStore.setState({ phaseTagsByParent: map })
}

/** React 订阅入口 */
export function usePhaseTags<T>(selector: (s: PhaseTagState) => T): T {
  return useStore(phaseTagStore, selector)
}
