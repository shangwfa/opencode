import { beforeEach, describe, expect, test, vi } from "vitest";
import { resolveAgentRegistryNames } from "./client";

const mocks = vi.hoisted(() => ({
  requirementApiFetch: vi.fn(),
}));

vi.mock("@/api/requirement/client", () => ({
  requirementApiBase: "/api",
  requirementApiFetch: mocks.requirementApiFetch,
}));

function jsonResponse(status: number, body: unknown) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as unknown as Response;
}

describe("agent-registry client", () => {
  beforeEach(() => {
    mocks.requirementApiFetch.mockReset();
  });

  test("resolves project config refs by id and returns agent names", async () => {
    mocks.requirementApiFetch
      .mockResolvedValueOnce(jsonResponse(200, { id: "agent-id-1", name: "planner" }))
      .mockResolvedValueOnce(jsonResponse(200, { id: "agent-id-2", name: "builder" }));

    const names = await resolveAgentRegistryNames([" agent-id-1 ", "agent-id-2", "agent-id-1", " "]);

    expect(names).toEqual(["planner", "builder"]);
    expect(mocks.requirementApiFetch).toHaveBeenNthCalledWith(
      1,
      "/api/agent-registry/by-id/agent-id-1",
    );
    expect(mocks.requirementApiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/agent-registry/by-id/agent-id-2",
    );
  });

  test("falls back to legacy name lookup when id lookup misses", async () => {
    mocks.requirementApiFetch
      .mockResolvedValueOnce(jsonResponse(404, {}))
      .mockResolvedValueOnce(jsonResponse(200, { name: "legacy-agent" }));

    const names = await resolveAgentRegistryNames(["legacy-agent"]);

    expect(names).toEqual(["legacy-agent"]);
    expect(mocks.requirementApiFetch).toHaveBeenNthCalledWith(
      1,
      "/api/agent-registry/by-id/legacy-agent",
    );
    expect(mocks.requirementApiFetch).toHaveBeenNthCalledWith(
      2,
      "/api/agent-registry/legacy-agent",
    );
  });
});
