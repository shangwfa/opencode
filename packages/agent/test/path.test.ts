import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { PathMapper } from "../src/path"

const root = mkdtempSync(join(tmpdir(), "agent-path-test-"))
const other = mkdtempSync(join(tmpdir(), "agent-other-"))
const mapper = new PathMapper(root)
const ses = mapper.forSession("ses_abc123")
ses.ensure()

beforeAll(() => {
  writeFileSync(join(ses.dir, "file.txt"), "hello")
  mkdirSync(join(ses.dir, "sub"), { recursive: true })
  writeFileSync(join(other, "secret.txt"), "secret")
})

describe("SessionMapper 隔离与穿越防护", () => {
  test("合法路径映射到会话目录", () => {
    expect(ses.toReal("/workspace")).toBe(ses.dir)
    expect(ses.toReal("/workspace/file.txt")).toBe(join(ses.dir, "file.txt"))
    expect(ses.toReal("file.txt")).toBe(join(ses.dir, "file.txt"))
  })

  test("../ 穿越被拒绝", () => {
    expect(() => ses.toReal("/workspace/../ses_other/secret.txt")).toThrow()
    expect(() => ses.toReal("/workspace/../../etc/passwd")).toThrow()
  })

  test("workspace 外绝对路径被拒绝", () => {
    expect(() => ses.toReal("/etc/passwd")).toThrow()
    expect(() => ses.toReal(other)).toThrow()
  })

  test("不存在的文件路径：校验祖先目录后放行（write 场景）", () => {
    expect(ses.toReal("/workspace/sub/new.txt")).toBe(join(ses.dir, "sub", "new.txt"))
  })

  test("sessionID 白名单：非法字符拒绝", () => {
    expect(() => mapper.forSession("../escape")).toThrow()
    expect(() => mapper.forSession("ses/a")).toThrow()
    expect(() => mapper.forSession("")).toThrow()
  })

  test("命令重写：/workspace 前缀替换为会话目录", () => {
    expect(ses.rewriteCommand("cd /workspace && ls")).toBe(`cd ${ses.dir} && ls`)
  })
})
