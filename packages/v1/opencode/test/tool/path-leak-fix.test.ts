import { describe, expect, test } from "bun:test"
import { toSandboxPath } from "../../src/tool/sandbox-path"
import path from "path"

describe("instance.ts getPath path mapping logic", () => {
  function computeGetPath(directory: string, worktree: string) {
    const wt = worktree === "/" ? "/" : toSandboxPath(worktree, worktree)
    return {
      worktree: wt,
      directory: toSandboxPath(directory, worktree === "/" ? directory : worktree),
    }
  }

  test("maps git project worktree and directory", () => {
    const result = computeGetPath("/home/opencode/project", "/home/opencode/project")
    expect(result.worktree).toBe("/workspace")
    expect(result.directory).toBe("/workspace")
  })

  test("maps directory as subdirectory of worktree", () => {
    const result = computeGetPath("/home/opencode/project/packages/app", "/home/opencode/project")
    expect(result.worktree).toBe("/workspace")
    expect(result.directory).toBe("/workspace/packages/app")
  })

  test("worktree='/' non-git project: keeps worktree as '/', directory mapped against itself", () => {
    const result = computeGetPath("/workspace", "/")
    expect(result.worktree).toBe("/")
    expect(result.directory).toBe("/workspace")
  })

  test("worktree='/' with subpath directory maps directory against itself", () => {
    const result = computeGetPath("/workspace/my-repo", "/")
    expect(result.worktree).toBe("/")
    expect(result.directory).toBe("/workspace/my-repo")
  })

  test("never leaks host path in worktree", () => {
    const result = computeGetPath("/home/user/secret-project", "/home/user/secret-project")
    expect(result.worktree).not.toContain("/home/user")
    expect(result.worktree).toBe("/workspace")
  })

  test("never leaks host path in directory", () => {
    const result = computeGetPath("/home/user/secret-project/src", "/home/user/secret-project")
    expect(result.directory).not.toContain("/home/user")
    expect(result.directory).toBe("/workspace/src")
  })

  test("identity when paths are already /workspace", () => {
    const result = computeGetPath("/workspace", "/workspace")
    expect(result.worktree).toBe("/workspace")
    expect(result.directory).toBe("/workspace")
  })

  test("/workspace subdirectory with /workspace worktree", () => {
    const result = computeGetPath("/workspace/repo", "/workspace/repo")
    expect(result.worktree).toBe("/workspace/repo")
    expect(result.directory).toBe("/workspace/repo")
  })
})

describe("file.ts absolute path mapping logic", () => {
  function computeFileEntry(directory: string, queryPath: string | undefined, entryName: string) {
    const filePath = queryPath ? `${queryPath}/${entryName}` : entryName
    const absHost = path.join(directory, filePath)
    return {
      name: entryName,
      path: filePath,
      absolute: toSandboxPath(absHost, directory),
    }
  }

  test("maps file entry absolute path", () => {
    const entry = computeFileEntry("/home/opencode/project", undefined, "src")
    expect(entry.absolute).toBe("/workspace/src")
  })

  test("maps file entry with query path prefix", () => {
    const entry = computeFileEntry("/home/opencode/project", "src", "index.ts")
    expect(entry.absolute).toBe("/workspace/src/index.ts")
  })

  test("never leaks host path in absolute field", () => {
    const entry = computeFileEntry("/home/user/secret-project", undefined, "file.ts")
    expect(entry.absolute).not.toContain("/home/user")
    expect(entry.absolute).toBe("/workspace/file.ts")
  })

  test("deeply nested file path", () => {
    const entry = computeFileEntry("/home/opencode/project", "a/b/c", "file.ts")
    expect(entry.absolute).toBe("/workspace/a/b/c/file.ts")
  })

  test("directory already /workspace", () => {
    const entry = computeFileEntry("/workspace", "src", "foo.ts")
    expect(entry.absolute).toBe("/workspace/src/foo.ts")
  })
})

