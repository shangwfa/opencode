import { describe, expect, test } from "vitest";
import {
  parseTemplateJudgment,
  templateDisplayName,
  templateNoMatchDetail,
} from "./parse-template-judgment";

describe("parseTemplateJudgment", () => {
  test("parses usageScenarios for an existing template", () => {
    const judgment = parseTemplateJudgment(
      JSON.stringify({
        status: "completed",
        useExistingTemplate: true,
        templateId: "boss-user-list",
        templateName: "用户列表",
        reason: "字段和列表页模版匹配",
        usageScenarios: "## 适用场景\n\n- 查询列表\n- 批量操作",
      }),
    );

    expect(judgment).toMatchObject({
      useExistingTemplate: true,
      templateId: "boss-user-list",
      templateName: "用户列表",
      reason: "字段和列表页模版匹配",
      usageScenarios: "## 适用场景\n\n- 查询列表\n- 批量操作",
    });
  });

  test("omits blank usageScenarios", () => {
    const judgment = parseTemplateJudgment(
      JSON.stringify({
        status: "completed",
        useExistingTemplate: true,
        templateId: "boss-user-list",
        usageScenarios: "   ",
      }),
    );

    expect(judgment?.usageScenarios).toBeUndefined();
  });

  test("keeps existing display and no-match behavior", () => {
    const matched = parseTemplateJudgment(
      JSON.stringify({
        status: "completed",
        useExistingTemplate: true,
        templateId: "boss-user-list",
        templateName: "用户列表",
        reason: "字段和列表页模版匹配",
      }),
    );
    const unmatched = parseTemplateJudgment(
      JSON.stringify({
        status: "completed",
        useExistingTemplate: false,
        summary: "未找到足够匹配的模版",
        reason: "需要自定义布局",
        matchExplanation: "候选模版缺少关键表格操作",
      }),
    );

    expect(templateDisplayName(matched)).toBe("用户列表");
    expect(templateNoMatchDetail(unmatched)).toBe("未找到足够匹配的模版");
    expect(matched?.usageScenarios).toBeUndefined();
  });
});
