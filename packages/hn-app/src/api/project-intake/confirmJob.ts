import {
  errorFromJson,
  requirementApiBase,
  requirementApiFetch,
} from "@/api/requirement/client";

export type ProjectIntakeConfirmJobStatus =
  | "pending_confirm"
  | "queued"
  | "running"
  | "success"
  | "failed";

export type ProjectIntakeConfirmJobChildStatus =
  | "queued"
  | "preparing"
  | "success"
  | "failed";

const LEGACY_CHILD_STATUSES_TO_PREPARING = new Set([
  "creating_session",
  "linking_group",
  "sending_message",
]);

function normalizeChildStatus(
  value: unknown,
): ProjectIntakeConfirmJobChildStatus {
  const status = typeof value === "string" ? value : "";
  if (LEGACY_CHILD_STATUSES_TO_PREPARING.has(status)) return "preparing";
  return status as ProjectIntakeConfirmJobChildStatus;
}

export type ProjectIntakeConfirmJobChild = {
  app_id: string;
  app_name?: string;
  item_seq: number;
  status: ProjectIntakeConfirmJobChildStatus;
  title: string;
  target_gitlab: string;
  base_branch: string;
  requirement_message: string;
  sessionId?: string;
  reqId?: string;
  messageSent: boolean;
  error?: string;
};

export type ProjectIntakeConfirmJobPollResponse = {
  job_id: string;
  status: ProjectIntakeConfirmJobStatus;
  children: ProjectIntakeConfirmJobChild[];
  result?: unknown;
  error?: string;
};

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

function readBoolean(input: Record<string, unknown>, key: string): boolean {
  return Boolean(input[key]);
}

function isJobStatus(value: unknown): value is ProjectIntakeConfirmJobStatus {
  return (
    value === "pending_confirm" ||
    value === "queued" ||
    value === "running" ||
    value === "success" ||
    value === "failed"
  );
}

function isChildStatus(
  value: unknown,
): value is ProjectIntakeConfirmJobChildStatus {
  if (typeof value !== "string") return false;
  if (LEGACY_CHILD_STATUSES_TO_PREPARING.has(value)) return true;
  return (
    value === "queued" ||
    value === "preparing" ||
    value === "success" ||
    value === "failed"
  );
}

export function normalizeProjectIntakeConfirmJobPollResponse(
  raw: unknown,
): ProjectIntakeConfirmJobPollResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("项目状态响应格式无效");
  }
  const input = raw as Record<string, unknown>;
  const status = input.status;
  if (!isJobStatus(status)) {
    throw new Error("项目状态响应缺少有效状态");
  }
  const childrenRaw = input.children;
  if (!Array.isArray(childrenRaw)) {
    throw new Error("项目状态响应缺少子任务列表");
  }

  return {
    job_id: readString(input, "job_id"),
    status,
    children: childrenRaw.map((childRaw, index) => {
      if (!childRaw || typeof childRaw !== "object" || Array.isArray(childRaw)) {
        throw new Error(`项目状态子任务 ${index + 1} 格式无效`);
      }
      const child = childRaw as Record<string, unknown>;
      const childStatus = child.status;
      if (!isChildStatus(childStatus)) {
        throw new Error(`项目状态子任务 ${index + 1} 缺少有效状态`);
      }
      return {
        app_id: readString(child, "app_id"),
        app_name: readString(child, "app_name") || readString(child, "app_id"),
        item_seq: Number(child.item_seq ?? index),
        status: normalizeChildStatus(childStatus),
        title: readString(child, "title"),
        target_gitlab: readString(child, "target_gitlab"),
        base_branch: readString(child, "base_branch"),
        requirement_message: readString(child, "requirement_message"),
        ...(readString(child, "sessionId")
          ? { sessionId: readString(child, "sessionId") }
          : {}),
        ...(readString(child, "reqId") ? { reqId: readString(child, "reqId") } : {}),
        messageSent: readBoolean(child, "messageSent"),
        ...(readString(child, "error") ? { error: readString(child, "error") } : {}),
      };
    }),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(readString(input, "error") ? { error: readString(input, "error") } : {}),
  };
}

export function projectIntakeConfirmJobUrl(jobId: string): string {
  const path = `/opencode/project-intake/confirm/jobs/${encodeURIComponent(
    jobId,
  )}`;
  return requirementApiBase ? `${requirementApiBase}${path}` : path;
}

export async function fetchProjectIntakeConfirmJob(
  jobId: string,
): Promise<ProjectIntakeConfirmJobPollResponse | null> {
  const res = await requirementApiFetch(projectIntakeConfirmJobUrl(jobId), {
    method: "GET",
  });
  const data = (await res.json().catch(() => ({}))) as unknown;

  if (res.status === 404) {
    return null;
  }
  if (!res.ok) {
    throw new Error(errorFromJson(data, "查询项目状态失败"));
  }
  return normalizeProjectIntakeConfirmJobPollResponse(data);
}

export function projectIntakeConfirmJobRetryUrl(jobId: string): string {
  const path = `/opencode/project-intake/confirm/jobs/${encodeURIComponent(
    jobId,
  )}/retry`;
  return requirementApiBase ? `${requirementApiBase}${path}` : path;
}

export async function retryProjectIntakeConfirmJob(
  jobId: string,
): Promise<ProjectIntakeConfirmJobPollResponse> {
  const res = await requirementApiFetch(
    projectIntakeConfirmJobRetryUrl(jobId),
    { method: "POST" },
  );
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    throw new Error(errorFromJson(data, "重试失败子任务失败"));
  }
  return normalizeProjectIntakeConfirmJobPollResponse(data);
}
