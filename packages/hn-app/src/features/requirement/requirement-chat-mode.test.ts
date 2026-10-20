import { describe, expect, test } from "vitest";
import {
  requirementChatPath,
  requirementDetailPath,
  requirementNotFound,
  requirementRecordingUploadsPath,
} from "./requirement-chat-mode";

describe("requirementNotFound", () => {
  test("matches Chinese 404 message", () => {
    expect(requirementNotFound(new Error("需求不存在或已删除"))).toBe(true);
  });
});

describe("requirementChatPath", () => {
  test("includes req and fresh", () => {
    const path = requirementChatPath({
      repo: "my-app",
      sessionId: "ses_1",
      reqId: "req-1",
      fresh: true,
    });
    expect(path).toContain("req=req-1");
    expect(path).toContain("fresh=1");
    expect(path).not.toContain("listRepo");
  });
});

describe("requirementDetailPath", () => {
  test("builds detail url", () => {
    expect(requirementDetailPath("app-a", "req-1")).toBe(
      "/requirements/app-a/requirement/req-1",
    );
  });
});

describe("requirementRecordingUploadsPath", () => {
  test("builds recording uploads url", () => {
    expect(
      requirementRecordingUploadsPath("xybot-front-opencode-ui", "req-1"),
    ).toBe(
      "/requirements/xybot-front-opencode-ui/requirement/req-1/recordings",
    );
  });

  test("encodes repo and requirement id", () => {
    expect(requirementRecordingUploadsPath("app/a b", "req/a b")).toBe(
      "/requirements/app%2Fa%20b/requirement/req%2Fa%20b/recordings",
    );
  });
});
