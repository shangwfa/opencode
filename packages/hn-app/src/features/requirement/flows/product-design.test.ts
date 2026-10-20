import { describe, expect, test } from "vitest";
import { DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW } from "./index";
import { resolveFlow } from "./registry";

describe("product-design flow", () => {
  test("uses production-designer for a single design and coding stage", () => {
    expect(DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW.id).toBe("product-design");
    expect(DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW.sessionAgentNames).toEqual([
      "production-designer",
    ]);
    expect(
      DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW.stages.map((stage) => stage.id),
    ).toEqual(["web-design"]);

    const stage = DEFAULT_PRODUCT_DESIGN_REQUIREMENT_FLOW.stages[0];
    expect(stage).toMatchObject({
      label: "界面设计",
      agent: "production-designer",
      artifactPath: "analysis/{reqId}/product/web-ui.md",
      permission: { edit: "allow", bash: "allow" },
    });
    expect(stage?.commitButton).toBeUndefined();
  });

  test("is registered by workflow id", () => {
    expect(resolveFlow({ workflowId: "product-design" }).id).toBe(
      "product-design",
    );
  });
});
