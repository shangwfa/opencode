import { describe, expect, test } from "vitest";
import { DEFAULT_BOSS_REQUIREMENT_FLOW } from "./index";

describe("boss-micro flow", () => {
  test("uses unified layout design stage after requirement discussion", () => {
    expect(DEFAULT_BOSS_REQUIREMENT_FLOW.description).toContain("布局设计");
    expect(DEFAULT_BOSS_REQUIREMENT_FLOW.stages.map((stage) => stage.id)).toEqual([
      "requirement-discussion",
      "layout-design",
      "plan",
      "code-modification",
      "code-review",
    ]);
    expect(
      DEFAULT_BOSS_REQUIREMENT_FLOW.stages.find((stage) => stage.id === "layout-design")
        ?.artifactPanelView,
    ).toBe("layout-designer-confirm");
    expect(
      DEFAULT_BOSS_REQUIREMENT_FLOW.stages.find((stage) => stage.id === "layout-design")
        ?.skippable,
    ).toBe(true);
  });

  test("mounts layout-designer and child layout agents", () => {
    expect(DEFAULT_BOSS_REQUIREMENT_FLOW.sessionAgentNames).toEqual(
      expect.arrayContaining([
        "layout-designer",
        "layout-template-judge",
        "layout-wireframe-designer",
      ]),
    );
  });
});
