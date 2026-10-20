/**
 * 工作流配置聚合导出。
 *
 * 所有工作流配置集中从此文件导入，新增工作流时：
 * 1. 新建 JSON 文件（如 `flows/my-new-flow.json`）
 * 2. 在 `loader.ts` 中导入并导出
 * 3. 在 `registry.ts` 中注册到 FLOW_REGISTRY
 */

export {
  DEFAULT_REQUIREMENT_FLOW,
  UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW,
  DEFAULT_BOSS_REQUIREMENT_FLOW,
  DEFAULT_PLAIN_REQUIREMENT_FLOW,
  DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW,
} from "./loader";

// [MIGRATION] barrel 补充：registry / config 的常用导出（React 页面消费）
export { resolveFlow, isKnownWorkflowId, type WorkflowId } from "./registry";
export type {
  RequirementFlowConfig,
  StageConfig,
  StageArtifact,
} from "./config";
