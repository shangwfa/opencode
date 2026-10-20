/**
 * 工作流通用工具函数。
 *
 * 所有不依赖于具体工作流配置的纯函数集中于此，
 * 可被任何 flow 配置和运行时模块使用。
 */

import type { StageConfig } from "./config";

export function stageHasArtifact(stage: StageConfig | undefined) {
  return !!stage?.artifactPath?.trim();
}

export function stageHasVcsDiff(stage: StageConfig | undefined) {
  return !!stage?.completion?.vcsDiff;
}

export function stageHasCommitButton(stage: StageConfig | undefined) {
  return !!stage?.commitButton;
}

export function stageCompletionPrompt(stage: StageConfig | undefined) {
  return stage?.completion?.completionPrompt?.trim() ?? "";
}

/** 产物侧栏标题：面向业务用户，不展示沙箱路径 */
export function artifactPanelHeading(stage: StageConfig | undefined) {
  if (!stage) return { title: "阶段产物", hint: "" };
  return {
    title: stage.label,
    hint: stage.description?.trim() ?? "",
  };
}

export type StageSummaryItem = {
  stageId: string;
  label: string;
  confirmed: boolean;
};

export function stageSummaryCards(
  stages: readonly StageConfig[],
  viewIndex: number,
  isConfirmed: (stageId: string) => boolean,
): StageSummaryItem[] {
  if (viewIndex === 0) return [];
  return stages.slice(0, viewIndex).map((s) => ({
    stageId: s.id,
    label: s.label,
    confirmed: isConfirmed(s.id),
  }));
}

export type StageEmptyHint =
  | { type: "thinking"; label: string; stageId: string }
  | { type: "prompt"; text: string; stageId: string };

export function stageEmptyHint(
  stages: readonly StageConfig[],
  viewIndex: number,
  working: boolean,
): StageEmptyHint | undefined {
  const stage = stages[viewIndex];
  if (!stage) return undefined;
  if (stage.enterPrompt || working) {
    return { type: "thinking", label: stage.label, stageId: stage.id };
  }
  if (stage.emptyPrompt?.trim()) {
    return { type: "prompt", text: stage.emptyPrompt, stageId: stage.id };
  }
  return undefined;
}

export type RemoteWorkingHint = {
  label: string;
  stageId: string;
};

export function remoteWorkingHint(
  stages: readonly StageConfig[],
  workingIndex: number,
): RemoteWorkingHint | undefined {
  const stage = stages[workingIndex];
  if (!stage) return undefined;
  return { label: stage.label, stageId: stage.id };
}

/** artifactPath 中 reqId 占位符 */
export const REQ_ID_PLACEHOLDER = "{reqId}";

/** 将模板 artifactPath 中的 `{reqId}` 替换为实际需求 id */
export function resolveArtifactPath(template: string, reqId: string): string {
  const id = reqId.trim();
  if (!id) return template;
  return template.replaceAll(REQ_ID_PLACEHOLDER, id);
}
