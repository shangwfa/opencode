import { beforeEach, describe, expect, test } from "vitest";
import { resolveCurrentTemplateId } from "./resolve-current-template-id";
import { storeTemplateSelectionDecision } from "./stage-helpers/template-selection-storage";

const templateSelection = {
  selection_version: "1.0",
  status: "completed",
  agent: "layout-template-judge",
  useExistingTemplate: true,
  templateId: "boss-user-manage",
  templateName: "用户管理模板",
};

describe("resolveCurrentTemplateId", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  test("reads confirmed template from layout-designer artifact", () => {
    const artifact = JSON.stringify({
      layout_designer_version: "1.0",
      agent: "layout-designer",
      stage: "completed",
      templateSelection,
      templateDecision: {
        confirmedUseTemplate: true,
        decided_at: "2026-06-11T00:00:00.000Z",
      },
      wireframeDesign: null,
      selectedDemo: null,
    });

    expect(
      resolveCurrentTemplateId({
        sessionId: "ses_1",
        templateSelectionArtifact: artifact,
        defaultTemplateSkillId: "boss-create",
      }),
    ).toBe("boss-user-manage");
  });

  test("falls back when layout-designer did not confirm template usage", () => {
    const artifact = JSON.stringify({
      layout_designer_version: "1.0",
      agent: "layout-designer",
      stage: "completed",
      templateSelection,
      templateDecision: {
        confirmedUseTemplate: false,
        decided_at: "2026-06-11T00:00:00.000Z",
      },
      wireframeDesign: null,
      selectedDemo: "demo-1",
    });

    expect(
      resolveCurrentTemplateId({
        sessionId: "ses_1",
        templateSelectionArtifact: artifact,
        defaultTemplateSkillId: "boss-create",
      }),
    ).toBe("boss-create");
  });

  test("respects stored rejection over legacy template-selection artifact", () => {
    storeTemplateSelectionDecision("ses_1", { accepted: false });

    expect(
      resolveCurrentTemplateId({
        sessionId: "ses_1",
        templateSelectionArtifact: JSON.stringify(templateSelection),
        defaultTemplateSkillId: "boss-create",
      }),
    ).toBe("boss-create");
  });
});
