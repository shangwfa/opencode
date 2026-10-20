/**
 * 工作流配置 JSON 加载器。
 *
 * 从 JSON 文件加载工作流配置，并解析占位符：
 * - `{workspaceRoot}` → OPENCODE_DIRECTORY（运行时环境变量）
 * - `{projectDir}`  → flow 配置中的 projectDir（经 workspaceRoot 解析后）
 * - `{reqId}`       → 需求 ID（在 resolveFlow 中处理）
 */

import { OPENCODE_DIRECTORY } from "../opencode-directory";
import defaultJson from "./default.json";
import universalDynamicJson from "./universal-dynamic.json";
import bossMicroJson from "./boss-micro.json";
import plainJson from "./plain.json";
import productDesignJson from "./product-design.json";
import type { RequirementFlowConfig } from "./config";

const WORKSPACE_ROOT = OPENCODE_DIRECTORY;

/** 将模板字符串中的占位符替换为实际值 */
function resolveString(
  template: string,
  values: Record<string, string>,
): string {
  return Object.entries(values).reduce(
    (s, [key, val]) => s.replaceAll(`{${key}}`, val),
    template,
  );
}

/** 递归解析对象/数组中的所有字符串值 */
function resolvePlaceholders(
  value: unknown,
  values: Record<string, string>,
): unknown {
  if (typeof value === "string") {
    return resolveString(value, values);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePlaceholders(item, values));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = resolvePlaceholders(v, values);
    }
    return result;
  }
  return value;
}

/** 从 JSON 加载并解析工作流配置 */
export function loadFlowConfig(json: unknown): RequirementFlowConfig {
  const raw = json as Record<string, unknown>;

  // 先解析 projectDir（可能包含 {workspaceRoot}）
  const projectDir = resolveString(String(raw.projectDir ?? WORKSPACE_ROOT), {
    workspaceRoot: WORKSPACE_ROOT,
  });

  // 构建完整的占位符映射
  const values: Record<string, string> = {
    workspaceRoot: WORKSPACE_ROOT,
    projectDir,
  };

  return resolvePlaceholders(json, values) as RequirementFlowConfig;
}

/** 预加载的标准工作流配置 */
export const DEFAULT_REQUIREMENT_FLOW = loadFlowConfig(defaultJson);

/** 预加载的动态工作流配置（隐藏 StageBar + orchestrator 调度 + NextStepCard/GuidanceCard 驱动） */
export const UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW = loadFlowConfig(universalDynamicJson);

/** 预加载的 Boss 微前端工作流配置（历史保留，专用 view 已降级为 markdown-confirm） */
export const DEFAULT_BOSS_REQUIREMENT_FLOW = loadFlowConfig(bossMicroJson);

/** 预加载的自由对话工作流配置（无 agent、无 StageBar） */
export const DEFAULT_PLAIN_REQUIREMENT_FLOW = loadFlowConfig(plainJson);

/** 预加载的产品设计工作流配置（历史保留） */
export const DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW =
  loadFlowConfig(productDesignJson);
