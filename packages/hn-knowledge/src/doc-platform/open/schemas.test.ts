import { describe, expect, it } from "bun:test";
import {
  CreateDocumentInputSchema,
  CreateResourceUploadInputSchema,
  GetBlockInputSchema,
  UpdateBlockInputSchema,
  UpdateDocumentInputSchema,
} from "./schemas";

const scope = { kb: "rpa" };
const content = { type: "doc" as const, content: [] };

describe("book open schemas", () => {
  it("accepts a publish document request", () => {
    expect(() =>
      CreateDocumentInputSchema.parse({
        ...scope,
        name: "快速开始",
        content,
        publishMode: "publish",
      }),
    ).not.toThrow();
  });

  it("requires publishMode when updating content", () => {
    const result = UpdateDocumentInputSchema.safeParse({
      ...scope,
      docUniqueId: "doc-1",
      content,
    });
    expect(result.success).toBe(false);
  });

  it("enforces the current 20MB image limit", () => {
    const result = CreateResourceUploadInputSchema.safeParse({
      ...scope,
      fileName: "demo.png",
      fileSize: 20 * 1024 * 1024 + 1,
      contentType: "image/png",
      resourceKind: "image",
    });
    expect(result.success).toBe(false);
  });

  it("accepts block reads and block update requests", () => {
    expect(() =>
      GetBlockInputSchema.parse({
        ...scope,
        docUniqueId: "doc-1",
        blockId: "blk_123456789abc",
      }),
    ).not.toThrow();
    expect(() =>
      UpdateBlockInputSchema.parse({
        ...scope,
        docUniqueId: "doc-1",
        blockId: "blk_123456789abc",
        publishMode: "publish",
        block: { type: "paragraph", content: [] },
      }),
    ).not.toThrow();
  });

  it("rejects inline nodes and invalid block ids", () => {
    const result = UpdateBlockInputSchema.safeParse({
      ...scope,
      docUniqueId: "doc-1",
      blockId: "bad id",
      publishMode: "publish",
      block: { type: "text", text: "not a block" },
    });
    expect(result.success).toBe(false);
  });
});
