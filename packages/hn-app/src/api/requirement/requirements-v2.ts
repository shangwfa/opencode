import type {
  AggregateRequirement,
  MergeRecord,
  RequirementVersion,
} from "./types";
import { requirementApiFetch, requirementApiBase, errorFromJson } from "./client";
import { isRequirementHiddenFromList } from "@/features/requirement/route-repo";

function isMergeRecord(value: unknown): value is MergeRecord {
  if (!value || typeof value !== "object") return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec["mr_web_url"] === "string" &&
    typeof rec["source_branch"] === "string" &&
    typeof rec["target_branch"] === "string" &&
    typeof rec["state"] === "string" &&
    typeof rec["created_at"] === "string"
  );
}

function normalizeMergeRecords(raw: unknown): MergeRecord[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const records = raw.filter(isMergeRecord);
  return records.length > 0 ? records : undefined;
}

function normalizeAggregateRequirement(
  raw: Record<string, unknown>,
): AggregateRequirement {
  const version =
    typeof raw.version === "string" && (raw.version === "v1" || raw.version === "v2" || raw.version === "intake")
      ? (raw.version as RequirementVersion)
      : "v1";
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    title: typeof raw.title === "string" ? raw.title : "",
    status: typeof raw.status === "string" ? raw.status : "open",
    created_at: typeof raw.created_at === "string" ? raw.created_at : "",
    target_gitlab: typeof raw.target_gitlab === "string" ? raw.target_gitlab : "",
    creator_uuid: typeof raw.creator_uuid === "string" ? raw.creator_uuid : "",
    creator_nick_name:
      typeof raw.creator_nick_name === "string" ? raw.creator_nick_name : "",
    opencode_session_id:
      typeof raw.opencode_session_id === "string" ? raw.opencode_session_id : "",
    workflow_id: typeof raw.workflow_id === "string" ? raw.workflow_id : "",
    version,
    updated_at: typeof raw.updated_at === "string" ? raw.updated_at : undefined,
    base_branch:
      typeof raw.base_branch === "string" ? raw.base_branch : undefined,
    work_branch:
      typeof raw.work_branch === "string" ? raw.work_branch : undefined,
    run_ids: Array.isArray(raw.run_ids)
      ? raw.run_ids.filter((x: unknown) => typeof x === "string")
      : undefined,
    merge_records: normalizeMergeRecords(raw.merge_records),
    description: typeof raw.description === "string" ? raw.description : undefined,
    material_description:
      typeof raw.material_description === "string"
        ? raw.material_description
        : undefined,
    priority:
      raw.priority === "low" || raw.priority === "medium" || raw.priority === "high"
        ? raw.priority
        : undefined,
    kind:
      raw.kind === "regular" || raw.kind === "bugfix" ? raw.kind : undefined,
    feishu_url: typeof raw.feishu_url === "string" ? raw.feishu_url : undefined,
    spec_cdn_url:
      typeof raw.spec_cdn_url === "string" ? raw.spec_cdn_url : undefined,
    spec_markdown:
      typeof raw.spec_markdown === "string" ? raw.spec_markdown : undefined,
    result_assessment:
      typeof raw.result_assessment === "string"
        ? raw.result_assessment
        : undefined,
    create_type:
      raw.create_type === "form" || raw.create_type === "chat"
        ? raw.create_type
        : undefined,
    source:
      typeof raw.source === "string" ? raw.source : undefined,
  };
}

export async function fetchRequirementsV2All(
  targetGitlab = "",
): Promise<AggregateRequirement[]> {
  const qs = targetGitlab.trim()
    ? `?${new URLSearchParams({ target_gitlab: targetGitlab.trim() }).toString()}`
    : "";
  const res = await requirementApiFetch(
    `${requirementApiBase}/v2/requirements/all${qs}`,
  );
  if (!res.ok) throw new Error("加载需求列表失败");
  const rows = (await res.json()) as Record<string, unknown>[];
  return rows
    .map((r) => normalizeAggregateRequirement(r))
    .filter((r) => !isRequirementHiddenFromList(r.target_gitlab));
}

export async function updateRequirementV2(
  id: string,
  body: {
    title?: string;
    status?: "open" | "pending_publish" | "done";
    run_ids?: string[];
    target_gitlab?: string;
    base_branch?: string;
    work_branch?: string;
    creator_uuid?: string;
    creator_nick_name?: string;
    opencode_session_id?: string;
    workflow_id?: string;
  },
): Promise<AggregateRequirement> {
  const res = await requirementApiFetch(
    `${requirementApiBase}/v2/requirements/${encodeURIComponent(id)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 404) throw new Error("需求不存在或已删除");
    throw new Error(errorFromJson(data, "更新失败"));
  }
  return normalizeAggregateRequirement(data);
}

export async function deleteRequirementV2(id: string): Promise<void> {
  const res = await requirementApiFetch(
    `${requirementApiBase}/v2/requirements/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (res.status === 204) return;
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error("需求不存在或已删除");
  throw new Error(errorFromJson(data, "删除失败"));
}

export async function appendRequirementV2RunId(
  id: string,
  runId: string,
): Promise<AggregateRequirement> {
  const res = await requirementApiFetch(
    `${requirementApiBase}/v2/requirements/${encodeURIComponent(id)}/run-ids`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ run_id: runId.trim() }),
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 404) throw new Error("需求不存在或已删除");
    throw new Error(errorFromJson(data, "追加 runId 失败"));
  }
  return normalizeAggregateRequirement(data);
}

export async function fetchRequirementAggregate(
  id: string,
): Promise<AggregateRequirement> {
  const res = await requirementApiFetch(
    `${requirementApiBase}/requirements/aggregate/${encodeURIComponent(id)}`,
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 404) throw new Error("需求不存在或已删除");
    throw new Error(errorFromJson(data, "加载需求失败"));
  }
  return normalizeAggregateRequirement(data);
}

export async function fetchRequirementV2(
  id: string,
): Promise<AggregateRequirement> {
  const res = await requirementApiFetch(
    `${requirementApiBase}/v2/requirements/${encodeURIComponent(id)}`,
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    if (res.status === 404) throw new Error("需求不存在或已删除");
    throw new Error(errorFromJson(data, "加载需求失败"));
  }
  return { ...normalizeAggregateRequirement(data), version: "v2" };
}
