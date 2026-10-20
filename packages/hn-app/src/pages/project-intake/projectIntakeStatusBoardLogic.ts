import type {
  ProjectIntakeConfirmJobChild,
  ProjectIntakeConfirmJobChildStatus,
  ProjectIntakeConfirmJobPollResponse,
  ProjectIntakeConfirmJobStatus,
} from "@/api/project-intake/confirmJob";

export type ProjectIntakeStepId = "queued" | "preparing" | "success";

export type ProjectIntakeStepState = "todo" | "current" | "done" | "failed";

export type ProjectIntakeStepView = {
  id: ProjectIntakeStepId;
  label: string;
  state: ProjectIntakeStepState;
};

const childStatusOrder: Record<ProjectIntakeConfirmJobChildStatus, number> = {
  queued: 0,
  preparing: 1,
  success: 2,
  failed: 2,
};

export const projectIntakeStepLabels: Record<ProjectIntakeStepId, string> = {
  queued: "等待中",
  preparing: "初始化",
  success: "完成",
};

export const projectIntakeJobStatusLabel: Record<
  ProjectIntakeConfirmJobStatus,
  string
> = {
  pending_confirm: "等待确认",
  queued: "等待执行",
  running: "创建中",
  success: "已完成",
  failed: "创建失败",
};

export const projectIntakeChildStatusLabel: Record<
  ProjectIntakeConfirmJobChildStatus,
  string
> = {
  queued: "等待中",
  preparing: "初始化中",
  success: "已完成",
  failed: "创建失败",
};

export function isProjectIntakeJobTerminal(
  status: ProjectIntakeConfirmJobStatus,
) {
  return status === "success" || status === "failed";
}

export function shouldPollProjectIntakeJob(
  job: ProjectIntakeConfirmJobPollResponse | null,
  error: string,
) {
  if (error.trim()) return false;
  if (!job) return true;
  return !isProjectIntakeJobTerminal(job.status);
}

export function projectIntakeChildSteps(
  status: ProjectIntakeConfirmJobChildStatus,
): ProjectIntakeStepView[] {
  const currentIndex = childStatusOrder[status];
  const failed = status === "failed";
  return (
    ["queued", "preparing", "success"] as const
  ).map((id, index) => {
    let state: ProjectIntakeStepState = "todo";
    if (failed && index === currentIndex) state = "failed";
    else if (index < currentIndex || status === "success") state = "done";
    else if (index === currentIndex) state = "current";
    return { id, label: projectIntakeStepLabels[id], state };
  });
}

export function projectIntakeJobStats(
  job: ProjectIntakeConfirmJobPollResponse | null,
) {
  const children = job?.children ?? [];
  const success = children.filter((child) => child.status === "success").length;
  const failed = children.filter((child) => child.status === "failed").length;
  const pending = children.length - success - failed;
  return {
    total: children.length,
    success,
    failed,
    pending,
  };
}

export function projectIntakeChildKey(child: ProjectIntakeConfirmJobChild) {
  return `${child.app_id}:${child.item_seq}`;
}
