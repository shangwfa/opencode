import { describe, expect, test } from "bun:test"
import { toSandboxPath, toHostPath, isSandboxPath, toSandboxCwd, SANDBOX_WORKDIR } from "../../src/tool/sandbox-path"

describe("toSandboxPath", () => {
  const workdir = "/home/opencode/project"

  describe("basic mapping", () => {
    test("maps workdir itself to /workspace", () => {
      expect(toSandboxPath(workdir, workdir)).toBe("/workspace")
    })

    test("maps subdirectory under workdir", () => {
      expect(toSandboxPath("/home/opencode/project/src", workdir)).toBe("/workspace/src")
    })

    test("maps deeply nested path", () => {
      expect(toSandboxPath("/home/opencode/project/a/b/c/d.ts", workdir)).toBe("/workspace/a/b/c/d.ts")
    })
  })

  describe("relative path inputs", () => {
    test('maps "." to /workspace', () => {
      expect(toSandboxPath(".", workdir)).toBe("/workspace")
    })

    test('maps "./" to /workspace/', () => {
      expect(toSandboxPath("./", workdir)).toBe("/workspace/")
    })

    test('maps "src/foo.ts" to /workspace/src/foo.ts', () => {
      expect(toSandboxPath("src/foo.ts", workdir)).toBe("/workspace/src/foo.ts")
    })

    test('maps "./src/foo.ts" to /workspace/src/foo.ts', () => {
      expect(toSandboxPath("./src/foo.ts", workdir)).toBe("/workspace/src/foo.ts")
    })

    test("maps empty string to /workspace", () => {
      expect(toSandboxPath("", workdir)).toBe("/workspace")
    })
  })

  describe("paths outside workdir", () => {
    test("preserves paths outside workdir", () => {
      expect(toSandboxPath("/usr/local/bin", workdir)).toBe("/usr/local/bin")
    })

    test("preserves sibling directory", () => {
      expect(toSandboxPath("/home/other/project", workdir)).toBe("/home/other/project")
    })

    test("preserves parent directory", () => {
      expect(toSandboxPath("/home/opencode", workdir)).toBe("/home/opencode")
    })

    test("handles partial prefix match without being workdir", () => {
      expect(toSandboxPath("/home/opencode/project-extra", workdir)).toBe("/home/opencode/project-extra")
    })
  })

  describe("trailing slash handling", () => {
    test("handles workdir with trailing slash", () => {
      expect(toSandboxPath("/home/opencode/project/src", "/home/opencode/project/")).toBe("/workspace/src")
    })

    test("maps workdir with trailing slash to /workspace/", () => {
      expect(toSandboxPath("/home/opencode/project/", "/home/opencode/project/")).toBe("/workspace/")
    })
  })

  describe("edge cases", () => {
    test("maps root path to itself when workdir is not root", () => {
      expect(toSandboxPath("/", workdir)).toBe("/")
    })

    test("handles workdir equal to path exactly", () => {
      const exact = "/exact/same"
      expect(toSandboxPath(exact, exact)).toBe("/workspace")
    })

    test("handles very long paths", () => {
      const deep = "/home/opencode/project/" + "subdir/".repeat(50) + "file.ts"
      expect(toSandboxPath(deep, workdir)).toBe("/workspace/" + "subdir/".repeat(50) + "file.ts")
    })

    test("handles path with spaces", () => {
      expect(toSandboxPath("/home/opencode/project/my project/file.ts", workdir)).toBe(
        "/workspace/my project/file.ts",
      )
    })

    test("handles path with unicode characters", () => {
      expect(toSandboxPath("/home/opencode/project/中文/文件.ts", workdir)).toBe("/workspace/中文/文件.ts")
    })
  })

  describe("realistic SaaS host paths", () => {
    test("maps /home/opencode to /workspace when workdir matches", () => {
      expect(toSandboxPath("/home/opencode", "/home/opencode")).toBe("/workspace")
    })

    test("maps /workspace to /workspace (identity when already sandbox path)", () => {
      expect(toSandboxPath("/workspace", "/workspace")).toBe("/workspace")
    })

    test("maps /workspace/src to /workspace/src", () => {
      expect(toSandboxPath("/workspace/src", "/workspace")).toBe("/workspace/src")
    })

    test("preserves nested sandbox path when workdir is inside /workspace", () => {
      expect(toSandboxPath("/workspace/app/src/App.tsx", "/workspace/app")).toBe("/workspace/app/src/App.tsx")
    })

    test("preserves subproject files from SaaS sessions", () => {
      const instanceDirectory = "/workspace/app"
      const paths = [
        "/workspace/app/package.json",
        "/workspace/app/index.html",
        "/workspace/app/src/App.tsx",
        "/workspace/app/src/App.css",
        "/workspace/app/src/index.css",
      ]

      for (const filePath of paths) {
        expect(toSandboxPath(filePath, instanceDirectory)).toBe(filePath)
      }
    })

    test("does not collapse nested sandbox workdir to workspace root", () => {
      expect(toSandboxCwd("/workspace/app", "/workspace/app")).toBe("/workspace/app")
      expect(toSandboxCwd("/workspace/app/src", "/workspace/app")).toBe("/workspace/app/src")
    })
  })
})

