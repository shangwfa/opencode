import { describe, expect, test } from "bun:test"
import { toSandboxPath } from "@/tool/sandbox-path"
import { Session } from "@/session/session"

const HOST_WORKTREE = "/home/opencode/repos/myproject"
const SANDBOX_WORKDIR = "/workspace"

describe("API path mapping", () => {
  describe("getPath handler mapping", () => {
    test("home/state/config should equal worktree (mapped)", () => {
      const wt = toSandboxPath(HOST_WORKTREE, HOST_WORKTREE)
      const getPathResponse = {
        home: wt,
        state: wt,
        config: wt,
        worktree: wt,
        directory: toSandboxPath(HOST_WORKTREE, HOST_WORKTREE),
      }
      for (const field of ["home", "state", "config", "worktree", "directory"] as const) {
        expect(getPathResponse[field]).not.toContain("/home/opencode")
        expect(getPathResponse[field]).toBe(SANDBOX_WORKDIR)
      }
    })

    test("worktree === '/' skips mapping", () => {
      const worktree = "/"
      const getPathResponse = {
        home: worktree,
        state: worktree,
        config: worktree,
        worktree: worktree,
        directory: toSandboxPath("/some/dir", "/some/dir"),
      }
      expect(getPathResponse.home).toBe("/")
      expect(getPathResponse.worktree).toBe("/")
    })

    test("subdirectory is correctly mapped", () => {
      const result = toSandboxPath(`${HOST_WORKTREE}/src/foo`, HOST_WORKTREE)
      expect(result).toBe(`${SANDBOX_WORKDIR}/src/foo`)
      expect(result).not.toContain("/home/opencode")
    })
  })

  describe("Session.Info mapping", () => {
    const mapSession = <T extends Session.Info>(s: T, wt: string): T => {
      if (wt === "/") return s
      return { ...s, directory: toSandboxPath(s.directory, wt) }
    }

    test("directory is mapped for session with host worktree", () => {
      const session = {
        id: "session-1",
        directory: HOST_WORKTREE,
      } as Session.Info
      const mapped = mapSession(session, HOST_WORKTREE)
      expect(mapped.directory).toBe(SANDBOX_WORKDIR)
      expect(mapped.directory).not.toContain("/home/opencode")
    })

    test("directory is not mapped when worktree is /", () => {
      const session = {
        id: "session-1",
        directory: "/some/path",
      } as Session.Info
      const mapped = mapSession(session, "/")
      expect(mapped.directory).toBe("/some/path")
    })

    test("subdirectory in session is mapped", () => {
      const session = {
        id: "session-1",
        directory: `${HOST_WORKTREE}/packages/app`,
      } as Session.Info
      const mapped = mapSession(session, HOST_WORKTREE)
      expect(mapped.directory).toBe(`${SANDBOX_WORKDIR}/packages/app`)
    })
  })

  describe("Project worktree mapping", () => {
    const mapProjectWorktree = <T extends { worktree: string }>(p: T, hostWorktree: string): T => {
      if (hostWorktree === "/") return p
      return { ...p, worktree: toSandboxPath(p.worktree, hostWorktree) }
    }

    test("project worktree is mapped", () => {
      const project = { id: "proj-1", worktree: HOST_WORKTREE }
      const mapped = mapProjectWorktree(project, HOST_WORKTREE)
      expect(mapped.worktree).toBe(SANDBOX_WORKDIR)
      expect(mapped.worktree).not.toContain("/home/opencode")
    })

    test("project worktree is not mapped when hostWorktree is /", () => {
      const project = { id: "proj-1", worktree: "/some/path" }
      const mapped = mapProjectWorktree(project, "/")
      expect(mapped.worktree).toBe("/some/path")
    })
  })

  describe("SSE event data mapping", () => {
    const mapEventData = (data: unknown, worktree: string): unknown => {
      if (!worktree || worktree === "/" || !data || typeof data !== "object") return data
      const d = data as Record<string, unknown>
      if (d.info && typeof d.info === "object") {
        const info = { ...(d.info as Record<string, unknown>) }
        if (typeof info.directory === "string") {
          info.directory = toSandboxPath(info.directory, worktree)
        }
        return { ...d, info }
      }
      return data
    }

    test("session.created event directory is mapped", () => {
      const event = {
        info: {
          id: "session-1",
          directory: HOST_WORKTREE,
          title: "Test",
        },
      }
      const mapped = mapEventData(event, HOST_WORKTREE)
      expect((mapped as any).info.directory).toBe(SANDBOX_WORKDIR)
    })

    test("session.updated event directory is mapped", () => {
      const event = {
        info: {
          directory: `${HOST_WORKTREE}/src`,
        },
      }
      const mapped = mapEventData(event, HOST_WORKTREE)
      expect((mapped as any).info.directory).toBe(`${SANDBOX_WORKDIR}/src`)
    })

    test("event without info is not modified", () => {
      const event = { type: "server.connected" }
      const mapped = mapEventData(event, HOST_WORKTREE)
      expect(mapped).toEqual(event)
    })

    test("event with null info is not modified", () => {
      const event = { info: null }
      const mapped = mapEventData(event, HOST_WORKTREE)
      expect(mapped).toEqual(event)
    })

    test("worktree === '/' skips mapping", () => {
      const event = {
        info: {
          directory: "/some/path",
        },
      }
      const mapped = mapEventData(event, "/")
      expect((mapped as any).info.directory).toBe("/some/path")
    })
  })

  describe("GlobalInfo mapping", () => {
    test("directory and project.worktree are both mapped", () => {
      const sessions = [
        {
          id: "s1",
          directory: HOST_WORKTREE,
          project: { id: "p1", worktree: HOST_WORKTREE },
        },
        {
          id: "s2",
          directory: `${HOST_WORKTREE}/packages/app`,
          project: { id: "p1", worktree: HOST_WORKTREE },
        },
      ]

      const mapped = sessions.map((s: any) => {
        const wt = s.project?.worktree
        if (!wt || wt === "/") return s
        return {
          ...s,
          directory: toSandboxPath(s.directory, wt),
          project: s.project ? { ...s.project, worktree: toSandboxPath(wt, wt) } : s.project,
        }
      })

      expect(mapped[0].directory).toBe(SANDBOX_WORKDIR)
      expect(mapped[0].project.worktree).toBe(SANDBOX_WORKDIR)
      expect(mapped[1].directory).toBe(`${SANDBOX_WORKDIR}/packages/app`)
      expect(mapped[1].project.worktree).toBe(SANDBOX_WORKDIR)

      for (const s of mapped) {
        expect(JSON.stringify(s)).not.toContain("/home/opencode")
      }
    })
  })
})
