import { describe, expect, test, vi } from "vitest";
import { DEFAULT_REQUIREMENT_FLOW } from "./flows";
import { createStageMachine } from "./stage-machine";
import type { SuggestStepData } from "./stage-runtime";

const stages = DEFAULT_REQUIREMENT_FLOW.stages;

describe("createStageMachine", () => {
  test("refreshes suggest-step on every auto-detect artifact sync", async () => {
    const oldSuggestStep: SuggestStepData = {
      currentAgent: "reviewer",
      suggestStep: "builder",
      status: "ready",
      reason: "old review finding",
      updatedAt: "2026-06-10T00:00:00Z",
    };
    const newSuggestStep: SuggestStepData = {
      currentAgent: "reviewer",
      suggestStep: "builder",
      status: "ready",
      reason: "new review finding",
      updatedAt: "2026-06-11T00:00:00Z",
    };
    const reviewIndex = stages.findIndex((stage) => stage.id === "code-review");
    const reviewStage = stages[reviewIndex]!;
    const fetchArtifact = vi.fn(async () => ({
      stage: reviewStage.id,
      path: reviewStage.artifactPath,
      content: "# review",
    }));
    const fetchSuggestStep = vi.fn(async () => newSuggestStep);
    const machine = createStageMachine({
      stages: () => stages,
      flow: DEFAULT_REQUIREMENT_FLOW,
      fetchArtifact,
      fetchSuggestStep,
    });

    machine.hydrate(reviewIndex);
    machine.setState({ suggestStep: oldSuggestStep });

    await machine.syncArtifact(reviewIndex, { quiet: true });

    expect(fetchSuggestStep).toHaveBeenCalledTimes(1);
    expect(machine.getState().suggestStep?.updatedAt).toBe(newSuggestStep.updatedAt);
    expect(machine.getState().suggestStep?.reason).toBe(newSuggestStep.reason);
  });
});
