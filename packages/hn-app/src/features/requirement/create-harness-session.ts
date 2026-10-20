import {
  harnessInitSessionEnabled,
  postHarnessInitSession,
  type HarnessInitSessionResult,
} from "@/api/requirement/harnessInitSession";
import { resolveAgentRegistryNames } from "@/api/agent-registry";
import {
  DEFAULT_REQUIREMENT_FLOW,
} from "./flows";
import {
  type RequirementFlowConfig,
} from "./flows/config";

export { harnessInitSessionEnabled };
export type { HarnessInitSessionResult };

export type CreateHarnessSessionInput = {
  title: string;
  target_gitlab: string;
  base_branch: string;
  workflow_id?: string;
  flow?: RequirementFlowConfig;
  creator_uuid?: string;
  creator_nick_name?: string;
  sandboxPersistMode?: "snapshot";
  /** 沙箱镜像；留空使用系统默认镜像 */
  sandboxImage?: string;
  /** OpenCode 源 session，用于让新 session 异步注入派生摘要上下文 */
  summaryFrom?: string;
  /** 创建新 session 后同步源 session 的工作文件；syncDiffFiles 会固定为 true */
  syncSession?: {
    sourceSessionId?: string;
    syncDiffFiles?: boolean;
    syncArtifacts?: boolean;
  };
  /** 为 true 时直接使用 base_branch 作为工作分支，不再创建 feature/{reqId} */
  useExistingBranch?: boolean;
  /** 额外注入的 registry agent 引用（来自项目配置，优先为 id，兼容旧 name） */
  registryAgents?: string[];
};

export function harnessSessionRequest(
  input: CreateHarnessSessionInput,
  flow: RequirementFlowConfig = input.flow ?? DEFAULT_REQUIREMENT_FLOW,
) {
  const bundleAgents = [...flow.sessionAgentNames];
  const registryAgents = input.registryAgents ?? [];
  const hasRegistryAgents = registryAgents.length > 0;
  const syncSourceSessionId = input.syncSession?.sourceSessionId?.trim();
  const sandboxImage = input.sandboxImage?.trim();
  return {
    agents: [...bundleAgents, ...registryAgents],
    title: input.title,
    target_gitlab: input.target_gitlab,
    base_branch: input.base_branch,
    creator_uuid: input.creator_uuid?.trim() || "-",
    creator_nick_name: input.creator_nick_name?.trim() || "-",
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
    ...(input.workflow_id ? { workflow_id: input.workflow_id } : {}),
    ...(input.sandboxPersistMode || sandboxImage
      ? {
          sandbox: {
            ...(input.sandboxPersistMode
              ? { persistMode: input.sandboxPersistMode }
              : {}),
            ...(sandboxImage ? { image: sandboxImage } : {}),
          },
        }
      : {}),
    ...(hasRegistryAgents ? { agentSource: "registry" as const } : {}),
  };
}

/** Harness init-session 唯一接缝：agents / 默认分支来自流程配置 */
export async function createRequirementHarnessSession(
  input: CreateHarnessSessionInput,
): Promise<HarnessInitSessionResult> {
  const registryAgents = input.registryAgents?.length
    ? await resolveAgentRegistryNames(input.registryAgents)
    : input.registryAgents;
  return postHarnessInitSession(
    harnessSessionRequest({
      ...input,
      registryAgents,
    }),
  );
}
