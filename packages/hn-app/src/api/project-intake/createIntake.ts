import {
  errorFromJson,
  requirementApiBase,
  requirementApiFetch,
} from "@/api/requirement/client";

export type CreateProjectIntakeBody = {
  title?: string;
  appId?: string;
  parser_agent_name?: string;
  parser_agent_source?: string;
  intake_message?: string;
  creator_feishu_user_id?: string;
  creator_uuid?: string;
  creator_nick_name?: string;
  source?: string;
  source_meta?: Record<string, unknown>;
  model?: { providerID: string; modelID: string };
};

export type CreateProjectIntakeResponse = {
  masterSessionId: string;
  groupId: string;
  job_id: string;
  jobStatus: string;
  parserAgent: string;
  parserMounted: Array<{ name: string; mode: string; promptLength: number; source: string }>;
  confirmUrl: string;
};

function readString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}

export function createProjectIntakeUrl(): string {
  const path = "/opencode/project-intake";
  return requirementApiBase ? `${requirementApiBase}${path}` : path;
}

export function normalizeCreateProjectIntakeResponse(
  raw: unknown,
): CreateProjectIntakeResponse {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("创建项目录入响应格式无效");
  }
  const input = raw as Record<string, unknown>;
  const masterSessionId = readString(input, "masterSessionId");
  if (!masterSessionId) {
    throw new Error("创建项目录入响应缺少 masterSessionId");
  }
  const parserMountedRaw = input.parserMounted;
  const parserMounted = Array.isArray(parserMountedRaw)
    ? parserMountedRaw.map((item) => {
        const obj = (item ?? {}) as Record<string, unknown>;
        return {
          name: readString(obj, "name"),
          mode: readString(obj, "mode"),
          promptLength: Number(obj.promptLength ?? 0),
          source: readString(obj, "source"),
        };
      })
    : [];
  return {
    masterSessionId,
    groupId: readString(input, "groupId") || masterSessionId,
    job_id: readString(input, "job_id") || masterSessionId,
    jobStatus: readString(input, "jobStatus") || "pending_confirm",
    parserAgent: readString(input, "parserAgent"),
    parserMounted,
    confirmUrl: readString(input, "confirmUrl"),
  };
}

export async function createProjectIntake(
  body: CreateProjectIntakeBody,
): Promise<CreateProjectIntakeResponse> {
  const res = await requirementApiFetch(createProjectIntakeUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    throw new Error(errorFromJson(data, "创建项目录入失败"));
  }
  return normalizeCreateProjectIntakeResponse(data);
}

export function projectIntakeJobDeleteUrl(masterSessionId: string): string {
  const path = `/opencode/project-intake/jobs/${encodeURIComponent(masterSessionId)}`;
  return requirementApiBase ? `${requirementApiBase}${path}` : path;
}

export async function deleteProjectIntakeJob(
  masterSessionId: string,
): Promise<void> {
  const res = await requirementApiFetch(projectIntakeJobDeleteUrl(masterSessionId), {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const data = (await res.json().catch(() => ({}))) as unknown;
    throw new Error(errorFromJson(data, "删除项目录入失败"));
  }
}
