import { describe, expect, test } from "vitest";
import { joinEntryPath, parentDirOf, validateEntryName } from "./entry-path";

describe("parentDirOf", () => {
  test("returns parent of a nested path", () => {
    expect(parentDirOf("src/utils/helper.ts")).toBe("src/utils");
  });
  test("returns parent of a top-level file", () => {
    expect(parentDirOf("app.ts")).toBe("");
  });
  test("returns parent of a single-segment dir", () => {
    expect(parentDirOf("src/sub")).toBe("src");
  });
});

describe("joinEntryPath", () => {
  test("joins baseDir and name", () => {
    expect(joinEntryPath("src/utils", "new.ts")).toBe("src/utils/new.ts");
  });
  test("returns name when baseDir is empty", () => {
    expect(joinEntryPath("", "new.ts")).toBe("new.ts");
  });
  test("strips trailing slash from baseDir", () => {
    expect(joinEntryPath("src/utils/", "new.ts")).toBe("src/utils/new.ts");
  });
  test("trims name whitespace", () => {
    expect(joinEntryPath("src", "  new.ts  ")).toBe("src/new.ts");
  });
});

describe("validateEntryName", () => {
  test("passes valid relative paths", () => {
    expect(validateEntryName("src/new.ts")).toBeUndefined();
    expect(validateEntryName("new.ts")).toBeUndefined();
    expect(validateEntryName("src/a/b/c.ts")).toBeUndefined();
    expect(validateEntryName("测试 文档.txt")).toBeUndefined();
  });
  test("rejects empty", () => {
    expect(validateEntryName("")).toBe("路径不能为空");
    expect(validateEntryName("   ")).toBe("路径不能为空");
  });
  test("rejects absolute paths", () => {
    expect(validateEntryName("/src/new.ts")).toMatch(/相对路径/);
  });
  test("rejects traversal segments", () => {
    expect(validateEntryName("../escape")).toMatch(/\. 或 \.\./);
    expect(validateEntryName("src/./x")).toMatch(/\. 或 \.\./);
    expect(validateEntryName("..")).toMatch(/\. 或 \.\./);
  });
  test("rejects empty segments (double slash)", () => {
    expect(validateEntryName("src//x")).toBe("路径不能含空段");
    expect(validateEntryName("src/")).toBe("路径不能含空段");
  });
});
