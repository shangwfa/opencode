import { beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_REQUIREMENT_FLOW } from "./flows";
import {
  createRequirementHarnessSession,
  harnessSessionRequest,
} from "./create-harness-session";

const mocks = vi.hoisted(() => ({
  postHarnessInitSession: vi.fn(),
  resolveAgentRegistryNames: vi.fn(),
}));

vi.mock("@/api/requirement/harnessInitSession", () => ({
  harnessInitSessionEnabled: vi.fn(() => true),
  postHarnessInitSession: mocks.postHarnessInitSession,
}));

vi.mock("@/api/agent-registry", () => ({
  resolveAgentRegistryNames: mocks.resolveAgentRegistryNames,
}));

beforeEach(() => {
  mocks.postHarnessInitSession.mockReset();
  mocks.resolveAgentRegistryNames.mockReset();
});

describe("harnessSessionRequest", () => {
  test("uses flow sessionAgentNames", () => {
    const body = harnessSessionRequest({
      title: "我的需求",
      target_gitlab: "group/repo",
      base_branch: "main",
    });
    expect(body.agents).toEqual([
      ...DEFAULT_REQUIREMENT_FLOW.sessionAgentNames,
    ]);
    expect(body.title).toBe("我的需求");
    expect(body.target_gitlab).toBe("group/repo");
    expect(body.base_branch).toBe("main");
    expect(body.creator_uuid).toBe("-");
    expect(body.creator_nick_name).toBe("-");
  });

  test("respects custom flow", () => {
    const flow = {
      ...DEFAULT_REQUIREMENT_FLOW,
      sessionAgentNames: ["alpha", "beta"] as const,
    };
    const body = harnessSessionRequest(
      {
        title: "t",
        target_gitlab: "g/r",
        base_branch: "dev",
        flow,
      },
      flow
    );
    expect(body.agents).toEqual(["alpha", "beta"]);
  });

  test("uses creator_uuid and creator_nick_name when provided", () => {
    const body = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      creator_uuid: "abc-123",
      creator_nick_name: "张三",
    });
    expect(body.creator_uuid).toBe("abc-123");
    expect(body.creator_nick_name).toBe("张三");
  });

  test("omits sandbox persistMode by default", () => {
    const body = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
    });
    expect(body).not.toHaveProperty("sandbox");
  });

  test("uses snapshot persistMode when enabled", () => {
    const body = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      sandboxPersistMode: "snapshot",
    });
    expect(body.sandbox).toEqual({ persistMode: "snapshot" });
  });

  test("passes sandbox image when provided", () => {
    const body = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      sandboxImage: " registry.example.com/ns/image:tag ",
    });
    expect(body.sandbox).toEqual({ image: "registry.example.com/ns/image:tag" });
  });

  test("ignores blank sandbox image", () => {
    const body = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      sandboxImage: "   ",
    });
    expect(body).not.toHaveProperty("sandbox");
  });

  test("combines snapshot persistMode with sandbox image", () => {
    const body = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      sandboxPersistMode: "snapshot",
      sandboxImage: "registry.example.com/ns/image:tag",
    });
    expect(body.sandbox).toEqual({
      persistMode: "snapshot",
      image: "registry.example.com/ns/image:tag",
    });
  });

  test("passes summaryFrom when deriving from an OpenCode session", () => {
    const body = harnessSessionRequest({
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      summaryFrom: " ses_abc ",
    });
    expect(body.summaryFrom).toBe("ses_abc");
  });

  test("omits blank summaryFrom", () => {
    const body = harnessSessionRequest({
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      summaryFrom: "   ",
    });
    expect(body).not.toHaveProperty("summaryFrom");
  });

  test("passes useExistingBranch only when true", () => {
    const defaultBody = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
    });
    expect(defaultBody).not.toHaveProperty("useExistingBranch");

    const reuseBody = harnessSessionRequest({
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "feature/req_1",
      useExistingBranch: true,
    });
    expect(reuseBody.useExistingBranch).toBe(true);
  });

  test("supports derived copy on the source working branch", () => {
    const body = harnessSessionRequest({
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "feature/req_1",
      summaryFrom: "ses_source",
      useExistingBranch: true,
    });
    expect(body).toEqual(
      expect.objectContaining({
        summaryFrom: "ses_source",
        base_branch: "feature/req_1",
        useExistingBranch: true,
      })
    );
  });

  test("passes syncSession when workspace file sync is enabled", () => {
    const body = harnessSessionRequest({
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      summaryFrom: "ses_source",
      syncSession: {
        sourceSessionId: " ses_source ",
        syncDiffFiles: true,
        syncArtifacts: true,
      },
    });
    expect(body.syncSession).toEqual({
      sourceSessionId: "ses_source",
      syncDiffFiles: true,
      syncArtifacts: true,
    });
  });

  test("omits syncSession when workspace file sync is disabled", () => {
    const body = harnessSessionRequest({
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      summaryFrom: "ses_source",
    });
    expect(body).not.toHaveProperty("syncSession");
  });

  test("forces syncSession syncDiffFiles to true", () => {
    const body = harnessSessionRequest({
      title: "复制会话",
      target_gitlab: "group/repo",
      base_branch: "main",
      syncSession: {
        sourceSessionId: "ses_source",
        syncDiffFiles: false,
        syncArtifacts: false,
      },
    });
    expect(body.syncSession).toEqual({
      sourceSessionId: "ses_source",
      syncDiffFiles: true,
      syncArtifacts: false,
    });
  });

  test("falls back to dash for empty creator fields", () => {
    const body = harnessSessionRequest({
      title: "测试需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      creator_uuid: "  ",
      creator_nick_name: "",
    });
    expect(body.creator_uuid).toBe("-");
    expect(body.creator_nick_name).toBe("-");
  });

  test("resolves project-configured registry agent ids before creating session", async () => {
    const flow = {
      ...DEFAULT_REQUIREMENT_FLOW,
      sessionAgentNames: [] as const,
    };
    mocks.resolveAgentRegistryNames.mockResolvedValue(["planner", "builder"]);
    mocks.postHarnessInitSession.mockResolvedValue({
      sessionId: "ses_1",
      reqId: "req_1",
    });

    await createRequirementHarnessSession({
      title: "自由模式需求",
      target_gitlab: "group/repo",
      base_branch: "main",
      flow,
      registryAgents: ["agent-id-1", "agent-id-2"],
    });

    expect(mocks.resolveAgentRegistryNames).toHaveBeenCalledWith([
      "agent-id-1",
      "agent-id-2",
    ]);
    expect(mocks.postHarnessInitSession).toHaveBeenCalledWith(
      expect.objectContaining({
        agents: ["planner", "builder"],
        agentSource: "registry",
      })
    );
  });

  test("does not resolve registry agents when project config has none", async () => {
    mocks.postHarnessInitSession.mockResolvedValue({
      sessionId: "ses_1",
      reqId: "req_1",
    });

    await createRequirementHarnessSession({
      title: "普通需求",
      target_gitlab: "group/repo",
      base_branch: "main",
    });

    expect(mocks.resolveAgentRegistryNames).not.toHaveBeenCalled();
    expect(mocks.postHarnessInitSession).toHaveBeenCalledWith(
      expect.not.objectContaining({
        agentSource: "registry",
      })
    );
  });
});
