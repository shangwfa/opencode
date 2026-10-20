import { afterEach, describe, expect, test, vi } from "vitest";
import {
  buildSandboxFileDownloadUrl,
  buildSandboxFileCreateUrl,
  buildSandboxMkdirUrl,
  createSandboxFile,
  downloadSandboxFileBlob,
  mkdirSandboxPath,
  removeSandboxFile,
  resolveSandboxPath,
} from "./sandbox-file";

const DIRECTORY = "/workspace/worktrees/sid";

function makeFetch(opts: {
  status?: number;
  body?: unknown;
}): { fetch: typeof globalThis.fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const status = opts.status ?? 200;
    const raw = JSON.stringify(opts.body ?? {});
    return new Response(raw, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveSandboxPath", () => {
  test("joins relative path with directory", () => {
    expect(resolveSandboxPath(DIRECTORY, "src/app.ts")).toBe(`${DIRECTORY}/src/app.ts`);
  });
  test("returns absolute path unchanged", () => {
    expect(resolveSandboxPath(DIRECTORY, "/workspace/other/app.ts")).toBe("/workspace/other/app.ts");
  });
  test("strips trailing slash from directory", () => {
    expect(resolveSandboxPath(`${DIRECTORY}/`, "app.ts")).toBe(`${DIRECTORY}/app.ts`);
  });
  test("passes through Windows-style absolute paths", () => {
    expect(resolveSandboxPath(DIRECTORY, "C:/Users/x/app.ts")).toBe("C:/Users/x/app.ts");
  });
});

describe("buildSandboxFileCreateUrl", () => {
  test("relative path joins directory", () => {
    const url = buildSandboxFileCreateUrl({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "src/app.ts",
    });
    expect(url).toContain(`/session/sid-1/files/create`);
    expect(url).toContain(`path=${encodeURIComponent(`${DIRECTORY}/src/app.ts`)}`);
  });

  test("absolute path passes through without joining", () => {
    const url = buildSandboxFileCreateUrl({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "/workspace/other/app.ts",
    });
    expect(url).toContain(`path=${encodeURIComponent("/workspace/other/app.ts")}`);
  });

  test("trims and encodes sessionID in path segment", () => {
    const url = buildSandboxFileCreateUrl({
      sessionID: " sid with spaces ",
      directory: DIRECTORY,
      path: "a.ts",
    });
    expect(url).toContain(`/session/${encodeURIComponent("sid with spaces")}/files/create`);
  });
});

describe("buildSandboxFileDownloadUrl", () => {
  test("omits cache bust query by default", () => {
    const url = new URL(buildSandboxFileDownloadUrl({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "src/app.ts",
    }));
    expect(url.searchParams.get("path")).toBe(`${DIRECTORY}/src/app.ts`);
    expect(url.searchParams.has("_t")).toBe(false);
  });

  test("adds cache bust query when requested", () => {
    const url = new URL(buildSandboxFileDownloadUrl({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "src/app.ts",
      cacheBust: 123,
    }));
    expect(url.searchParams.get("_t")).toBe("123");
  });
});

