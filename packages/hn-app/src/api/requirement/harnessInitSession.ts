import {
  errorFromJson,
  requirementApiBaseUrl,
  requirementApiFetch,
} from "./client";

export type HarnessMountedAgent = {
  name: string;
  mode: "primary" | "subagent" | "all";
  promptLength?: number;
};

export type HarnessInitSessionResult = {
  sessionId: string;
  reqId: string;
  /** 旧版同步返回挂载的 agent 列表；改造后后台异步注入，此字段可能为空 */
  mounted?: HarnessMountedAgent[];
  /** 后台异步 job id，可用于轮询 job 状态 */
  job_id?: string;
  /** 异步 job 初始状态（queued / running / success / failed） */
  job_status?: string;
  appId?: string;
  pvcMode?: string;
  workspace?: {
    cloned: boolean;
    branch: string;
    directory: string;
    repoPath?: string;
  };
};

export type HarnessInitSessionSyncWarning = {
  type: "sync_session_partial_failed";
  message: string;
  errorsCount: number;
  errors?: unknown[];
};

export type HarnessInitSessionJob =
  | {
      job_id: string;
      status: "queued" | "running";
    }
  | {
      job_id: string;
      status: "failed";
      error: string;
    }
  | {
      job_id: string;
      status: "success";
      result?: {
        syncWarning?: HarnessInitSessionSyncWarning;
        [key: string]: unknown;
      };
    };

function envFlag(name: string) {
  const raw = (import.meta.env[name] as string | undefined)
    ?.trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/** 测试环境在 .env 显式设置 VITE_REQUIREMENT_HARNESS_INIT_SESSION=1 */
export function harnessInitSessionEnabled() {
  return (
    envFlag("VITE_REQUIREMENT_HARNESS_INIT_SESSION") &&
    !!requirementApiBaseUrl()
  );
}

function parseInitSessionBody(data: unknown): HarnessInitSessionResult {
  const root = data as {
    sessionId?: string;
    reqId?: string;
    mounted?: HarnessMountedAgent[];
    job_id?: string;
    status?: string;
    success?: boolean;
    code?: number;
    data?: HarnessInitSessionResult;
    error?: string;
  };
  if (root.success === false || (root.code != null && root.code !== 200)) {
    throw new Error(errorFromJson(data, "创建会话失败"));
  }
  const body = root.data ?? root;
  const sessionId =
    typeof body.sessionId === "string" ? body.sessionId : undefined;
  const reqId = typeof body.reqId === "string" ? body.reqId : undefined;
  if (!sessionId) throw new Error("创建会话失败：未返回 sessionId");
  if (!reqId) throw new Error("创建会话失败：未返回 reqId");
  const mounted = Array.isArray(body.mounted) ? body.mounted : [];
  const job_id =
    typeof root.job_id === "string"
      ? root.job_id
      : typeof (root.data as { job_id?: string } | undefined)?.job_id === "string"
        ? (root.data as { job_id: string }).job_id
        : undefined;
  const job_status =
    typeof root.status === "string"
      ? root.status
      : undefined;
  return { sessionId, reqId, mounted, job_id, job_status };
}

function normalizeSyncWarning(
  value: unknown,
): HarnessInitSessionSyncWarning | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const record = value as Record<string, unknown>;
  if (record.type !== "sync_session_partial_failed") return;
  const errorsCount =
    typeof record.errorsCount === "number" && Number.isFinite(record.errorsCount)
      ? record.errorsCount
      : 0;
  if (errorsCount <= 0) return;

  return {
    type: "sync_session_partial_failed",
    message:
      typeof record.message === "string" && record.message.trim()
        ? record.message.trim()
        : "会话已创建，但部分工作文件同步失败",
    errorsCount,
    errors: Array.isArray(record.errors) ? record.errors : undefined,
  };
}

