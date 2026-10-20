/**
 * 工作流配置注册中心。
 *
 * 支持按 workflowId 解析对应的 RequirementFlowConfig。
 * 配置来源：JSON 文件（flows/*.json），经 loader.ts 解析占位符后加载。
 */

import {
  DEFAULT_REQUIREMENT_FLOW,
  UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW,
  DEFAULT_BOSS_REQUIREMENT_FLOW,
  DEFAULT_PLAIN_REQUIREMENT_FLOW,
  DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW,
} from "./loader";
import type { RequirementFlowConfig } from "./config";
import { resolveArtifactPath } from "./utils";

/** 本地工作流注册表 */
const FLOW_REGISTRY: Record<string, RequirementFlowConfig> = {
  default: DEFAULT_REQUIREMENT_FLOW,
  "universal-dynamic": UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW,
  "boss-micro": DEFAULT_BOSS_REQUIREMENT_FLOW,
  plain: DEFAULT_PLAIN_REQUIREMENT_FLOW,
  "product-design": DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW,
};

/** 已知的 workflow ID 列表 */
export type WorkflowId = keyof typeof FLOW_REGISTRY;

/** 判断是否为已知的 workflowId */
export function isKnownWorkflowId(id: string): id is WorkflowId {
  return id in FLOW_REGISTRY;
}

export type ResolveFlowInput = {
  /** 工作流标识（本地注册表 key 或未来服务端 workflow_id） */
  workflowId?: string;
  /** 需求 ID（用于解析 artifactPath 中的 {reqId} 占位符） */
  reqId?: string;
};

/**
 * 解析工作流配置。
 *
 * - 若传入已知 workflowId，返回对应配置
 * - 需要替换 artifactPath 占位符的 flow 会自动处理 {reqId}
 * - 默认返回标准 4 阶段配置
 */
export function resolveFlow(input: ResolveFlowInput): RequirementFlowConfig {
  const { workflowId = "default", reqId } = input;

  const preset = FLOW_REGISTRY[workflowId];
  if (!preset) return FLOW_REGISTRY.default;

  // 若传入了 reqId 且 artifactPath 包含占位符，替换之（保持原 flow 的 stages 不变）
  if (reqId && preset.stages.some((s) => s.artifactPath.includes("{reqId}"))) {
    return {
      ...preset,
      stages: preset.stages.map((stage) => ({
        ...stage,
        artifactPath: stage.artifactPath
          ? resolveArtifactPath(stage.artifactPath, reqId)
          : stage.artifactPath,
      })),
      ...(preset.artifactEventsPath
        ? { artifactEventsPath: resolveArtifactPath(preset.artifactEventsPath, reqId) }
        : {}),
      ...(preset.runtimeDecisionPath
        ? { runtimeDecisionPath: resolveArtifactPath(preset.runtimeDecisionPath, reqId) }
        : {}),
      ...(preset.suggestStepPath.includes("{reqId}")
        ? { suggestStepPath: resolveArtifactPath(preset.suggestStepPath, reqId) }
        : {}),
    };
  }

  return preset;
}
