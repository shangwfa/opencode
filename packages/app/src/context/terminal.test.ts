import { beforeAll, describe, expect, mock, test } from "bun:test"
import { ServerScope } from "@/utils/server-scope"

let getSessionTerminalCacheKey: typeof import("./terminal").getSessionTerminalCacheKey
let getLegacyTerminalStorageKeys: (dir: string, legacySessionID?: string) => string[]
let migrateTerminalState: (value: unknown) => unknown
let removeTerminalState: typeof import("./terminal").removeTerminalState

beforeAll(async () => {
  mock.module("@solidjs/router", () => ({
    useNavigate: () => () => undefined,
    useParams: () => ({}),
    useLocation: () => ({}),
    useSearchParams: () => [{}, () => undefined],
  }))
  mock.module("@opencode-ai/ui/context", () => ({
    createSimpleContext: () => ({
      use: () => undefined,
      provider: () => undefined,
    }),
  }))
  const mod = await import("./terminal")
  getSessionTerminalCacheKey = mod.getSessionTerminalCacheKey
  getLegacyTerminalStorageKeys = mod.getLegacyTerminalStorageKeys
  migrateTerminalState = mod.migrateTerminalState
  removeTerminalState = mod.removeTerminalState
})

describe("getSessionTerminalCacheKey", () => {
  test("includes the session in the directory cache key", () => {
    expect(String(getSessionTerminalCacheKey("/repo", "ses_123"))).toBe("local\u0000/repo\u0000ses_123")
  })

  test("can include a server scope", () => {
    expect(String(getSessionTerminalCacheKey("/repo", "ses_123", "ssh:debian" as ServerScope))).toBe(
      "ssh:debian\u0000/repo\u0000ses_123",
    )
  })
})

describe("getLegacyTerminalStorageKeys", () => {
  test("keeps workspace storage path when no legacy session id", () => {
    expect(getLegacyTerminalStorageKeys("/repo")).toEqual(["/repo/terminal.v1"])
  })

  test("only migrates the matching legacy session path", () => {
    expect(getLegacyTerminalStorageKeys("/repo", "session-123")).toEqual(["/repo/terminal/session-123.v1"])
  })
})

describe("migrateTerminalState", () => {
  test("drops invalid terminals and restores a valid active terminal", () => {
    expect(
      migrateTerminalState({
        active: "missing",
        all: [
          null,
          { id: "one", title: "Terminal 2" },
          { id: "one", title: "duplicate", titleNumber: 9 },
          { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
          { title: "no-id" },
        ],
      }),
    ).toEqual({
      active: "one",
      all: [
        { id: "one", title: "Terminal 2", titleNumber: 2 },
        { id: "two", title: "logs", titleNumber: 4, rows: 24, cols: 80 },
      ],
    })
  })

  test("keeps a valid active id", () => {
    expect(
      migrateTerminalState({
        active: "two",
        all: [
          { id: "one", title: "Terminal 1" },
          { id: "two", title: "shell", titleNumber: 7 },
        ],
      }),
    ).toEqual({
      active: "two",
      all: [
        { id: "one", title: "Terminal 1", titleNumber: 1 },
        { id: "two", title: "shell", titleNumber: 7 },
      ],
    })
  })
})

describe("removeTerminalState", () => {
  const all = [
    { id: "one", title: "one", titleNumber: 1 },
    { id: "two", title: "two", titleNumber: 2 },
  ]

  test("removes exited or deleted terminals and selects the next tab", () => {
    expect(removeTerminalState(all, "one", "one")).toEqual({ all: [all[1]], active: "two" })
    expect(removeTerminalState(all, "two", "two")).toEqual({ all: [all[0]], active: "one" })
  })

  test("is idempotent for at-least-once terminal events", () => {
    expect(removeTerminalState(all, "one", "missing")).toEqual({ all, active: "one" })
  })
})
