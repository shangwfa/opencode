import { describe, expect, test, vi } from "vitest";
import {
  buildPlanSkillInjectionWritebackPrompt,
  injectedSkillNames,
  writeInjectedSkillsToPlanArtifact,
} from "./confirm-plan-stage";
import type { ArtifactPanelContext } from "@/features/requirement/artifact-panel";
import type { InjectSessionSkillsResult } from "@/features/requirement/skills-inject";

vi.mock("@/ui/components/toast", () => ({
  showToast: vi.fn(),
}));

const result = (
  created: Array<{ name: string; resourceCount?: number }>,
  skipped: InjectSessionSkillsResult["skipped"] = [],
): InjectSessionSkillsResult => ({
  created: created.map((item) => ({
    name: item.name,
    resourceCount: item.resourceCount ?? 0,
  })),
  skipped,
});

function ctx(overrides?: {
  send?: ArtifactPanelContext["sendSyncStageMessage"];
  syncArtifact?: (index?: number, opts?: { quiet?: boolean }) => Promise<boolean>;
}): ArtifactPanelContext {
  return {
    working: () => ({ id: "plan", label: "方案规划", agent: "planner-boss", artifactPath: "plan.md" }),
    req: {
      stages: [
        { id: "requirement-discussion", label: "需求讨论", agent: "specer-boss", artifactPath: "spec.md" },
        { id: "plan", label: "方案规划", agent: "planner-boss", artifactPath: "plan.md" },
      ],
      machine: {
        syncArtifact: overrides?.syncArtifact ?? vi.fn(async () => true),
      },
    },
    sendSyncStageMessage: overrides?.send,
  } as unknown as ArtifactPanelContext;
}

describe("plan skill injection writeback", () => {
  test("builds a plan writeback prompt with all created skill names", () => {
    const prompt = buildPlanSkillInjectionWritebackPrompt(["boss-create", "boss-list"]);

    expect(prompt).toContain("已注入 Skill：");
    expect(prompt).toContain("- boss-create");
    expect(prompt).toContain("- boss-list");
    expect(prompt).toContain("只更新 plan.md，不要推进阶段，不要修改业务代码。");
  });

  test("does not build a prompt when there are no created skill names", () => {
    expect(buildPlanSkillInjectionWritebackPrompt([])).toBe("");
    expect(injectedSkillNames(result([{ name: " " }]))).toEqual([]);
  });

  test("writes created skill names and refreshes the plan artifact", async () => {
    const send = vi.fn(async () => {});
    const syncArtifact = vi.fn(async () => true);

    const ok = await writeInjectedSkillsToPlanArtifact({
      ctx: ctx({ send, syncArtifact }),
      result: result(
        [{ name: "boss-create" }, { name: "boss-table" }],
        [{ input: "missing", reason: "not found" }],
      ),
    });

    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledWith({
      agent: "planner-boss",
      text: expect.stringContaining("- boss-table"),
    });
    expect(syncArtifact).toHaveBeenCalledWith(1, { quiet: true });
  });

  test("skips writeback when no skill was created", async () => {
    const send = vi.fn(async () => {});
    const syncArtifact = vi.fn(async () => true);

    const ok = await writeInjectedSkillsToPlanArtifact({
      ctx: ctx({ send, syncArtifact }),
      result: result([]),
    });

    expect(ok).toBe(true);
    expect(send).not.toHaveBeenCalled();
    expect(syncArtifact).not.toHaveBeenCalled();
  });

  test("returns false when writeback fails", async () => {
    const send = vi.fn(async () => {
      throw new Error("network down");
    });
    const syncArtifact = vi.fn(async () => true);

    const ok = await writeInjectedSkillsToPlanArtifact({
      ctx: ctx({ send, syncArtifact }),
      result: result([{ name: "boss-create" }]),
    });

    expect(ok).toBe(false);
    expect(syncArtifact).not.toHaveBeenCalled();
  });
});
