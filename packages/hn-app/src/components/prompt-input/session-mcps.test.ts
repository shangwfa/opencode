import { describe, expect, test, vi } from "vitest"
import {
  countEnabledSessionMcps,
  fetchSessionMcps,
  toDisplaySessionMcps,
  type SessionMcp,
} from "./session-mcps"

describe("session MCPs", () => {
  test("loads session MCPs from the raw opencode endpoint", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => [
        {
          name: "search-api",
          type: "remote",
          url: "https://search.example.com/mcp",
          headers: { Authorization: "Bearer token" },
          enabled: true,
          time_created: 1,
          time_updated: 2,
        },
      ],
    })) as unknown as typeof fetch

    const result = await fetchSessionMcps({
      baseUrl: "https://test-opencode.shadow-rpa.net/",
      sessionId: "ses_1",
      fetcher,
    })

    expect(fetcher).toHaveBeenCalledWith("https://test-opencode.shadow-rpa.net/session/ses_1/mcps")
    expect(result).toEqual([
      {
        name: "search-api",
        type: "remote",
        url: "https://search.example.com/mcp",
        headers: { Authorization: "Bearer token" },
        enabled: true,
        time_created: 1,
        time_updated: 2,
      },
    ])
  })

  test("treats 200 empty array as no session MCPs", async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      json: async () => [],
    })) as unknown as typeof fetch

    await expect(fetchSessionMcps({ baseUrl: "http://localhost:4096", sessionId: "missing", fetcher })).resolves.toEqual(
      [],
    )
  })

  test("throws on failed fetch so callers can keep cached display", async () => {
    const fetcher = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => [],
    })) as unknown as typeof fetch

    await expect(fetchSessionMcps({ baseUrl: "http://localhost:4096", sessionId: "ses_1", fetcher })).rejects.toThrow(
      "Failed to load session MCPs (500)",
    )
  })

  test("normalizes session MCPs into sorted display rows", () => {
    const sessionMcps: SessionMcp[] = [
      { name: " search-api ", type: "remote", url: "https://search.example.com/mcp", enabled: true },
      { name: "sandbox-everything", type: "local", command: ["npx", "-y", "server"], enabled: false },
      { name: "search-api", type: "remote", url: "https://latest.example.com/mcp", enabled: false },
    ]

    const result = toDisplaySessionMcps(sessionMcps, {
      "search-api": "Search documents through the remote MCP service.",
    })

    expect(result).toEqual([
      {
        name: "sandbox-everything",
        type: "local",
        status: "disabled",
        detail: "npx -y server",
        session: sessionMcps[1],
      },
      {
        name: "search-api",
        type: "remote",
        description: "Search documents through the remote MCP service.",
        status: "disabled",
        detail: "https://latest.example.com/mcp",
        session: sessionMcps[2],
      },
    ])
    expect(countEnabledSessionMcps(result)).toBe(0)
  })

  test("keeps MCP display rows separate from slash command triggers", () => {
    const rows = toDisplaySessionMcps(
      [{ name: "search-api", type: "remote", url: "https://search.example.com/mcp", enabled: true }],
      { "search-api": "Search documents through the remote MCP service." },
    )

    expect(rows[0]?.name).toBe("search-api")
    expect(rows[0]?.description).toBe("Search documents through the remote MCP service.")
  })
})