describe("downloadSandboxFileBlob", () => {
  test("reports sandbox syncing when download sandbox is unavailable", async () => {
    const { fetch } = makeFetch({
      status: 502,
      body: { error: "sandbox unavailable" },
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      downloadSandboxFileBlob({
        sessionID: "sid-1",
        directory: DIRECTORY,
        path: "output/a.txt",
      }),
    ).rejects.toThrow("沙箱正在同步内容，请稍后重试");
  });

  test("keeps original error for non-sandbox-unavailable download failures", async () => {
    const { fetch } = makeFetch({
      status: 502,
      body: { error: "bad gateway" },
    });
    vi.stubGlobal("fetch", fetch);

    await expect(
      downloadSandboxFileBlob({
        sessionID: "sid-1",
        directory: DIRECTORY,
        path: "output/a.txt",
      }),
    ).rejects.toThrow("下载沙箱文件失败: 502");
  });
});

describe("buildSandboxMkdirUrl", () => {
  test("relative path joins directory", () => {
    const url = buildSandboxMkdirUrl({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "src/utils",
    });
    expect(url).toContain(`/session/sid-1/files/mkdir`);
    expect(url).toContain(`path=${encodeURIComponent(`${DIRECTORY}/src/utils`)}`);
  });

  test("strips trailing slash from directory before joining", () => {
    const url = buildSandboxMkdirUrl({
      sessionID: "sid-1",
      directory: `${DIRECTORY}/`,
      path: "src/utils",
    });
    expect(url).toContain(`path=${encodeURIComponent(`${DIRECTORY}/src/utils`)}`);
  });
});

describe("createSandboxFile", () => {
  test("POSTs string body and parses response", async () => {
    const { fetch, calls } = makeFetch({
      body: {
        sessionID: "sid-1",
        path: `${DIRECTORY}/app.py`,
        size: 14,
        created: true,
      },
    });
    vi.stubGlobal("fetch", fetch);

    const result = await createSandboxFile({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "app.py",
      content: 'print("hello")',
    });

    expect(result).toEqual({ path: `${DIRECTORY}/app.py`, size: 14, created: true });
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.body).toBe('print("hello")');
  });

  test("forwards binary Blob body untouched", async () => {
    const { fetch, calls } = makeFetch({
      body: { sessionID: "sid-1", path: `${DIRECTORY}/data.bin`, size: 4, created: true },
    });
    vi.stubGlobal("fetch", fetch);

    const blob = new Blob([new Uint8Array([0, 1, 2, 3])]);
    await createSandboxFile({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "data.bin",
      content: blob,
    });

    expect(calls[0].init?.body).toBe(blob);
  });

  test("throws on non-ok with status and error", async () => {
    const { fetch } = makeFetch({ status: 502, body: { error: "not a directory" } });
    vi.stubGlobal("fetch", fetch);

    await expect(
      createSandboxFile({
        sessionID: "sid-1",
        directory: DIRECTORY,
        path: "afile",
        content: "x",
      }),
    ).rejects.toThrow("创建沙箱文件失败: 502");
  });
});

describe("mkdirSandboxPath", () => {
  test("POSTs without body and parses response", async () => {
    const { fetch, calls } = makeFetch({
      body: { sessionID: "sid-1", path: `${DIRECTORY}/src/utils`, created: true },
    });
    vi.stubGlobal("fetch", fetch);

    const result = await mkdirSandboxPath({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "src/utils",
    });

    expect(result).toEqual({ path: `${DIRECTORY}/src/utils`, created: true });
    expect(calls[0].init?.method).toBe("POST");
  });

  test("throws on non-ok (missing path -> 400)", async () => {
    const { fetch } = makeFetch({ status: 400 });
    vi.stubGlobal("fetch", fetch);

    await expect(
      mkdirSandboxPath({ sessionID: "sid-1", directory: DIRECTORY, path: "" }),
    ).rejects.toThrow("创建沙箱目录失败: 400");
  });
});

describe("removeSandboxFile", () => {
  test("POSTs and parses file removal response", async () => {
    const { fetch, calls } = makeFetch({
      body: {
        sessionID: "sid-1",
        path: `${DIRECTORY}/delete-me.txt`,
        removed: true,
        type: "file",
      },
    });
    vi.stubGlobal("fetch", fetch);

    const result = await removeSandboxFile({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "delete-me.txt",
    });

    expect(result).toEqual({
      path: `${DIRECTORY}/delete-me.txt`,
      removed: true,
      type: "file",
    });
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].url).toContain(`/session/sid-1/files/remove`);
    expect(calls[0].url).toContain(`path=${encodeURIComponent(`${DIRECTORY}/delete-me.txt`)}`);
  });

  test("resolves relative path against directory", async () => {
    const { fetch, calls } = makeFetch({
      body: { sessionID: "sid-1", path: `${DIRECTORY}/sub/a.txt`, removed: true, type: "file" },
    });
    vi.stubGlobal("fetch", fetch);

    await removeSandboxFile({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "sub/a.txt",
    });

    expect(calls[0].url).toContain(`path=${encodeURIComponent(`${DIRECTORY}/sub/a.txt`)}`);
  });

  test("parses directory removal (recursive)", async () => {
    const { fetch } = makeFetch({
      body: { sessionID: "sid-1", path: `${DIRECTORY}/rmdir`, removed: true, type: "directory" },
    });
    vi.stubGlobal("fetch", fetch);

    const result = await removeSandboxFile({
      sessionID: "sid-1",
      directory: DIRECTORY,
      path: "rmdir",
    });

    expect(result.type).toBe("directory");
    expect(result.removed).toBe(true);
  });

  test("throws on non-ok (not found -> 404)", async () => {
    const { fetch } = makeFetch({ status: 404 });
    vi.stubGlobal("fetch", fetch);

    await expect(
      removeSandboxFile({ sessionID: "sid-1", directory: DIRECTORY, path: "no-such" }),
    ).rejects.toThrow("删除沙箱文件失败: 404");
  });
});
