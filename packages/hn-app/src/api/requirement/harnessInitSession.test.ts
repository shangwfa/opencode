import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  fetchHarnessInitSessionJobBySession,
  postHarnessInitSession,
} from "./harnessInitSession";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    clone() {
      return this;
    },
    headers: {
      get: () => "application/json",
    },
  } as unknown as Response;
}

function mockResponseWithStatus(body: unknown, status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    clone() {
      return this;
    },
    headers: {
      get: () => "application/json",
    },
  } as unknown as Response;
}

function postedBody(): Record<string, unknown> {
  const init = mockFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
}

describe("postHarnessInitSession", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("YD", { BOSS_API_URL: "https://boss.example.com" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    (globalThis as { YD?: unknown }).YD = undefined;
  });

  test("posts summaryFrom to init-session", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ sessionId: "ses_new", reqId: "req_new" })
    );

    await postHarnessInitSession({
      agents: ["specer"],
      title: " 复制会话 ",
      target_gitlab: " group/repo ",
      base_branch: " main ",
      creator_uuid: "-",
      creator_nick_name: "-",
      summaryFrom: " ses_source ",
    });

    expect(mockFetch).toHaveBeenCalledWith(
      "https://boss.example.com/boss/api/v3/harness/opencode/init-session",
      expect.objectContaining({ method: "POST" })
    );
    expect(postedBody()).toEqual(
      expect.objectContaining({
        summaryFrom: "ses_source",
        title: "复制会话",
        target_gitlab: "group/repo",
        base_branch: "main",
      })
    );
  });

  test("omits blank summaryFrom and false useExistingBranch", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ sessionId: "ses_new", reqId: "req_new" })
    );

    await postHarnessInitSession({
      agents: ["specer"],
      title: "需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      creator_uuid: "-",
      creator_nick_name: "-",
      summaryFrom: " ",
      useExistingBranch: false,
    });

    expect(postedBody()).not.toHaveProperty("summaryFrom");
    expect(postedBody()).not.toHaveProperty("useExistingBranch");
  });

  test("posts useExistingBranch only when true", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ sessionId: "ses_new", reqId: "req_new" })
    );

    await postHarnessInitSession({
      agents: ["specer"],
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "feature/req_source",
      creator_uuid: "-",
      creator_nick_name: "-",
      summaryFrom: "ses_source",
      useExistingBranch: true,
    });

    expect(postedBody()).toEqual(
      expect.objectContaining({
        summaryFrom: "ses_source",
        base_branch: "feature/req_source",
        useExistingBranch: true,
      })
    );
  });

  test("posts syncSession to init-session", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ sessionId: "ses_new", reqId: "req_new" })
    );

    await postHarnessInitSession({
      agents: ["specer"],
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      creator_uuid: "-",
      creator_nick_name: "-",
      summaryFrom: "ses_source",
      syncSession: {
        sourceSessionId: " ses_source ",
        syncDiffFiles: true,
        syncArtifacts: true,
      },
    });

    expect(postedBody()).toEqual(
      expect.objectContaining({
        summaryFrom: "ses_source",
        syncSession: {
          sourceSessionId: "ses_source",
          syncDiffFiles: true,
          syncArtifacts: true,
        },
      })
    );
  });

  test("omits syncSession when sourceSessionId is blank", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ sessionId: "ses_new", reqId: "req_new" })
    );

    await postHarnessInitSession({
      agents: ["specer"],
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      creator_uuid: "-",
      creator_nick_name: "-",
      syncSession: {
        sourceSessionId: " ",
        syncDiffFiles: true,
        syncArtifacts: true,
      },
    });

    expect(postedBody()).not.toHaveProperty("syncSession");
  });

  test("forces syncSession syncDiffFiles to true", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({ sessionId: "ses_new", reqId: "req_new" })
    );

    await postHarnessInitSession({
      agents: ["specer"],
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      creator_uuid: "-",
      creator_nick_name: "-",
      syncSession: {
        sourceSessionId: "ses_source",
        syncDiffFiles: false,
        syncArtifacts: false,
      },
    });

    expect(postedBody().syncSession).toEqual({
      sourceSessionId: "ses_source",
      syncDiffFiles: true,
      syncArtifacts: false,
    });
  });
});

describe("fetchHarnessInitSessionJobBySession", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    vi.stubGlobal("YD", { BOSS_API_URL: "https://boss.example.com" });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    (globalThis as { YD?: unknown }).YD = undefined;
  });

  test("loads latest init-session job by session and normalizes syncWarning", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        job_id: "job_1",
        status: "success",
        result: {
          syncWarning: {
            type: "sync_session_partial_failed",
            message: "会话已创建，但部分工作文件同步失败",
            errorsCount: 2,
            errors: [{ path: "a.ts" }],
          },
        },
      }),
    );

    const job = await fetchHarnessInitSessionJobBySession(" ses_new ");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://boss.example.com/boss/api/v3/harness/opencode/init-session/jobs/by-session/ses_new",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(job).toEqual({
      job_id: "job_1",
      status: "success",
      result: {
        syncWarning: {
          type: "sync_session_partial_failed",
          message: "会话已创建，但部分工作文件同步失败",
          errorsCount: 2,
          errors: [{ path: "a.ts" }],
        },
      },
    });
  });

  test("keeps success result without syncWarning when absent", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponse({
        job_id: "job_1",
        status: "success",
        result: { sessionId: "ses_new" },
      }),
    );

    const job = await fetchHarnessInitSessionJobBySession("ses_new");

    expect(job).toEqual({
      job_id: "job_1",
      status: "success",
      result: { sessionId: "ses_new" },
    });
  });

  test("returns null when no init-session job exists for session", async () => {
    mockFetch.mockResolvedValueOnce(
      mockResponseWithStatus({ error: "任务不存在或已过期" }, 404),
    );

    await expect(
      fetchHarnessInitSessionJobBySession("ses_old"),
    ).resolves.toBeNull();
  });
});
