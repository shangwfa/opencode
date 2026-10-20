import { describe, expect, it, vi } from "vitest";
import {
  appendProductSuggestionFiles,
  filesFromProductSuggestionClipboard,
  removeProductSuggestionFile,
} from "./product-suggestion-attachments";

function file(name: string) {
  return new File(["hello"], name, { type: "text/plain" });
}

describe("product suggestion attachments", () => {
  it("appends incoming files without replacing existing files", () => {
    const existing = [file("a.txt")];
    const incoming = [file("b.txt"), file("c.txt")];

    expect(appendProductSuggestionFiles(existing, incoming).map((item) => item.name)).toEqual([
      "a.txt",
      "b.txt",
      "c.txt",
    ]);
  });

  it("removes only the selected file", () => {
    const files = [file("a.txt"), file("b.txt"), file("c.txt")];

    expect(removeProductSuggestionFile(files, 1).map((item) => item.name)).toEqual([
      "a.txt",
      "c.txt",
    ]);
  });

  it("reads file clipboard items", () => {
    const pasted = file("pasted.png");
    const event = {
      clipboardData: {
        items: [
          { kind: "string", getAsFile: vi.fn(() => null) },
          { kind: "file", getAsFile: vi.fn(() => pasted) },
        ],
      },
    } as unknown as ClipboardEvent;

    expect(filesFromProductSuggestionClipboard(event)).toEqual([pasted]);
  });

  it("ignores clipboard text without creating attachments", () => {
    const event = {
      clipboardData: {
        items: [{ kind: "string", getAsFile: vi.fn(() => null) }],
      },
    } as unknown as ClipboardEvent;

    expect(filesFromProductSuggestionClipboard(event)).toEqual([]);
  });
});
