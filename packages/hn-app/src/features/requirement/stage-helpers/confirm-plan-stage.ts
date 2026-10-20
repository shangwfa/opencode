import { showToast } from "@/ui/components/toast";
import {
  injectSkillsBeforeCodeGen,
  type InjectSessionSkillsResult,
} from "@/features/requirement/skills-inject";
import { resolveCurrentTemplateId } from "@/features/requirement/resolve-current-template-id";
import type { ArtifactPanelContext } from "@/features/requirement/artifact-panel";

export function templateSelectionArtifactContent(
  ctx: ArtifactPanelContext,
): string | undefined {
  return (
    ctx.req.machine.getState().artifacts.find((a) => a.stage === "layout-design")
      ?.content ??
    ctx.req.machine.getState().artifacts.find((a) => a.stage === "template-selection")
      ?.content
  );
}

export function resolvePlanStageTemplateId(ctx: ArtifactPanelContext): string {
  const sid = ctx.req.session.id();
  const defaultTemplateSkillId = ctx.req.flow.defaultTemplateSkillId;
  if (!sid) return resolveCurrentTemplateId({ sessionId: "", defaultTemplateSkillId });
  return resolveCurrentTemplateId({
    sessionId: sid,
    templateSelectionArtifact: templateSelectionArtifactContent(ctx),
    defaultTemplateSkillId,
  });
}

export function skillsInjectOutcome(
  result: InjectSessionSkillsResult,
): "ok" | "partial" | "failed" {
  if (result.created.length > 0) {
    return result.skipped.length > 0 ? "partial" : "ok";
  }
  if (result.skipped.length > 0) return "failed";
  return "ok";
}

export function notifySkillsInjectResult(result: InjectSessionSkillsResult) {
  const outcome = skillsInjectOutcome(result);
  if (outcome === "ok") return true;
  if (outcome === "partial") {
    showToast({
      variant: "default",
      title: "部分 Skill 注入失败",
      description: result.skipped.map((s) => `${s.input}: ${s.reason}`).join("；"),
    });
    return true;
  }
  showToast({
    variant: "error",
    title: "Skill 注入失败",
    description:
      result.skipped.map((s) => `${s.input}: ${s.reason}`).join("；") ||
      "未能创建任何 session skill",
  });
  return false;
}

export async function injectSkillsForPlanStage(input: {
  ctx: ArtifactPanelContext;
  baseUrl: string;
}): Promise<InjectSessionSkillsResult | undefined> {
  const sid = input.ctx.req.session.id();
  if (!sid) {
    showToast({ variant: "error", title: "Session 不存在" });
    return undefined;
  }

  const templateId = resolvePlanStageTemplateId(input.ctx);
  const result = await injectSkillsBeforeCodeGen({
    sessionId: sid,
    templateId,
    defaultTemplateSkillId: input.ctx.req.flow.defaultTemplateSkillId,
    baseUrl: input.baseUrl,
  });
  return notifySkillsInjectResult(result) ? result : undefined;
}

export function injectedSkillNames(result: InjectSessionSkillsResult): string[] {
  return result.created
    .map((item) => item.name.trim())
    .filter((name) => name.length > 0);
}

export function buildPlanSkillInjectionWritebackPrompt(
  skillNames: string[],
): string {
  const names = skillNames.map((name) => name.trim()).filter(Boolean);
  if (names.length === 0) return "";
  return [
    "已完成代码生成前 Skill 注入，请将以下信息补充写入当前方案规划文件 plan.md 的合适位置：",
    "",
    "已注入 Skill：",
    ...names.map((name) => `- ${name}`),
    "",
    "只更新 plan.md，不要推进阶段，不要修改业务代码。",
  ].join("\n");
}

export async function writeInjectedSkillsToPlanArtifact(input: {
  ctx: ArtifactPanelContext;
  result: InjectSessionSkillsResult;
}): Promise<boolean> {
  const skillNames = injectedSkillNames(input.result);
  const text = buildPlanSkillInjectionWritebackPrompt(skillNames);
  if (!text) return true;

  const stage = input.ctx.working();
  const agent = stage?.agent;
  if (!agent || !input.ctx.sendSyncStageMessage) {
    showToast({
      variant: "error",
      title: "Skill 注入信息写入失败",
      description: "同步消息未就绪",
    });
    return false;
  }

  try {
    await input.ctx.sendSyncStageMessage({ agent, text });
    const index = input.ctx.req.stages.findIndex((s) => s.id === stage.id);
    if (index >= 0) {
      await input.ctx.req.machine.syncArtifact(index, { quiet: true });
    }
    return true;
  } catch (e) {
    showToast({
      variant: "error",
      title: "Skill 注入信息写入失败",
      description: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

export async function confirmPlanStageArtifact(ctx: ArtifactPanelContext) {
  if (ctx.peeking()) return;
  const id = ctx.working()?.id;
  if (id !== "plan") return;
  const req = ctx.req;
  if (!req.machine.isConfirmed(id)) {
    const art = req.machine.getState().artifacts.find((a) => a.stage === id);
    if (!art?.content.trim()) {
      showToast({ variant: "error", title: "产物为空，无法确认" });
      return;
    }
  }
  req.machine.confirmArtifact(id);
  if (ctx.isLast()) return;
  try {
    await req.machine.fetchSuggestStep();
  } catch {
    // ignore
  }
  if (!req.machine.isSuggestStepReady()) {
    return "advance" as const;
  }
  return "suggest" as const;
}
