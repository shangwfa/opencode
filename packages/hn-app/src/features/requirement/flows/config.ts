/**
 * 需求对话研发流程类型定义与核心常量。
 *
 * 本文件只包含类型和常量，不包含具体工作流配置或工具函数。
 * 具体配置见同级目录，工具函数见 `./utils`。
 */

import { OPENCODE_DIRECTORY } from "../opencode-directory";

export const REQUIREMENT_WORKSPACE_ROOT = OPENCODE_DIRECTORY;

export const REQUIREMENT_PROJECT_DIR = `${OPENCODE_DIRECTORY.replace(/\/+$/, "")}`;

export type ModelRef = { providerID: string; modelID: string };

export type StagePermission = {
  edit?: "allow" | "deny";
  bash?: "allow" | "ask" | "deny";
};

export type StageKind = "conversation" | "automated" | "confirm";

export type StageBranch = "common" | "has-template" | "no-template";

/** 产物侧栏视图 id（注册表见 `artifact-panel/registry`） */
export type ArtifactPanelViewId =
  | "markdown-confirm"
  | "plan-confirm"
  | "empty"
  | (string & {});

export type StageCompletion = {
  vcsDiff?: boolean;
  completionPrompt?: string;
  autoDetectSuggestStep?: boolean;
};

/** 阶段跳过规则 */
export type StageSkipRule = {
  /** 被跳过的阶段 id */
  skipStageId: string;
  /** 跳过条件 */
  condition: "templateAccepted" | "always" | "custom";
};

/** 阶段产物类型，用于 ArtifactCard 展示与校验 */
export type ArtifactKind =
  | "requirement_snapshot"
  | "bug_report"
  | "prd"
  | "technical_plan"
  | "task_breakdown"
  | "layout_design"
  | "api_match"
  | "implementation_summary"
  | "build_log"
  | "review_report"
  | "acceptance_report"
  | "spec"
  | "plan"
  | "build_report"
  | "verification_report"
  | (string & {});

export type StageConfig = {
  /** 阶段唯一 id，用于状态与产物关联 */
  id: string;
  /** StageBar / UI 展示的流程节点名称 */
  label: string;
  /** 本阶段发消息时使用的 session agent 名（须已注入 session） */
  agent: string;
  /**
   * 阶段产物在沙箱中的完整路径，用于 GET /file/content?path=...
   * 无固定产物文件时留空字符串。
   */
  artifactPath: string;
  description?: string;
  permission?: StagePermission;
  /** 从上一阶段确认进入本阶段时自动发送的 prompt（仅引用路径占位符） */
  enterPrompt?: string;
  /** 从后续阶段回退到本阶段时自动发送的 prompt */
  backwardEnterPrompt?: string;
  /** 阶段消息列表为空时的用户行动引导文案；无配置时不显示 */
  emptyPrompt?: string;
  /** 阶段产物确认后的行为声明 */
  completion?: StageCompletion;
  /** 阶段交互类型 */
  stageKind?: StageKind;
  /** 分支专属阶段 */
  branch?: StageBranch;
  /** 产物侧栏视图 id（见 `artifact-panel/resolve-artifact-panel-view`） */
  artifactPanelView?: ArtifactPanelViewId;
  /** 产物确认后显示"提交代码"按钮，弹出 commitMessage 编辑 Dialog 调用 git-commit API */
  commitButton?: boolean;
  /** 阶段跳过规则（配置驱动阶段流转） */
  skipRules?: StageSkipRule[];
  /** 该阶段是否允许用户点击「跳过」 */
  skippable?: boolean;
  /** 禁用的模版 ID 列表（用于 template-selection 阶段校验） */
  forbiddenTemplateIds?: string[];
  /** 阶段产物类型，用于 ArtifactCard（dynamic-harness） */
  artifactKind?: ArtifactKind;
};

export type StageArtifact = {
  stage: string;
  /** 与 artifactPath 一致，便于展示与保存 */
  path: string;
  content: string;
  confirmedAt?: string;
};

export type RequirementFlowConfig = {
  /** 工作流唯一标识（如 default、boss-micro） */
  id: string;
  /** 工作流显示名称 */
  label?: string;
  /** 工作流描述 */
  description?: string;
  workspaceRoot: string;
  projectDir: string;
  /** 全流程需要在 session 注入的 agent（用于校验与提示） */
  sessionAgentNames: readonly string[];
  stages: StageConfig[];
  /** suggest-step.json 沙箱路径（支持 {reqId} 占位符） */
  suggestStepPath: string;
  /** runtime-decision.json 沙箱路径（支持 {reqId} 占位符）；缺省时不启用 orchestrator 调度 */
  runtimeDecisionPath?: string;
  /** artifact-events.jsonl 沙箱路径（支持 {reqId} 占位符）；缺省时不启用 ArtifactCard */
  artifactEventsPath?: string;
  /** 默认模版 Skill ID（plan 阶段注入 Skill 时的 fallback） */
  defaultTemplateSkillId?: string;
  /** [REQUIREMENT] 隐藏 StageBar、跳过消息过滤与 agent 锁定，使用 opencode 默认 agent */
  hideStageBar?: boolean;
  /** [REQUIREMENT][DYNAMIC-HARNESS] 隐藏 StageBar 但保留多阶段 agent 锁定 + 启用 NextStepCard / ArtifactCard */
  dynamicHarness?: boolean;
  /** [REQUIREMENT] @ 提及中是否展示 session 已注入的子 agent（主 agent 通过输入框选择器选择） */
  allowSubAgentMention?: boolean;
};
