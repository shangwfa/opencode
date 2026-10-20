/**
 * StageMachine（React/zustand 版）。
 *
 * 自 xybot-front-opencode-ui src/features/requirement/stage-machine.ts 迁移，
 * 语义与公开 API 与 Solid 版保持一致（CONTEXT.md 的「阶段机器」深模块）：
 * - 持有 workingIndex / viewIndex / 产物列表 / syncing / suggestStep / skippedStageIds
 * - 推进接缝 tryAdvance()（顺序）、jumpAdvance()（跳转）、switchStageById()
 * - 产物同步通过注入的 fetchArtifact 适配器；跳转建议通过注入的 fetchSuggestStep
 *
 * 差异说明：
 * - solid-js/store → zustand vanilla store；produce 变更改为不可变更新
 * - createMemo 派生值 → 基于 getState() 的普通函数（zustand 选择器负责细粒度订阅）
 * - @/ui/components/toast → 注入 input.onToast（UI 层接 sonner/shadcn Toast）
 */
import { createStore, useStore, type StoreApi } from "zustand"
import type {
  RequirementFlowConfig,
  StageArtifact,
  StageConfig,
} from "./flows/config"
import { stageHasArtifact } from "./flows/utils"
import {
  artifactForStage,
  buildStageEnterPrompt,
  canAdvanceNow,
  canGoForward,
  canSwitchToStage,
  isLastStageIndex,
  isSuggestStepDone,
  isSuggestStepValid,
  planAdvance,
  planAdvanceToIndex,
  resolveSuggestStepStageIndex,
  resolveNextStageIndex,
  type SuggestStepData,
  type StageAdvancePlan,
  type StageSnapshot,
} from "./stage-runtime"

export type StageMachineState = {
  workingIndex: number;
  viewIndex: number;
  artifacts: StageArtifact[];
  syncing: boolean;
  suggestStep: SuggestStepData | null;
  skippedStageIds: readonly string[];
  /** [DYNAMIC-HARNESS] 用户当前查看的产物路径（点击子 agent 产物卡片时设置） */
  viewingArtifactPath?: string;
};

export type AdvanceResult =
  | { advanced: true; plan: StageAdvancePlan }
  | { advanced: false };

export type StageToast = {
  variant?: "default" | "destructive" | "error";
  title: string;
  description?: string;
};

export type StageMachine = {
  /** zustand vanilla store（测试/命令式场景用） */
  store: StoreApi<StageMachineState>;
  getState: () => StageMachineState;
  setState: StoreApi<StageMachineState>["setState"];
  /** React 绑定：machine.use((s) => s.workingIndex) */
  use: <T>(selector: (state: StageMachineState) => T) => T;

  snapshot: () => StageSnapshot;
  workingStage: () => StageConfig | undefined;
  viewStage: () => StageConfig | undefined;
  workingStageId: () => string | undefined;
  viewStageId: () => string | undefined;
  isPeeking: () => boolean;
  isLastStage: () => boolean;
  canAdvance: (opts: { isConfirmed: (stageId: string) => boolean }) => boolean;
  advanceHint: (opts: {
    working: boolean;
    isConfirmed: (stageId: string) => boolean;
  }) => string | undefined;

  hydrate: (index: number) => void;
  tryAdvance: () => AdvanceResult;
  jumpAdvance: (targetIndex: number, opts?: { skipStages?: boolean }) => AdvanceResult;
  rollback: (index: number) => void;
  peek: (stageId: string) => void;
  resetView: () => void;
  setView: (index: number) => void;

  confirmArtifact: (stageId: string) => void;
  isConfirmed: (stageId: string) => boolean;
  clearConfirmsAfter: (afterIndex: number) => void;
  syncArtifact: (index?: number, opts?: { quiet?: boolean }) => Promise<boolean>;
  upsertArtifact: (artifact: StageArtifact) => void;
  fetchSuggestStep: () => Promise<SuggestStepData | null>;
  isSuggestStepReady: () => boolean;
  suggestStepTargetIndex: () => number | undefined;
  isSkipped: (stageId: string) => boolean;
  markStageSkipped: (stageId: string) => void;
  isSuggestStepDone: () => boolean;
  /** [DYNAMIC-HARNESS] 按 stageId 切换阶段（校验存在性后委托 jumpAdvance） */
  switchStageById: (stageId: string) => AdvanceResult;
};

type FetchArtifactFn = (index: number) => Promise<StageArtifact | undefined>;
type FetchSuggestStepFn = () => Promise<SuggestStepData | null>;

