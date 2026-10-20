import type { Message } from "@/types/opencode";
import type {
  RequirementFlowConfig,
  StageArtifact,
  StageConfig,
  StageSkipRule,
} from "./flows/config";
import { stageHasArtifact } from "./flows/utils";

type StageEnterVars = {
  stageLabel: string;
  artifactPath: string;
  prevLabel: string;
  prevArtifactPath: string;
  projectDir: string;
  suggestStepReason: string;
};

/** 渲染 enterPrompt / backwardEnterPrompt 模板 */
export function buildStageEnterPrompt(
  next: StageConfig,
  prev: StageConfig | undefined,
  flow: RequirementFlowConfig,
  opts?: { template?: string; reason?: string },
): string {
  const template = (opts?.template ?? next.enterPrompt)?.trim();
  if (!template) return "";
  const vars: StageEnterVars = {
    stageLabel: next.label,
    artifactPath: next.artifactPath?.trim() ?? "",
    prevLabel: prev?.label ?? "",
    prevArtifactPath: prev?.artifactPath?.trim() ?? "",
    projectDir: flow.projectDir,
    suggestStepReason: opts?.reason ?? "",
  };
  return template.replace(/\{(\w+)\}/g, (_, key: string) => {
    const k = key as keyof StageEnterVars;
    return vars[k] ?? "";
  });
}

/** 阶段编排只读快照：index + 流程配置 + 产物 */
export type StageSnapshot = {
  index: number;
  stages: readonly StageConfig[];
  flow: RequirementFlowConfig;
  artifacts: readonly StageArtifact[];
};

export function stageAt(
  snapshot: StageSnapshot,
  index = snapshot.index,
): StageConfig | undefined {
  return snapshot.stages[index];
}

export function isLastStageIndex(
  index: number,
  stages: readonly StageConfig[],
): boolean {
  return index >= stages.length - 1;
}

export function canGoForward(snapshot: StageSnapshot): boolean {
  return !isLastStageIndex(snapshot.index, snapshot.stages);
}

export function stageAgents(stages: readonly StageConfig[]) {
  return new Set(stages.map((s) => s.agent));
}

export function indexFromStageId(
  stages: readonly StageConfig[],
  stageId: string,
) {
  const index = stages.findIndex((s) => s.id === stageId.trim());
  return index === -1 ? 0 : index;
}

/** 从消息历史推断 working 阶段（仅 stage agent；跳过 build 等） */
export function restoreStageIndex(
  messages: readonly Message[],
  stages: readonly StageConfig[],
): number {
  const agents = stageAgents(stages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    if (item.role !== "user" || !item.agent) continue;
    if (!agents.has(item.agent)) continue;
    const index = stages.findIndex((stage) => stage.agent === item.agent);
    if (index !== -1) return index;
  }
  return 0;
}

export function artifactForStage(
  artifacts: readonly StageArtifact[],
  stageId: string,
) {
  return artifacts.find((a) => a.stage === stageId);
}

export type SuggestStepStatus =
  | "ready"
  | "blocked"
  | "done"
  | "pending"
  | "dismissed"
  | "completed";

export type SuggestStepData = {
  currentAgent: string;
  suggestStep: string;
  status: SuggestStepStatus;
  reason: string;
  commitMessage?: string;
  updatedAt: string;
  /** [DYNAMIC-HARNESS] 建议唯一标识，用于 dismiss 去重；缺失时前端按 updatedAt+currentAgent 派生 */
  id?: string;
  currentStageId?: string;
  /** [DYNAMIC-HARNESS] 建议跳转目标 stageId（优先于 suggestStep agent 名） */
  suggestedStageId?: string;
  suggestedAgent?: string;
  suggestedAction?: "switch_stage" | "continue_current_stage";
  /** [DYNAMIC-HARNESS v2] status=blocked 时必填：为什么走不下去，供 orchestrator 重规划 */
  blockReason?: string;
  title?: string;
  summary?: string;
  confidence?: number;
  createdAt?: string;
};

