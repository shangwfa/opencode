import { describe, expect, test } from "vitest";

import {
  extractRequirementRepoLabel,
  isGitlabRouteRepo,
  isPreviewSupportedAppId,
  isRequirementHiddenFromList,
  normalizeRequirementAppId,
} from "./route-repo";

describe("route-repo", () => {
  test("extracts repo label from gitlab url", () => {
    expect(
      extractRequirementRepoLabel(
        "https://gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git",
      ),
    ).toBe("xybot-front-home-v3");
  });

  test("extracts repo label from namespace path", () => {
    expect(
      extractRequirementRepoLabel("frontend/xybot-front-home-v3"),
    ).toBe("xybot-front-home-v3");
  });

  test("keeps appId as route label", () => {
    expect(extractRequirementRepoLabel("xybot-front-homepage-v3")).toBe(
      "xybot-front-homepage-v3",
    );
  });

  test("recognizes gitlab route values", () => {
    expect(isGitlabRouteRepo("frontend/xybot-front-home-v3")).toBe(true);
    expect(
      isGitlabRouteRepo(
        "https://gitlab.shadow-rpa.net/frontend/xybot-front-home-v3.git",
      ),
    ).toBe(true);
    expect(isGitlabRouteRepo("xybot-front-homepage-v3")).toBe(false);
  });

  test("normalizes mapped appId alias", () => {
    expect(normalizeRequirementAppId("xybot-front-home-v3")).toBe(
      "xybot-front-homepage-v3",
    );
    expect(normalizeRequirementAppId("xybot-front-homepage-v3")).toBe(
      "xybot-front-homepage-v3",
    );
  });

  test("detects unsupported preview appId", () => {
    expect(isPreviewSupportedAppId("xybot-front-homepage-v3")).toBe(false);
    expect(isPreviewSupportedAppId("xybot-front-other")).toBe(true);
  });

  test("hides work-order requirements from collections regardless of repo format", () => {
    expect(isRequirementHiddenFromList("xybot-work-order")).toBe(true);
    expect(
      isRequirementHiddenFromList(
        "https://gitlab.shadow-rpa.net/frontend/xybot-work-order.git",
      ),
    ).toBe(true);
    expect(isRequirementHiddenFromList("xybot-front-homepage-v3")).toBe(false);
  });
});
