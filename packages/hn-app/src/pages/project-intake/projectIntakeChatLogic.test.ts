import { describe, expect, test } from "vitest";
import { isSyntheticTextOnlyParts } from "./projectIntakeChatLogic";

describe("project intake chat logic", () => {
  test("treats only non-empty synthetic text-only parts as hidden user content", () => {
    expect(
      isSyntheticTextOnlyParts([
        { type: "text", synthetic: true },
        { type: "text", synthetic: true },
      ]),
    ).toBe(true);

    expect(isSyntheticTextOnlyParts(undefined)).toBe(false);
    expect(isSyntheticTextOnlyParts([])).toBe(false);
    expect(
      isSyntheticTextOnlyParts([
        { type: "text", synthetic: true },
        { type: "text", synthetic: false },
      ]),
    ).toBe(false);
    expect(
      isSyntheticTextOnlyParts([
        { type: "text", synthetic: true },
        { type: "file", synthetic: true },
      ]),
    ).toBe(false);
  });
});
