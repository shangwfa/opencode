import { describe, expect, test } from "vitest";
import {
  ARTIFACT_GENERATION_CONTEXT_PREFIX,
  buildArtifactGenerationContext,
  attachArtifactCausedByMessageId,
  parseArtifactCausedByMessageId,
  parseArtifactGenerationMode,
} from "./artifact-generation-context";

describe("artifact generation context", () => {
  test.each(["concise", "detailed"] as const)(
    "round-trips %s mode through a hidden text part",
    (mode) => {
      expect(
        parseArtifactGenerationMode([
          {
            type: "text",
            synthetic: true,
            text: buildArtifactGenerationContext(mode),
          },
        ]),
      ).toBe(mode);
    },
  );

  test("attaches and parses the user message id without changing the mode", () => {
    const text = attachArtifactCausedByMessageId(
      buildArtifactGenerationContext("detailed"),
      "msg_current",
    );
    const parts = [{ type: "text", synthetic: true, text }];
    expect(parseArtifactGenerationMode(parts)).toBe("detailed");
    expect(parseArtifactCausedByMessageId(parts)).toBe("msg_current");
    expect(attachArtifactCausedByMessageId(text, "msg_replaced")).toContain(
      "artifactCausedByMessageId: msg_replaced",
    );
  });

  test("ignores visible or malformed context", () => {
    expect(
      parseArtifactGenerationMode([
        {
          type: "text",
          text: `${ARTIFACT_GENERATION_CONTEXT_PREFIX}\nartifactGenerationMode: detailed`,
        },
        {
          type: "text",
          synthetic: true,
          text: `${ARTIFACT_GENERATION_CONTEXT_PREFIX}\nartifactGenerationMode: both`,
        },
      ]),
    ).toBeUndefined();
  });
});
