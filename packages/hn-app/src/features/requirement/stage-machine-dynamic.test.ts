import { describe, expect, test, vi } from "vitest";
import { DEFAULT_REQUIREMENT_FLOW } from "./flows";
import { createStageMachine } from "./stage-machine";
import type { SuggestStepData } from "./stage-runtime";

const stages = DEFAULT_REQUIREMENT_FLOW.stages;

function makeMachine(opts?: {
  fetchSuggestStep?: () => Promise<SuggestStepData | null>;
}) {
  return createStageMachine({
    stages: () => stages,
    flow: DEFAULT_REQUIREMENT_FLOW,
    fetchArtifact: vi.fn(async (index: number) => ({
      stage: stages[index]!.id,
      path: stages[index]!.artifactPath,
      content: "# content",
    })),
    fetchSuggestStep:
      opts?.fetchSuggestStep ?? vi.fn(async () => null),
  });
}

describe("switchStageById", () => {
  test("switches to existing stage id (forward)", () => {
    const machine = makeMachine();
    machine.hydrate(0);

    const result = machine.switchStageById("plan");
    expect(result.advanced).toBe(true);
    expect(result.advanced && result.plan.next.id).toBe("plan");
    expect(machine.getState().workingIndex).toBe(1);
  });

  test("switches to existing stage id (backward)", () => {
    const machine = makeMachine();
    machine.hydrate(2);

    const result = machine.switchStageById("requirement-discussion");
    expect(result.advanced).toBe(true);
    expect(machine.getState().workingIndex).toBe(0);
  });

  test("returns advanced:false for nonexistent stage id", () => {
    const machine = makeMachine();
    machine.hydrate(0);

    const result = machine.switchStageById("no-such-stage");
    expect(result.advanced).toBe(false);
    expect(machine.getState().workingIndex).toBe(0);
  });

  test("returns advanced:false for blank id", () => {
    const machine = makeMachine();
    machine.hydrate(0);

    const result = machine.switchStageById("");
    expect(result.advanced).toBe(false);
  });

  test("returns advanced:false when target equals current", () => {
    const machine = makeMachine();
    machine.hydrate(1);

    const result = machine.switchStageById("plan");
    expect(result.advanced).toBe(false);
  });
});
