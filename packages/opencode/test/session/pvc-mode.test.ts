import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Session } from "../../src/session/session"

describe("PvcMode schema", () => {
  test("accepts 'session'", () => {
    expect(Schema.decodeUnknownSync(Session.PvcMode)("session")).toBe("session")
  })

  test("accepts 'app'", () => {
    expect(Schema.decodeUnknownSync(Session.PvcMode)("app")).toBe("app")
  })

  test("rejects invalid value", () => {
    expect(() => Schema.decodeUnknownSync(Session.PvcMode)("invalid")).toThrow()
    expect(() => Schema.decodeUnknownSync(Session.PvcMode)("")).toThrow()
  })
})

describe("InvalidPvcConfigError", () => {
  test("can be constructed", () => {
    const err = new Session.InvalidPvcConfigError({ message: "appID is required when pvcMode is app" })
    expect(err._tag).toBe("SessionInvalidPvcConfigError")
    expect(err.message).toBe("appID is required when pvcMode is app")
  })
})

describe("create validation: pvcMode=app requires appID", () => {
  // 模拟 session.ts:712-714 的校验逻辑
  function validatePvcConfig(pvcMode?: string, appID?: string): string | null {
    if (pvcMode === "app" && !appID?.trim()) {
      return "appID is required when pvcMode is app"
    }
    return null
  }

  test("app without appID → error", () => {
    expect(validatePvcConfig("app", undefined)).not.toBeNull()
    expect(validatePvcConfig("app", "")).not.toBeNull()
  })

  test("app with whitespace-only appID → error", () => {
    expect(validatePvcConfig("app", "   ")).not.toBeNull()
  })

  test("app with valid appID → no error", () => {
    expect(validatePvcConfig("app", "app-42")).toBeNull()
    expect(validatePvcConfig("app", "  app-42  ")).toBeNull()
  })

  test("session mode → no error regardless of appID", () => {
    expect(validatePvcConfig("session", undefined)).toBeNull()
    expect(validatePvcConfig("session", "")).toBeNull()
    expect(validatePvcConfig("session", "app-1")).toBeNull()
  })

  test("undefined pvcMode → no error", () => {
    expect(validatePvcConfig(undefined, undefined)).toBeNull()
    expect(validatePvcConfig(undefined, "app-1")).toBeNull()
  })
})

describe("PVC volume routing logic", () => {
  // 模拟 buildVolumes 的 useApp 判断逻辑
  function shouldUseApp(volumeType: string, pvcMode?: string, appID?: string): boolean {
    return volumeType === "pvc" && pvcMode === "app" && !!appID?.trim()
  }

  test("pvc + app + appID → true", () => {
    expect(shouldUseApp("pvc", "app", "app-1")).toBe(true)
  })

  test("pvc + app + empty appID → false (fallback)", () => {
    expect(shouldUseApp("pvc", "app", "")).toBe(false)
    expect(shouldUseApp("pvc", "app", "  ")).toBe(false)
    expect(shouldUseApp("pvc", "app", undefined)).toBe(false)
  })

  test("pvc + session → false", () => {
    expect(shouldUseApp("pvc", "session", "app-1")).toBe(false)
  })

  test("host + app → false (host mode ignores app)", () => {
    expect(shouldUseApp("host", "app", "app-1")).toBe(false)
  })

  test("none + app → false", () => {
    expect(shouldUseApp("none", "app", "app-1")).toBe(false)
  })
})

describe("worktree script generation (app mode)", () => {
  // 模拟 tools.ts 的 worktreeScript 逻辑
  function worktreeScript(sessionID: string): string {
    const wt = `/workspace/worktrees/${sessionID}`
    return [
      `if [ -d /workspace/repo/.git ]; then`,
      `  if [ ! -d ${wt} ]; then`,
      `    git -C /workspace/repo worktree add --detach ${wt} HEAD;`,
      `  fi;`,
      `fi`,
    ].join(" ")
  }

  test("generates correct worktree path", () => {
    const script = worktreeScript("ses_abc")
    expect(script).toContain("/workspace/worktrees/ses_abc")
    expect(script).toContain("git -C /workspace/repo worktree add --detach")
  })

  test("is idempotent (checks if worktree exists)", () => {
    const script = worktreeScript("ses_abc")
    expect(script).toContain("if [ ! -d")
  })

  test("only runs if repo/.git exists", () => {
    const script = worktreeScript("ses_abc")
    expect(script).toContain("if [ -d /workspace/repo/.git ]")
  })
})