describe("read.ts output path mapping logic", () => {
  function computeReadOutput(filepath: string, instanceDirectory: string) {
    const sandboxPath = toSandboxPath(filepath, instanceDirectory)
    return {
      pathTag: `<path>${sandboxPath}</path>`,
      errorNotFound: `File not found: ${sandboxPath}`,
    }
  }

  test("directory listing uses sandbox path in <path> tag", () => {
    const result = computeReadOutput("/home/opencode/project/src", "/home/opencode/project")
    expect(result.pathTag).toBe("<path>/workspace/src</path>")
    expect(result.pathTag).not.toContain("/home/opencode")
  })

  test("file content uses sandbox path in <path> tag", () => {
    const result = computeReadOutput("/home/opencode/project/src/index.ts", "/home/opencode/project")
    expect(result.pathTag).toBe("<path>/workspace/src/index.ts</path>")
  })

  test("error message uses sandbox path", () => {
    const result = computeReadOutput("/home/opencode/project/missing.ts", "/home/opencode/project")
    expect(result.errorNotFound).toBe("File not found: /workspace/missing.ts")
    expect(result.errorNotFound).not.toContain("/home/opencode")
  })

  test("deeply nested file path", () => {
    const result = computeReadOutput("/home/opencode/project/a/b/c/d.ts", "/home/opencode/project")
    expect(result.pathTag).toBe("<path>/workspace/a/b/c/d.ts</path>")
  })

  test("path already under /workspace", () => {
    const result = computeReadOutput("/workspace/src/foo.ts", "/workspace")
    expect(result.pathTag).toBe("<path>/workspace/src/foo.ts</path>")
  })
})

describe("edit.ts error message path safety", () => {
  test("error uses params.filePath (LLM input), not resolved host filePath", () => {
    const paramsFilePath = "/workspace/src/foo.ts"
    const error = `File ${paramsFilePath} not found`
    expect(error).not.toContain("/home/")
    expect(error).toContain("/workspace/src/foo.ts")
  })

  test("write error uses params.filePath", () => {
    const paramsFilePath = "/workspace/src/foo.ts"
    const error = `Failed to write file: ${paramsFilePath}`
    expect(error).not.toContain("/home/")
  })
})

describe("lsp.ts output path mapping logic", () => {
  function computeLspOutput(file: string, worktree: string, directory: string) {
    const displayPath = toSandboxPath(file, worktree === "/" ? directory : worktree)
    const resultJson = JSON.stringify({
      uri: `file://${file}`,
      range: { start: { line: 10 } },
      filePath: file,
    })
    const worktreeForReplace = worktree === "/" ? directory : worktree
    const mappedOutput = resultJson.replaceAll(worktreeForReplace, "/workspace")
    return { displayPath, errorNotFound: `File not found: ${displayPath}`, mappedOutput }
  }

  test("error message uses display path (sandbox)", () => {
    const result = computeLspOutput("/home/opencode/project/src/foo.ts", "/home/opencode/project", "/home/opencode/project")
    expect(result.errorNotFound).toBe("File not found: /workspace/src/foo.ts")
    expect(result.errorNotFound).not.toContain("/home/opencode")
  })

  test("LSP result JSON has host paths replaced", () => {
    const result = computeLspOutput("/home/opencode/project/src/foo.ts", "/home/opencode/project", "/home/opencode/project")
    expect(result.mappedOutput).not.toContain("/home/opencode")
    expect(result.mappedOutput).toContain("/workspace/src/foo.ts")
  })

  test("worktree='/' uses directory for mapping", () => {
    const result = computeLspOutput("/workspace/my-repo/src/foo.ts", "/", "/workspace/my-repo")
    expect(result.displayPath).toBe("/workspace/my-repo/src/foo.ts")
  })

  test("URI in LSP result is also mapped", () => {
    const result = computeLspOutput("/home/opencode/project/src/foo.ts", "/home/opencode/project", "/home/opencode/project")
    expect(result.mappedOutput).not.toContain("file:///home/")
    expect(result.mappedOutput).toContain("file:///workspace/")
  })
})