export type StageAdvancePlan = {
  prev: StageConfig;
  next: StageConfig;
  enterText: string;
};

export type SkipConditionContext = {
  /** 模版选择侧栏「确定使用」为 true */
  templateAccepted?: boolean;
};

export type ResolveWorkingInput = {
  messages: readonly Message[];
  stages: readonly StageConfig[];
  /** 模版侧栏「确定使用」为 true 时调整 workingIndex */
  templateAccepted?: boolean;
};

/** 根据 skipRules 修正从消息历史推断的阶段索引 */
export function applySkippedStageIndex(
  index: number,
  stages: readonly StageConfig[],
  ctx?: SkipConditionContext,
): number {
  let current = index;
  const max = stages.length - 1;

  while (current < max) {
    let skipped = false;
    for (let i = 0; i < current && !skipped; i++) {
      const stage = stages[i];
      if (!stage?.skipRules) continue;
      for (const rule of stage.skipRules) {
        if (!evaluateSkipRule(rule, ctx)) continue;
        const skipTargetIndex = stages.findIndex((s) => s.id === rule.skipStageId);
        if (skipTargetIndex === current) {
          current++;
          skipped = true;
          break;
        }
      }
    }
    if (!skipped) break;
  }

  return current;
}

export function inferSkippedStageIds(
  messages: readonly Message[],
  stages: readonly StageConfig[],
): string[] {
  const agents = stageAgents(stages);
  const seenAgents = new Set<string>();
  for (let i = messages.length - 1; i >= 0; i--) {
    const item = messages[i];
    if (item.role !== "user" || !item.agent) continue;
    if (!agents.has(item.agent)) continue;
    seenAgents.add(item.agent);
  }
  const workingIndex = messages.length
    ? restoreStageIndex(messages, stages)
    : 0;
  const skipped: string[] = [];
  for (let i = 0; i < workingIndex && i < stages.length; i++) {
    if (!seenAgents.has(stages[i].agent)) {
      skipped.push(stages[i].id);
    }
  }
  return skipped;
}

export function resolveWorkingIndex(input: ResolveWorkingInput): number {
  const index = input.messages.length
    ? restoreStageIndex(input.messages, input.stages)
    : 0;
  return applySkippedStageIndex(
    index,
    input.stages,
    input.templateAccepted !== undefined
      ? { templateAccepted: input.templateAccepted }
      : undefined,
  );
}

/** 评估跳过规则是否生效 */
function evaluateSkipRule(
  rule: StageSkipRule,
  ctx?: SkipConditionContext,
): boolean {
  switch (rule.condition) {
    case "always":
      return true;
    case "templateAccepted":
      return ctx?.templateAccepted === true;
    case "custom":
      return false;
    default:
      return false;
  }
}

/** 从当前阶段推进到的目标 index（支持配置驱动的条件跳过） */
export function resolveNextStageIndex(
  snapshot: StageSnapshot,
  ctx?: SkipConditionContext,
): number {
  const max = snapshot.stages.length - 1;
  let next = Math.min(snapshot.index + 1, max);
  const current = snapshot.stages[snapshot.index];

  if (current?.skipRules) {
    for (const rule of current.skipRules) {
      if (!evaluateSkipRule(rule, ctx)) continue;
      const skipIndex = snapshot.stages.findIndex((s) => s.id === rule.skipStageId);
      if (skipIndex === next && skipIndex >= 0) {
        next = Math.min(next + 1, max);
      }
    }
  }

  return next;
}

/** 推进到指定 index：返回 prev/next 与 enterPrompt 文案 */
export function planAdvanceToIndex(
  snapshot: StageSnapshot,
  nextIndex: number,
): StageAdvancePlan | undefined {
  if (nextIndex <= snapshot.index || nextIndex >= snapshot.stages.length) {
    return undefined;
  }
  const prev = snapshot.stages[snapshot.index];
  const next = snapshot.stages[nextIndex];
  if (!prev || !next) return undefined;
  return {
    prev,
    next,
    enterText: buildStageEnterPrompt(next, prev, snapshot.flow),
  };
}