describe("toHostPath", () => {
  const workdir = "/home/opencode/project"

  describe("basic reverse mapping", () => {
    test("maps /workspace back to workdir", () => {
      expect(toHostPath("/workspace", workdir)).toBe("/home/opencode/project")
    })

    test("maps /workspace/src back to workdir/src", () => {
      expect(toHostPath("/workspace/src", workdir)).toBe("/home/opencode/project/src")
    })

    test("maps empty string to workdir", () => {
      expect(toHostPath("", workdir)).toBe("/home/opencode/project")
    })
  })

  describe("round-trip consistency", () => {
    const paths = [
      "/home/opencode/project",
      "/home/opencode/project/src/index.ts",
      "/home/opencode/project/deep/nested/path/file.ts",
    ]

    for (const p of paths) {
      test(`round-trips ${p}`, () => {
        const sandbox = toSandboxPath(p, workdir)
        const host = toHostPath(sandbox, workdir)
        expect(host).toBe(p)
      })
    }
  })

  describe("paths outside sandbox", () => {
    test("preserves paths that are not sandbox paths", () => {
      expect(toHostPath("/usr/local/bin", workdir)).toBe("/usr/local/bin")
    })

    test("preserves sandbox paths when host workdir is already inside /workspace", () => {
      expect(toHostPath("/workspace/app/src/App.tsx", "/workspace/app")).toBe("/workspace/app/src/App.tsx")
    })
  })
})

describe("isSandboxPath", () => {
  test("returns true for /workspace", () => {
    expect(isSandboxPath("/workspace")).toBe(true)
  })

  test("returns true for /workspace/foo", () => {
    expect(isSandboxPath("/workspace/foo")).toBe(true)
  })

  test("returns false for /home/opencode", () => {
    expect(isSandboxPath("/home/opencode")).toBe(false)
  })

  test("returns false for empty string", () => {
    expect(isSandboxPath("")).toBe(false)
  })

  test("returns false for paths that just start with /workspace string", () => {
    expect(isSandboxPath("/workspace-other")).toBe(false)
  })

  test("returns false for relative paths", () => {
    expect(isSandboxPath("workspace")).toBe(false)
  })
})

describe("toSandboxCwd", () => {
  const workdir = "/home/opencode/project"

  test("returns /workspace when undefined", () => {
    expect(toSandboxCwd(undefined, workdir)).toBe("/workspace")
  })

  test("returns /workspace when empty string", () => {
    expect(toSandboxCwd("", workdir)).toBe("/workspace")
  })

  test("maps a host subdirectory", () => {
    expect(toSandboxCwd("/home/opencode/project/src", workdir)).toBe("/workspace/src")
  })

  test("maps host workdir itself", () => {
    expect(toSandboxCwd(workdir, workdir)).toBe("/workspace")
  })

  test("preserves provided sandbox cwd", () => {
    expect(toSandboxCwd("/workspace/app", "/workspace/app")).toBe("/workspace/app")
  })
})

describe("SANDBOX_WORKDIR constant", () => {
  test("is /workspace", () => {
    expect(SANDBOX_WORKDIR).toBe("/workspace")
  })
})
