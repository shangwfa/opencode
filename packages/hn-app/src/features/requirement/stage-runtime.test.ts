import { describe, expect, test } from "vitest";
import type { Message } from "@/types/opencode";
import { DEFAULT_REQUIREMENT_FLOW } from "./flows";
import {
  stageSummaryCards,
  stageEmptyHint,
  remoteWorkingHint,
} from "./flows/utils";
import {
  advanceHintText,
  buildStageEnterPrompt,
  canAdvanceNow,
  isSuggestStepValid,
  isLastStageIndex,
  planAdvance,
  resolveSuggestStepStageIndex,
  resolveWorkingIndex,
  restoreStageIndex,
  type StageSnapshot,
} from "./stage-runtime";

const stages = DEFAULT_REQUIREMENT_FLOW.stages;

describe("restoreStageIndex", () => {
  test("uses last user message agent", () => {
    const messages = [
      { role: "user", agent: "specer", id: "1" },
      { role: "user", agent: "planner", id: "2" },
    ] as Message[];
    expect(restoreStageIndex(messages, stages)).toBe(1);
  });

  test("defaults to 0 when no matching agent", () => {
    expect(restoreStageIndex([], stages)).toBe(0);
  });

  test("skips build init agent", () => {
    const messages = [
      { role: "user", agent: "build", id: "0" },
      { role: "user", agent: "specer", id: "1" },
    ] as Message[];
    expect(restoreStageIndex(messages, stages)).toBe(0);
  });
});

describe("resolveWorkingIndex", () => {
  test("uses message inference", () => {
    const messages = [{ role: "user", agent: "planner", id: "1" }] as Message[];
    expect(
      resolveWorkingIndex({
        messages,
        stages,
      }),
    ).toBe(1);
  });

  test("defaults to 0 when no messages", () => {
    expect(
      resolveWorkingIndex({
        messages: [],
        stages,
      }),
    ).toBe(0);
  });

  test("defaults to 0 when no matching agent", () => {
    const messages = [{ role: "user", agent: "build", id: "1" }] as Message[];
    expect(
      resolveWorkingIndex({
        messages,
        stages,
      }),
    ).toBe(0);
  });
});

describe("planAdvance", () => {
  test("returns enter text for specer → planner", () => {
    const snap: StageSnapshot = {
      index: 0,
      stages,
      flow: DEFAULT_REQUIREMENT_FLOW,
      artifacts: [],
    };
    const plan = planAdvance(snap);
    expect(plan?.next.agent).toBe("planner");
    expect(plan?.enterText).toContain("方案规划");
  });

  test("undefined on last stage", () => {
    const snap: StageSnapshot = {
      index: stages.length - 1,
      stages,
      flow: DEFAULT_REQUIREMENT_FLOW,
      artifacts: [],
    };
    expect(planAdvance(snap)).toBeUndefined();
  });
});

describe("canAdvanceNow", () => {
  const confirmed = () => true;
  const pending = () => false;

  test("no-artifact stage allows forward when not last", () => {
    const snap: StageSnapshot = {
      index: 0,
      stages: [{ ...stages[0]!, artifactPath: "" }, stages[1]!],
      flow: DEFAULT_REQUIREMENT_FLOW,
      artifacts: [],
    };
    expect(canAdvanceNow(snap, { isConfirmed: pending })).toBe(true);
  });

  test("artifact stage needs content and confirmation", () => {
    const snap: StageSnapshot = {
      index: 0,
      stages,
      flow: DEFAULT_REQUIREMENT_FLOW,
      artifacts: [
        {
          stage: stages[0]!.id,
          path: stages[0]!.artifactPath,
          content: "# spec",
        },
      ],
    };
    expect(canAdvanceNow(snap, { isConfirmed: pending })).toBe(false);
    expect(canAdvanceNow(snap, { isConfirmed: confirmed })).toBe(true);
  });

  test("false on last stage", () => {
    const snap: StageSnapshot = {
      index: stages.length - 1,
      stages,
      flow: DEFAULT_REQUIREMENT_FLOW,
      artifacts: [],
    };
    expect(canAdvanceNow(snap, { isConfirmed: confirmed })).toBe(false);
  });
});

describe("advanceHintText", () => {
  test("prompts when artifact exists but not confirmed", () => {
    const snap: StageSnapshot = {
      index: 0,
      stages,
      flow: DEFAULT_REQUIREMENT_FLOW,
      artifacts: [
        {
          stage: stages[0]!.id,
          path: stages[0]!.artifactPath,
          content: "doc",
        },
      ],
    };
    expect(
      advanceHintText(snap, { working: false, isConfirmed: () => false }),
    ).toContain("确认并进入下一阶段");
  });

  test("hidden when working or last stage", () => {
    const snap: StageSnapshot = {
      index: stages.length - 1,
      stages,
      flow: DEFAULT_REQUIREMENT_FLOW,
      artifacts: [],
    };
    expect(
      advanceHintText(snap, { working: false, isConfirmed: () => true }),
    ).toBeUndefined();
    expect(
      advanceHintText(
        {
          index: 0,
          stages,
          flow: DEFAULT_REQUIREMENT_FLOW,
          artifacts: [],
        },
        { working: true, isConfirmed: () => true },
      ),
    ).toBeUndefined();
  });
});

