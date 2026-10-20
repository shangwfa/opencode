/**
 * 需求域 API 类型（自 xybot-front-opencode-ui src/api/requirement/types.ts 移植）。
 * 已迁：GitlabBranchItem / Requirement 域类型 / AggregateRequirement 及其依赖。
 * 其余（spec / approval / harness* / pipeline* 等）按 MIGRATION.md 按需补齐。
 */

export type RequirementKind = "regular" | "bugfix";

export type CreateType = "form" | "chat";

export type RequirementVersion = "v1" | "v2" | "intake";

export type RequirementSpecFragment = {
  subtask_id: string;
  title: string;
  spec: string;
  variant: "markdown" | "questions";
};

export type RequirementSubtaskPersisted = {
  subtask_id: string;
  title: string;
  scope: string;
};

export type Requirement = {
  id: string;
  title: string;
  description: string;
  material_description: string;
  feishu_url: string;
  spec_markdown: string;
  spec_fragments?: RequirementSpecFragment[];
  subtasks?: RequirementSubtaskPersisted[];
  spec_cdn_url: string;
  target_gitlab: string;
  priority: "low" | "medium" | "high";
  status: "open" | "pending_publish" | "done";
  kind: RequirementKind;
  run_ids: string[];
  result_assessment: string;
  created_at: string;
  creator_uuid: string;
  creator_nick_name: string;
  opencode_session_id?: string;
  create_type: CreateType;
  /** 工作流标识，保存时落库 */
  workflow_id?: string;
  /** 对话式需求基准分支，保存时落库（§18 DP15） */
  base_branch?: string;
};

export type MergeRecord = {
  mr_web_url: string;
  source_branch: string;
  target_branch: string;
  state: "opened" | "merged" | "closed";
  created_at: string;
  merged_at?: string;
};

export type AggregateRequirement = {
  id: string;
  title: string;
  status: string;
  created_at: string;
  target_gitlab: string;
  creator_uuid: string;
  creator_nick_name: string;
  opencode_session_id: string;
  workflow_id: string;
  version: RequirementVersion;
  updated_at?: string;
  base_branch?: string;
  work_branch?: string;
  run_ids?: string[];
  merge_records?: MergeRecord[];
  description?: string;
  material_description?: string;
  priority?: "low" | "medium" | "high";
  kind?: RequirementKind;
  feishu_url?: string;
  spec_cdn_url?: string;
  spec_markdown?: string;
  result_assessment?: string;
  create_type?: CreateType;
  source?: string;
};

export type GitlabBranchItem = {
  name: string;
  default: boolean;
  protected: boolean;
  web_url: string;
  commit?: {
    short_id?: string;
    title?: string;
    message?: string;
    committed_date?: string;
  };
};
