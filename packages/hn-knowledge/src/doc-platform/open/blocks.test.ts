import { describe, expect, it } from "bun:test";
import {
  findTopLevelBlock,
  materializeTopLevelBlockIds,
  replaceTopLevelBlock,
} from "./blocks";

const document = {
  type: "doc" as const,
  content: [
    { type: "heading", attrs: { level: 1 }, content: [] },
    { type: "paragraph", content: [{ type: "text", text: "正文" }] },
  ],
};

describe("top-level blocks", () => {
  it("generates stable compatibility ids for historical documents", () => {
    const first = materializeTopLevelBlockIds(document, { seed: "demo:doc-1" });
    const second = materializeTopLevelBlockIds(document, {
      seed: "demo:doc-1",
    });

    expect(first).toEqual(second);
    expect(first.content[0]).toMatchObject({
      attrs: { blockId: expect.stringMatching(/^blk_/) },
    });
  });

  it("preserves valid unique ids and repairs duplicates", () => {
    const duplicate = {
      type: "doc" as const,
      content: [
        { type: "paragraph", attrs: { blockId: "blk_123456789abc" } },
        { type: "paragraph", attrs: { blockId: "blk_123456789abc" } },
      ],
    };
    const result = materializeTopLevelBlockIds(duplicate, { seed: "doc-1" });

    expect(result.content[0]).toMatchObject({
      attrs: { blockId: "blk_123456789abc" },
    });
    expect(result.content[1]).not.toMatchObject({
      attrs: { blockId: "blk_123456789abc" },
    });
  });

  it("finds and replaces a block while retaining its type and id", () => {
    const content = materializeTopLevelBlockIds(document, { seed: "doc-1" });
    const blockId = (content.content[1] as { attrs: { blockId: string } }).attrs
      .blockId;
    const result = replaceTopLevelBlock(content, blockId, {
      type: "paragraph",
      content: [{ type: "text", text: "新正文" }],
    });

    expect(findTopLevelBlock(result.content, blockId).block).toMatchObject({
      type: "paragraph",
      attrs: { blockId },
      content: [{ type: "text", text: "新正文" }],
    });
  });

  it("rejects changing the block type", () => {
    const content = materializeTopLevelBlockIds(document, { seed: "doc-1" });
    const blockId = (content.content[1] as { attrs: { blockId: string } }).attrs
      .blockId;

    expect(() =>
      replaceTopLevelBlock(content, blockId, { type: "heading", content: [] }),
    ).toThrow("不允许修改节点类型");
  });
});