describe("isLastStageIndex", () => {
  test("last index is last stage", () => {
    expect(isLastStageIndex(stages.length - 1, stages)).toBe(true);
    expect(isLastStageIndex(0, stages)).toBe(false);
  });
});

describe("resolveSuggestStepStageIndex", () => {
  const bossStages = [
    { ...stages[0]!, agent: "specer-boss" },
    { ...stages[1]!, agent: "planner-boss" },
    { ...stages[2]!, agent: "builder" },
  ];

  test("matches exact agent names", () => {
    expect(resolveSuggestStepStageIndex(bossStages, "builder")).toBe(2);
  });

  test("matches suggestStep by stage agent includes", () => {
    expect(resolveSuggestStepStageIndex(bossStages, "planner")).toBe(1);
  });

  test("ignores blank suggestStep", () => {
    expect(resolveSuggestStepStageIndex(bossStages, "   ")).toBe(-1);
  });

  test("keeps same-index target invalid", () => {
    expect(
      isSuggestStepValid(
        {
          currentAgent: "planner-boss",
          suggestStep: "planner",
          status: "ready",
          reason: "",
          updatedAt: "2026-06-10T00:00:00Z",
        },
        "planner-boss",
        bossStages,
        1,
      ),
    ).toBe(false);
  });
});

describe("buildStageEnterPrompt", () => {
  const specer = stages[0]!;
  const planner = stages[1]!;

  test("substitutes stageLabel in default planner template", () => {
    const text = buildStageEnterPrompt(planner, specer, DEFAULT_REQUIREMENT_FLOW);
    expect(text).toBe("开始「方案规划」");
  });

  test("substitutes all placeholders when template references them", () => {
    const text = buildStageEnterPrompt(
      {
        ...planner,
        enterPrompt:
          "「{stageLabel}」← {prevLabel} @ {artifactPath} dir={projectDir}",
      },
      specer,
      DEFAULT_REQUIREMENT_FLOW,
    );
    expect(text).toContain("方案规划");
    expect(text).toContain("需求讨论");
    expect(text).toContain(planner.artifactPath);
    expect(text).toContain(DEFAULT_REQUIREMENT_FLOW.projectDir);
  });

  test("returns empty when enterPrompt missing", () => {
    expect(
      buildStageEnterPrompt(
        { ...specer, enterPrompt: undefined },
        undefined,
        DEFAULT_REQUIREMENT_FLOW,
      ),
    ).toBe("");
  });
});

describe("stageSummaryCards", () => {
  const stages = DEFAULT_REQUIREMENT_FLOW.stages;

  test("returns empty when viewIndex is 0", () => {
    expect(stageSummaryCards(stages, 0, () => true)).toEqual([]);
  });

  test("returns cards for stages before viewIndex", () => {
    const cards = stageSummaryCards(stages, 2, () => true);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({ stageId: "requirement-discussion", label: "需求讨论", confirmed: true });
    expect(cards[1]).toEqual({ stageId: "plan", label: "方案规划", confirmed: true });
  });

  test("reflects confirmation status from isConfirmed callback", () => {
    const cards = stageSummaryCards(stages, 2, (id) => id === "requirement-discussion");
    expect(cards[0].confirmed).toBe(true);
    expect(cards[1].confirmed).toBe(false);
  });
});

describe("stageEmptyHint", () => {
  const stages = DEFAULT_REQUIREMENT_FLOW.stages;

  test("returns thinking for stage with enterPrompt", () => {
    const hint = stageEmptyHint(stages, 1, false);
    expect(hint).toEqual({ type: "thinking", label: "方案规划", stageId: "plan" });
  });

  test("returns thinking when working even without enterPrompt", () => {
    const hint = stageEmptyHint(stages, 0, true);
    expect(hint).toEqual({ type: "thinking", label: "需求讨论", stageId: "requirement-discussion" });
  });

  test("returns prompt for stage with emptyPrompt and not working", () => {
    const hint = stageEmptyHint(stages, 0, false);
    expect(hint).toEqual({ type: "prompt", text: "请直接在下方输入你想做的功能或改动", stageId: "requirement-discussion" });
  });

  test("returns undefined for stage without enterPrompt or emptyPrompt and not working", () => {
    const noHintStages = [{ ...stages[0]!, emptyPrompt: undefined }];
    expect(stageEmptyHint(noHintStages, 0, false)).toBeUndefined();
  });

  test("returns undefined for out-of-bounds viewIndex", () => {
    expect(stageEmptyHint(stages, 99, false)).toBeUndefined();
  });

  test("enterPrompt takes precedence over emptyPrompt", () => {
    const hint = stageEmptyHint(stages, 1, false);
    expect(hint?.type).toBe("thinking");
  });
});

describe("remoteWorkingHint", () => {
  const stages = DEFAULT_REQUIREMENT_FLOW.stages;

  test("returns hint for valid workingIndex", () => {
    const hint = remoteWorkingHint(stages, 2);
    expect(hint).toEqual({ label: "代码生成", stageId: "code-modification" });
  });

  test("returns undefined for out-of-bounds workingIndex", () => {
    expect(remoteWorkingHint(stages, 99)).toBeUndefined();
  });
});
