import { describe, expect, it } from "bun:test";
import { inspectDocumentContent } from "./content";

describe("inspectDocumentContent", () => {
  it("extracts plain text and managed OSS resource paths", () => {
    const result = inspectDocumentContent({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
        { type: "image", attrs: { src: "/docs/assets/demo.png" } },
      ],
    });

    expect(result.plainTextContent).toBe("第一段");
    expect([...result.resourceRefs]).toEqual(["/docs/assets/demo.png"]);
    expect(result.byteLength).toBeGreaterThan(0);
  });

  it("rejects external resources", () => {
    expect(() =>
      inspectDocumentContent({
        type: "doc",
        content: [
          { type: "image", attrs: { src: "https://untrusted.example/a.png" } },
        ],
      }),
    ).toThrow("只允许使用 book-v3 OSS 相对路径");
  });

  it("rejects non-TipTap roots", () => {
    expect(() => inspectDocumentContent({ type: "html", content: [] })).toThrow(
      "TipTap JSON",
    );
  });
});
