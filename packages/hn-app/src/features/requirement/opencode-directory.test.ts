import { describe, expect, test, vi, afterEach } from "vitest";

describe("opencode-directory", () => {
  afterEach(() => {
    (globalThis as any).YD = undefined;
    vi.resetModules();
  });

  test("defaults to /workspace", async () => {
    (globalThis as any).YD = undefined;
    const mod = await import("./opencode-directory");
    expect(mod.OPENCODE_DIRECTORY).toBe("/workspace");
    expect(mod.OPENCODE_DIRECTORY_ROUTE_SLUG).toBe("L3dvcmtzcGFjZQ");
  });

  test("reads window.YD.OPENCODE_DIRECTORY", async () => {
    (globalThis as any).YD = { OPENCODE_DIRECTORY: "/custom/root" };
    const mod = await import("./opencode-directory");
    expect(mod.OPENCODE_DIRECTORY).toBe("/custom/root");
  });
});
