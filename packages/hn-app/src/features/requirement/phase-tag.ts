export type PhaseName = "planning" | "building" | "reviewing" | "done";
export type PhaseResult =
  | "started"
  | "done"
  | "skipped"
  | "approved"
  | "changes_requested"
  | "success"
  | "risk_accepted";

export type PhaseTag = {
  phase: PhaseName;
  loop: number;
  result: PhaseResult;
};

const PHASE_TAG_REGEX =
  /\[PHASE:(planning|building|reviewing|done)\]\[LOOP:(\d+)\]\[RESULT:(started|done|skipped|approved|changes_requested|success|risk_accepted)\]/g;

export function parsePhaseTags(text: string): PhaseTag[] {
  const tags: PhaseTag[] = [];
  let match: RegExpExecArray | null;
  const regex = new RegExp(PHASE_TAG_REGEX.source, "g");
  while ((match = regex.exec(text)) !== null) {
    tags.push({
      phase: match[1] as PhaseName,
      loop: parseInt(match[2], 10),
      result: match[3] as PhaseResult,
    });
  }
  return tags;
}

export function parseLatestPhaseTag(text: string): PhaseTag | null {
  const tags = parsePhaseTags(text);
  return tags.length > 0 ? tags[tags.length - 1] : null;
}

export function stripPhaseTags(text: string): string {
  return text.replace(PHASE_TAG_REGEX, "").trim();
}

export function hasPhaseTags(text: string): boolean {
  return PHASE_TAG_REGEX.test(text);
}

export const PHASE_LABELS: Record<PhaseName, string> = {
  planning: "规划中",
  building: "实现中",
  reviewing: "审查中",
  done: "已完成",
};

export const PHASE_ICONS: Record<PhaseName, string> = {
  planning: "📋",
  building: "🔨",
  reviewing: "🔍",
  done: "✅",
};

export const RESULT_LABELS: Record<PhaseResult, string> = {
  started: "开始",
  done: "完成",
  skipped: "已跳过",
  approved: "通过",
  changes_requested: "不通过，返回修改",
  success: "全部完成",
  risk_accepted: "已完成（存在待优化项）",
};

export type SubAgentNode = "planning" | "building" | "reviewing";

export type SubAgentNodeStatus = "pending" | "running" | "done" | "skipped" | "failed";

export function computeSubAgentStatus(
  tags: PhaseTag | PhaseTag[] | null,
): Record<SubAgentNode, SubAgentNodeStatus> {
  const status: Record<SubAgentNode, SubAgentNodeStatus> = {
    planning: "pending",
    building: "pending",
    reviewing: "pending",
  };

  const tagList = tags == null ? [] : Array.isArray(tags) ? tags : [tags];
  if (tagList.length === 0) return status;

  const phaseOrder: SubAgentNode[] = ["planning", "building", "reviewing"];

  for (const tag of tagList) {
    const phase = tag.phase;
    const result = tag.result;

    if (phase === "done") {
      status.planning = "done";
      status.building = "done";
      status.reviewing = result === "risk_accepted" ? "skipped" : "done";
      continue;
    }

    const currentIdx = phaseOrder.indexOf(phase);
    for (let i = 0; i < currentIdx; i++) {
      const prevPhase = phaseOrder[i];
      if (status[prevPhase] === "pending") {
        status[prevPhase] = "done";
      }
    }

    if (result === "started") {
      status[phase] = "running";
    } else if (result === "skipped") {
      status[phase] = "skipped";
    } else if (
      result === "done" ||
      result === "approved" ||
      result === "changes_requested"
    ) {
      status[phase] = "done";
    } else if (result === "success") {
      status[phase] = "done";
    }
  }

  return status;
}

export function getActiveArtifactPhase(tag: PhaseTag | null): SubAgentNode | "done" | null {
  if (!tag) return null;
  if (tag.phase === "done") {
    return tag.result === "risk_accepted" ? "reviewing" : "building";
  }
  if (tag.result === "skipped") return null;
  if (tag.result === "started") return tag.phase as SubAgentNode;
  if (tag.result === "done" || tag.result === "approved" || tag.result === "changes_requested") {
    return tag.phase as SubAgentNode;
  }
  return tag.phase as SubAgentNode;
}
