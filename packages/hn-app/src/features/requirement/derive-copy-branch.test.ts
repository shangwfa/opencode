import { describe, expect, test } from "vitest";
import { resolveRequirementCopyBranch } from "./derive-copy-branch";

describe("resolveRequirementCopyBranch", () => {
  test("uses current branch when it exists on remote", () => {
    expect(
      resolveRequirementCopyBranch({
        currentBranch: "feature/req_1",
        baseBranch: "main",
        branches: [
          { name: "main", default: true },
          { name: "feature/req_1", default: false },
        ],
      })
    ).toBe("feature/req_1");
  });

  test("falls back to base branch when current branch is not pushed", () => {
    expect(
      resolveRequirementCopyBranch({
        currentBranch: "feature/req_1",
        baseBranch: "release",
        branches: [{ name: "main", default: true }],
      })
    ).toBe("release");
  });

  test("falls back to default or first remote branch when base branch is missing", () => {
    expect(
      resolveRequirementCopyBranch({
        currentBranch: "feature/req_1",
        branches: [
          { name: "dev", default: false },
          { name: "main", default: true },
        ],
      })
    ).toBe("main");

    expect(
      resolveRequirementCopyBranch({
        currentBranch: "feature/req_1",
        branches: [{ name: "dev", default: false }],
      })
    ).toBe("dev");
  });
});