/** 推进到下一阶段：返回 prev/next 与 enterPrompt 文案；无法推进时 undefined */
export function planAdvance(
  snapshot: StageSnapshot,
  ctx?: SkipConditionContext,
): StageAdvancePlan | undefined {
  if (!canGoForward(snapshot)) return undefined;
  const nextIndex = resolveNextStageIndex(snapshot, ctx);
  if (nextIndex <= snapshot.index) return undefined;
  return planAdvanceToIndex(snapshot, nextIndex);
}

export function canAdvanceNow(
  snapshot: StageSnapshot,
  opts: {
    isConfirmed: (stageId: string) => boolean;
    artifactContent?: string;
    orchestratorComplete?: (stageId: string) => boolean;
  },
): boolean {
  if (!canGoForward(snapshot)) return false;
  const stage = stageAt(snapshot);
  if (!stage) return false;

  if (stage.stageKind === "automated") {
    return opts.orchestratorComplete?.(stage.id) ?? false;
  }

  if (stage.stageKind === "confirm" || !stageHasArtifact(stage)) {
    if (stage.stageKind === "confirm") {
      const content =
        opts.artifactContent ??
        artifactForStage(snapshot.artifacts, stage.id)?.content;
      if (!content?.trim()) {
        return opts.orchestratorComplete?.(stage.id) ?? false;
      }
      return opts.isConfirmed(stage.id);
    }
    return true;
  }

  const content =
    opts.artifactContent ??
    artifactForStage(snapshot.artifacts, stage.id)?.content;
  if (!content?.trim()) return false;
  return opts.isConfirmed(stage.id);
}

export function advanceHintText(
  snapshot: StageSnapshot,
  opts: {
    working: boolean;
    isConfirmed: (stageId: string) => boolean;
  },
): string | undefined {
  const stage = stageAt(snapshot);
  if (!stage || opts.working || !canGoForward(snapshot)) return undefined;
  if (!stageHasArtifact(stage)) return undefined;
  const art = artifactForStage(snapshot.artifacts, stage.id);
  if (!art?.content.trim()) return undefined;
  if (!opts.isConfirmed(stage.id))
    return "请查看右侧产物并点击「确认并进入下一阶段」";
  return undefined;
}

export function isSuggestStepValid(
  suggestStep: SuggestStepData | null,
  currentAgent: string,
  stages: readonly StageConfig[],
  currentIndex: number,
): suggestStep is SuggestStepData {
  if (!suggestStep) return false;
  if (suggestStep.currentAgent !== currentAgent) return false;
  // pending / dismissed / blocked 均视为"不可跳转"
  if (
    suggestStep.status === "pending" ||
    suggestStep.status === "dismissed" ||
    suggestStep.status === "blocked"
  ) {
    return false;
  }
  const targetIndex = resolveSuggestStepStageIndex(
    stages,
    suggestStep.suggestStep,
  );
  return targetIndex >= 0 && targetIndex !== currentIndex;
}

/**
 * [DYNAMIC-HARNESS] 校验 stageId 是否存在于 flow stages 中。
 * 文档 §12：前端只允许切到 flow 中存在的 stageId。
 */
export function canSwitchToStage(
  stageId: string,
  stages: readonly StageConfig[],
): boolean {
  return stages.some((stage) => stage.id === stageId);
}

export function resolveSuggestStepStageIndex(
  stages: readonly StageConfig[],
  suggestStep: string,
): number {
  const target = suggestStep.trim();
  if (!target) return -1;
  return stages.findIndex((s) => s.agent.includes(target));
}

export function isSuggestStepDone(
  suggestStep: SuggestStepData | null,
): boolean {
  if (!suggestStep) return false;
  return suggestStep.suggestStep === "done";
}