export function createStageMachine(input: {
  stages: () => readonly StageConfig[];
  flow: RequirementFlowConfig;
  fetchArtifact: FetchArtifactFn;
  fetchSuggestStep: FetchSuggestStepFn;
  /** 兼容旧 Boss 流程：模版侧栏「确定使用」为 true 时跳过 layout-generation */
  getTemplateAccepted?: () => boolean | undefined;
  /** Solid 版为 @/ui/components/toast 的 showToast；React 侧由 UI 层注入（sonner） */
  onToast?: (toast: StageToast) => void;
}): StageMachine {
  const stageList = input.stages;
  const store = createStore<StageMachineState>(() => ({
    workingIndex: 0,
    viewIndex: 0,
    artifacts: [],
    syncing: false,
    suggestStep: null,
    skippedStageIds: [],
  }));
  const setState = store.setState.bind(store);
  const state = () => store.getState();

  const snapshot = (): StageSnapshot => ({
    index: state().workingIndex,
    stages: stageList(),
    flow: input.flow,
    artifacts: state().artifacts,
  });

  const workingStage = () => stageList()[state().workingIndex];
  const viewStage = () => stageList()[state().viewIndex];
  const workingStageId = () => workingStage()?.id;
  const viewStageId = () => viewStage()?.id;
  const isPeeking = () => state().viewIndex !== state().workingIndex;
  const isLastStage = () => isLastStageIndex(state().workingIndex, stageList());

  const canAdvance = (opts: {
    isConfirmed: (stageId: string) => boolean;
  }): boolean =>
    canAdvanceNow(snapshot(), {
      isConfirmed: opts.isConfirmed,
    });

  const advanceHint = (opts: {
    working: boolean;
    isConfirmed: (stageId: string) => boolean;
  }): string | undefined => {
    const snap = snapshot();
    const stage = stageList()[snap.index];
    if (!stage || opts.working || !canGoForward(snap)) return undefined;
    if (!stageHasArtifact(stage)) return undefined;
    const art = artifactForStage(snap.artifacts, stage.id);
    if (!art?.content.trim()) return undefined;
    if (!opts.isConfirmed(stage.id))
      return "请查看右侧产物并点击「确认并进入下一阶段」";
    return undefined;
  };

  const hydrate = (index: number) => {
    const list = stageList();
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    setState({
      workingIndex: clamped,
      viewIndex: clamped,
      suggestStep: null,
      skippedStageIds: [],
    });
  };

  const tryAdvance = (): AdvanceResult => {
    const snap = snapshot();
    if (!canGoForward(snap)) return { advanced: false };
    const nextIndex = resolveNextStageIndex(
      snap,
      { templateAccepted: input.getTemplateAccepted?.() },
    );
    if (nextIndex <= state().workingIndex) return { advanced: false };
    const plan = planAdvanceToIndex(snap, nextIndex);
    if (!plan) return { advanced: false };
    setState({ workingIndex: nextIndex, viewIndex: nextIndex, suggestStep: null });
    return { advanced: true, plan };
  };

  const jumpAdvance = (
    targetIndex: number,
    opts?: { skipStages?: boolean },
  ): AdvanceResult => {
    if (targetIndex === state().workingIndex) return { advanced: false };
    const list = stageList();
    if (targetIndex < 0 || targetIndex >= list.length) return { advanced: false };
    const prev = list[state().workingIndex];
    const next = list[targetIndex];
    if (!prev || !next) return { advanced: false };
    const isBackward = targetIndex < state().workingIndex;
    if (isBackward) {
      clearConfirmsAfter(targetIndex);
    }
    const shouldSkip = opts?.skipStages !== false;
    const newSkipped = isBackward
      ? state().skippedStageIds.filter((id) => {
          const idx = list.findIndex((s) => s.id === id);
          return idx < targetIndex;
        })
      : shouldSkip
        ? [
            ...state().skippedStageIds,
            ...list
              .slice(state().workingIndex + 1, targetIndex)
              .map((s) => s.id)
              .filter((id) => !state().skippedStageIds.includes(id)),
          ]
        : state().skippedStageIds;
    const suggestStepReason = state().suggestStep?.reason;
    setState({
      workingIndex: targetIndex,
      viewIndex: targetIndex,
      suggestStep: null,
      skippedStageIds: newSkipped,
    });
    const enterText = isBackward
      ? suggestStepReason !== undefined
        ? buildStageEnterPrompt(next, prev, input.flow, {
            template: next.backwardEnterPrompt,
            reason: suggestStepReason,
          })
        : ""
      : buildStageEnterPrompt(next, prev, input.flow);
    return {
      advanced: true,
      plan: {
        prev,
        next,
        enterText,
      },
    };
  };

  const rollback = (index: number) => {
    if (index >= state().workingIndex) return;
    const clamped = Math.max(0, Math.min(index, state().workingIndex - 1));
    const kept = state().skippedStageIds.filter((id) => {
      const idx = stageList().findIndex((s) => s.id === id);
      return idx < clamped;
    });
    setState({ workingIndex: clamped, viewIndex: clamped, suggestStep: null, skippedStageIds: kept });
    clearConfirmsAfter(clamped);
  };

  const peek = (stageId: string) => {
    const index = stageList().findIndex((s) => s.id === stageId);
    if (index !== -1) setState({ viewIndex: index });
  };

  const resetView = () => setState({ viewIndex: state().workingIndex });

  const setView = (index: number) => {
    const clamped = Math.max(0, Math.min(index, state().workingIndex));
    setState({ viewIndex: clamped });
  };

  const setArtifact = (artifact: StageArtifact) => {
    const artifacts = state().artifacts;
    const existing = artifacts.findIndex((a) => a.stage === artifact.stage);
    setState({
      artifacts:
        existing !== -1
          ? artifacts.map((a, i) => (i === existing ? artifact : a))
          : [...artifacts, artifact],
    });
  };

  const confirmArtifact = (stageId: string) => {
    const art = state().artifacts.find((a) => a.stage === stageId);
    if (!art?.content.trim()) return;
    setArtifact({ ...art, confirmedAt: new Date().toISOString() });
  };

  const isConfirmed = (stageId: string) =>
    !!state().artifacts.find((a) => a.stage === stageId)?.confirmedAt;

  const clearConfirmsAfter = (afterIndex: number) => {
    const list = stageList();
    setState({
      artifacts: state().artifacts.map((art) => {
        const idx = list.findIndex((st) => st.id === art.stage);
        if (idx > afterIndex && art.confirmedAt) {
          const { confirmedAt: _ignored, ...rest } = art;
          return rest as StageArtifact;
        }
        return art;
      }),
    });
  };

  const syncArtifact = async (
    index?: number,
    opts?: { quiet?: boolean },
  ): Promise<boolean> => {
    const idx = index ?? state().workingIndex;
    const stage = stageList()[idx];
    if (!stage?.artifactPath?.trim()) return false;
    setState({ syncing: true });
    try {
      const result = await input.fetchArtifact(idx);
      if (result === undefined) {
        if (!opts?.quiet) {
          input.onToast?.({
            variant: "default",
            title: "未读取到产物",
            description: stage.artifactPath,
          });
        }
        return false;
      }
      setArtifact(result);
      if (stage.completion?.autoDetectSuggestStep) {
        await fetchSuggestStep().catch(() => setState({ suggestStep: null }));
      }
      return true;
    } finally {
      setState({ syncing: false });
    }
  };

  const fetchSuggestStep = async (): Promise<SuggestStepData | null> => {
    const data = await input.fetchSuggestStep();
    setState({ suggestStep: data });
    return data;
  };

  const isSuggestStepReady = (): boolean => {
    const stage = stageList()[state().workingIndex];
    if (!stage) return false;
    return isSuggestStepValid(state().suggestStep, stage.agent, stageList(), state().workingIndex);
  };

  const suggestStepTargetIndex = (): number | undefined => {
    const data = state().suggestStep;
    if (!data) return undefined;
    const target = resolveSuggestStepStageIndex(stageList(), data.suggestStep);
    if (target < 0) return undefined;
    return target;
  };

  const isSkipped = (stageId: string): boolean =>
    state().skippedStageIds.includes(stageId);

  const markStageSkipped = (stageId: string) => {
    const id = stageId.trim();
    if (!id || state().skippedStageIds.includes(id)) return;
    setState({ skippedStageIds: [...state().skippedStageIds, id] });
  };

  const checkSuggestStepDone = (): boolean =>
    isSuggestStepDone(state().suggestStep);

  const switchStageById = (stageId: string): AdvanceResult => {
    const list = stageList();
    if (!canSwitchToStage(stageId, list)) return { advanced: false };
    const targetIndex = list.findIndex((s) => s.id === stageId);
    if (targetIndex < 0) return { advanced: false };
    return jumpAdvance(targetIndex);
  };

  return {
    store,
    getState: state,
    setState,
    use: <T,>(selector: (s: StageMachineState) => T) => useStore(store, selector),

    snapshot,
    workingStage,
    viewStage,
    workingStageId,
    viewStageId,
    isPeeking,
    isLastStage,
    canAdvance,
    advanceHint,
    hydrate,
    tryAdvance,
    jumpAdvance,
    rollback,
    peek,
    resetView,
    setView,
    confirmArtifact,
    isConfirmed,
    isSkipped,
    markStageSkipped,
    isSuggestStepDone: checkSuggestStepDone,
    clearConfirmsAfter,
    syncArtifact,
    upsertArtifact: setArtifact,
    fetchSuggestStep,
    isSuggestStepReady,
    suggestStepTargetIndex,
    switchStageById,
  };
}
