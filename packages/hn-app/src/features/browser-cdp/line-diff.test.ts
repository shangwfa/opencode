import { describe, expect, it } from "vitest";
import { computeLineDiff } from "./line-diff";

describe("computeLineDiff", () => {
  it("完全一致 → equal=true，无增删", () => {
    const r = computeLineDiff("a\nb\nc\n", "a\nb\nc");
    expect(r.equal).toBe(true);
    expect(r.added).toBe(0);
    expect(r.removed).toBe(0);
  });

  it("结尾换行差异视为一致", () => {
    const r = computeLineDiff("a\nb\n", "a\nb");
    expect(r.equal).toBe(true);
  });

  it("中间修改 → 删旧行 + 增新行，上下文保留", () => {
    const r = computeLineDiff("a\nold\nb\n", "a\nnew\nb\n");
    expect(r.equal).toBe(false);
    expect(r.removed).toBe(1);
    expect(r.added).toBe(1);
    const del = r.rows.find((row) => row.type === "del");
    const add = r.rows.find((row) => row.type === "add");
    expect(del?.text).toBe("old");
    expect(add?.text).toBe("new");
    expect(r.rows[0]).toEqual({ type: "ctx", text: "a" });
    expect(r.rows[r.rows.length - 1]).toEqual({ type: "ctx", text: "b" });
  });

  it("纯新增行", () => {
    const r = computeLineDiff("a\n", "a\nb\n");
    expect(r.added).toBe(1);
    expect(r.removed).toBe(0);
  });

  it("纯删除行", () => {
    const r = computeLineDiff("a\nb\n", "a\n");
    expect(r.added).toBe(0);
    expect(r.removed).toBe(1);
  });

  it("空文件 vs 有内容", () => {
    const r = computeLineDiff("", "a\nb\n");
    expect(r.removed).toBe(0);
    expect(r.added).toBe(2);
  });

  it("超长文件降级：整体删+增，计数完整", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `old-${i}`).join("\n");
    const bigNew = Array.from({ length: 2000 }, (_, i) => `new-${i}`).join("\n");
    const r = computeLineDiff(big, bigNew);
    expect(r.equal).toBe(false);
    expect(r.removed).toBe(2000);
    expect(r.added).toBe(2000);
  });

  it("CRLF 与 LF 混合一致", () => {
    const r = computeLineDiff("a\r\nb\r\n", "a\nb\n");
    expect(r.equal).toBe(true);
  });
});
