import { describe, expect, test } from "vitest";
import { artifactMarkdownFromResponse } from "./artifact-pipeline";

describe("artifactMarkdownFromResponse", () => {
  test("plain markdown", () => {
    expect(artifactMarkdownFromResponse("# Title\n\nbody")).toBe(
      "# Title\n\nbody",
    );
  });

  test("FileContent JSON", () => {
    const raw = JSON.stringify({
      type: "text",
      content: "# Hello\n\nworld",
    });
    expect(artifactMarkdownFromResponse(raw)).toBe("# Hello\n\nworld");
  });

  test("empty body", () => {
    expect(artifactMarkdownFromResponse("   ")).toBeUndefined();
  });
});
