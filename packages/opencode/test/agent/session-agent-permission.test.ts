import { test, expect, describe } from "bun:test"
import path from "path"
import { Permission } from "../../src/permission"
import { ConfigPermission } from "../../src/config/permission"
import { Effect } from "effect"

function fromConfig(permission: ConfigPermission.Info) {
  return Permission.fromConfig(permission)
}

describe("session-agent permission: worktree='/' 路径匹配", () => {
  // worktree="/" 时, write 工具传入 path.relative("/", "/workspace/analysis/xxx/spec/spec.md")
  // = "workspace/analysis/xxx/spec/spec.md"
  const worktreeRoot = "workspace/analysis/test-id/spec/spec.md"

  // worktree="/workspace" 时, path.relative("/workspace", "/workspace/analysis/xxx/spec/spec.md")
  // = "analysis/xxx/spec/spec.md"
  const worktreeWorkspace = "analysis/test-id/spec/spec.md"

  test("*analysis/ 前缀 — worktree=/ 匹配", () => {
    const ruleset = fromConfig({
      edit: { "*": "deny", "*analysis/test-id/spec/*.md": "allow" },
    } as ConfigPermission.Info)
    expect(Permission.evaluate("edit", worktreeRoot, ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", worktreeWorkspace, ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "src/index.tsx", ruleset).action).toBe("deny")
  })

  test("analysis/ 前缀（无 *） — worktree=/ 不匹配", () => {
    const ruleset = fromConfig({
      edit: { "*": "deny", "analysis/test-id/spec/*.md": "allow" },
    } as ConfigPermission.Info)
    expect(Permission.evaluate("edit", worktreeRoot, ruleset).action).toBe("deny")
    expect(Permission.evaluate("edit", worktreeWorkspace, ruleset).action).toBe("allow")
  })

  test("workspace/analysis/ 前缀 — 仅 worktree=/ 匹配", () => {
    const ruleset = fromConfig({
      edit: { "*": "deny", "workspace/analysis/test-id/spec/*.md": "allow" },
    } as ConfigPermission.Info)
    expect(Permission.evaluate("edit", worktreeRoot, ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", worktreeWorkspace, ruleset).action).toBe("deny")
  })

  test("**/analysis/ 前缀 — worktree=/ 匹配（** → .*.* 匹配 workspace/）", () => {
    const ruleset = fromConfig({
      edit: { "*": "deny", "**/analysis/test-id/spec/*.md": "allow" },
    } as ConfigPermission.Info)
    // ** → .*.*, 匹配 workspace 后接 /analysis/
    expect(Permission.evaluate("edit", worktreeRoot, ruleset).action).toBe("allow")
    // 但 **/ 不能匹配 analysis/...（无前导 /）
    expect(Permission.evaluate("edit", worktreeWorkspace, ruleset).action).toBe("deny")
  })

  test("对象语法完整 specer 配置 — *analysis/ 前缀", () => {
    const ruleset = fromConfig({
      read: "allow",
      edit: {
        "*": "deny",
        "*analysis/test-id/spec/*.md": "allow",
        "*analysis/test-id/suggest-step.json": "allow",
      },
      glob: "allow",
      grep: "allow",
      list: "allow",
      bash: "deny",
    } as ConfigPermission.Info)

    // worktree=/ 场景
    expect(Permission.evaluate("edit", "workspace/analysis/test-id/spec/spec.md", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "workspace/analysis/test-id/suggest-step.json", ruleset).action).toBe("allow")
    expect(Permission.evaluate("edit", "workspace/src/index.tsx", ruleset).action).toBe("deny")
    expect(Permission.evaluate("read", "workspace/src/index.tsx", ruleset).action).toBe("allow")
    expect(Permission.evaluate("bash", "ls", ruleset).action).toBe("deny")
  })
})

// 修复验证：文件工具权限 pattern 的基准从 worktree 改为 directory
// 见 write.ts:53 / edit.ts:81,137 / read.ts:54 / apply_patch.ts:225
describe("权限 pattern 基准 directory vs worktree (SaaS worktree=/)", () => {
  // SaaS 默认: directory=/workspace, worktree=/ (global project 无 git)
  const directory = "/workspace"
  const worktree = "/"
  const filepath = "/workspace/analysis/test-id/spec/spec.md"
  // 编排系统按工作目录下发的白名单（相对 directory，不带 workspace/ 前缀）
  const ruleset = fromConfig({
    edit: { "*": "deny", "analysis/test-id/spec/*.md": "allow" },
  } as ConfigPermission.Info)

  test("修复前(基准=worktree): input 带 workspace/ 前缀 → DENY", () => {
    const input = path.relative(worktree, filepath) // = workspace/analysis/test-id/spec/spec.md
    expect(input).toBe("workspace/analysis/test-id/spec/spec.md")
    expect(Permission.evaluate("edit", input, ruleset).action).toBe("deny")
  })

  test("修复后(基准=directory): input 无前缀 → ALLOW", () => {
    const input = path.relative(directory, filepath) // = analysis/test-id/spec/spec.md
    expect(input).toBe("analysis/test-id/spec/spec.md")
    expect(Permission.evaluate("edit", input, ruleset).action).toBe("allow")
  })

  test("本地 git 场景(directory==worktree): 行为不变", () => {
    // 本地非 SaaS: worktree=directory=仓库根，两者相同
    const localDir = "/repo"
    const localFile = "/repo/src/a.ts"
    const localRuleset = fromConfig({ edit: { "*": "deny", "src/*.ts": "allow" } } as ConfigPermission.Info)
    const inputDir = path.relative(localDir, localFile)
    const inputWt = path.relative(localDir, localFile) // worktree==directory
    expect(inputDir).toBe(inputWt)
    expect(Permission.evaluate("edit", inputDir, localRuleset).action).toBe("allow")
  })
})
