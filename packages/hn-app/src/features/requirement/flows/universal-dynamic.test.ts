import { describe, expect, test } from "vitest";
import { UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW } from "./loader";
import { isKnownWorkflowId, resolveFlow } from "./registry";

describe("universal-dynamic flow config", () => {
  test("has dynamicHarness flag", () => {
    expect(UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.dynamicHarness).toBe(true);
  });

  test("has artifactEventsPath", () => {
    expect(UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.artifactEventsPath).toBe(
      "analysis/{reqId}/events/artifact-events.jsonl",
    );
  });

  test("includes dyn-* agent stages (dyn-review is subagent, not stage)", () => {
    const stages = UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.stages;
    expect(stages.map((s) => s.id)).toEqual([
      "dyn-orchestrator",
      "dyn-spec",
      "dyn-ui",
      "dyn-build",
    ]);
  });

  test("injects dyn-* agents", () => {
    const agents = UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.sessionAgentNames;
    expect(agents).toContain("dyn-orchestrator");
    expect(agents).toContain("dyn-spec");
    expect(agents).toContain("dyn-build");
    expect(agents).toContain("dyn-review");
    expect(agents).toContain("dyn-ui");
    expect(agents).toContain("dyn-cdp-automation");
  });

  test("uses workspaceRoot as projectDir", () => {
    expect(UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.projectDir).toBe(
      UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.workspaceRoot,
    );
  });

  test("does NOT set hideStageBar", () => {
    expect(UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.hideStageBar).toBeUndefined();
  });

  test("stages have artifactKind", () => {
    const stages = UNIVERSAL_DYNAMIC_REQUIREMENT_FLOW.stages;
    expect(stages.every((s) => s.artifactKind)).toBe(true);
  });
});

describe("registry resolves universal-dynamic", () => {
  test("isKnownWorkflowId", () => {
    expect(isKnownWorkflowId("universal-dynamic")).toBe(true);
  });

  test("resolveFlow returns universal-dynamic flow", () => {
    const flow = resolveFlow({ workflowId: "universal-dynamic" });
    expect(flow.dynamicHarness).toBe(true);
    expect(flow.stages.find((s) => s.id === "dyn-build")).toBeDefined();
  });

  test("resolveFlow with reqId replaces placeholders", () => {
    const flow = resolveFlow({
      workflowId: "universal-dynamic",
      reqId: "REQ-42",
    });
    expect(flow.stages[1]!.artifactPath).toBe("analysis/REQ-42/spec/spec.md");
    expect(flow.artifactEventsPath).toBe(
      "analysis/REQ-42/events/artifact-events.jsonl",
    );
  });
});