function parseInitSessionJobBody(data: unknown): HarnessInitSessionJob {
  const root = data as {
    success?: boolean;
    code?: number;
    data?: unknown;
  };
  if (root.success === false || (root.code != null && root.code !== 200)) {
    throw new Error(errorFromJson(data, "加载初始化任务状态失败"));
  }

  const body = (root.data ?? root) as {
    job_id?: unknown;
    status?: unknown;
    error?: unknown;
    result?: unknown;
  };
  const jobId = typeof body.job_id === "string" ? body.job_id : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!jobId) throw new Error("加载初始化任务状态失败：未返回 job_id");

  if (status === "queued" || status === "running") {
    return { job_id: jobId, status };
  }
  if (status === "failed") {
    return {
      job_id: jobId,
      status,
      error:
        typeof body.error === "string" && body.error.trim()
          ? body.error.trim()
          : "初始化任务失败",
    };
  }
  if (status === "success") {
    const result =
      body.result && typeof body.result === "object" && !Array.isArray(body.result)
        ? { ...(body.result as Record<string, unknown>) }
        : undefined;
    const syncWarning = normalizeSyncWarning(result?.syncWarning);
    const resultForClient = result ? { ...result } : undefined;
    if (resultForClient) delete resultForClient.syncWarning;
    return {
      job_id: jobId,
      status,
      result: result
        ? {
            ...resultForClient,
            ...(syncWarning ? { syncWarning } : {}),
          }
        : undefined,
    };
  }

  throw new Error("加载初始化任务状态失败：状态非法");
}

export async function postHarnessInitSession(input: {
  agents: readonly string[];
  title: string;
  target_gitlab: string;
  base_branch: string;
  creator_uuid: string;
  creator_nick_name: string;
  workflow_id?: string;
  /** OpenCode 源 session ID，用于派生摘要上下文 */
  summaryFrom?: string;
  /** 创建新 session 后同步源 session 的工作文件 */
  syncSession?: {
    sourceSessionId?: string;
    syncDiffFiles?: boolean;
    syncArtifacts?: boolean;
  };
  /** 为 true 时让 harness 直接 checkout base_branch 作为最终工作分支 */
  useExistingBranch?: boolean;
  agentSource?: "bundle" | "registry";
  sandbox?: {
    persistMode?: "snapshot";
    /** 沙箱镜像；留空使用系统默认镜像 */
    image?: string;
  };
}): Promise<HarnessInitSessionResult> {
  const base = requirementApiBaseUrl();
  if (!base) throw new Error("未配置 VITE_REQUIREMENT_API_BASE");
  const agents = input.agents;
  const syncSourceSessionId = input.syncSession?.sourceSessionId?.trim();

  const res = await requirementApiFetch(`${base}/opencode/init-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agents: [...agents],
      title: input.title.trim(),
      target_gitlab: input.target_gitlab.trim(),
      base_branch: input.base_branch.trim(),
      creator_uuid: input.creator_uuid.trim(),
      creator_nick_name: input.creator_nick_name.trim(),
      ...(input.workflow_id ? { workflow_id: input.workflow_id.trim() } : {}),
      ...(input.summaryFrom?.trim()
        ? { summaryFrom: input.summaryFrom.trim() }
        : {}),
      ...(syncSourceSessionId
        ? {
            syncSession: {
              sourceSessionId: syncSourceSessionId,
              syncDiffFiles: true,
              syncArtifacts: input.syncSession?.syncArtifacts ?? true,
            },
          }
        : {}),
      ...(input.useExistingBranch ? { useExistingBranch: true } : {}),
      ...(input.agentSource ? { agentSource: input.agentSource } : {}),
      ...(input.sandbox?.persistMode || input.sandbox?.image
        ? {
            sandbox: {
              ...(input.sandbox?.persistMode
                ? { persistMode: input.sandbox.persistMode }
                : {}),
              ...(input.sandbox?.image ? { image: input.sandbox.image } : {}),
            },
          }
        : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    throw new Error(errorFromJson(data, "创建会话失败"));
  }
  return parseInitSessionBody(data);
}

export async function fetchHarnessInitSessionJobBySession(
  sessionId: string,
): Promise<HarnessInitSessionJob | null> {
  const sid = sessionId.trim();
  if (!sid) return null;
  const base = requirementApiBaseUrl();
  if (!base) throw new Error("未配置 VITE_REQUIREMENT_API_BASE");

  const res = await requirementApiFetch(
    `${base}/opencode/init-session/jobs/by-session/${encodeURIComponent(sid)}`,
  );
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(errorFromJson(data, "加载初始化任务状态失败"));
  }
  return parseInitSessionJobBody(data);
}
