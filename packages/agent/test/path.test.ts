import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

  test("命令重写：/workspace-old、/workspace2 等伪前缀不被替换", () => {
    expect(ses.rewriteCommand("echo /workspace-old /workspace2")).toBe("echo /workspace-old /workspace2")
    expect(ses.rewriteCommand("ls /workspace/src")).toBe(`ls ${ses.dir}/src`)
  })

  test("命令重写：workdir 含空格时加引号防拆词", () => {
    const spaced = mkdtempSync(join(tmpdir(), "agent path test "))
    const spacedMapper = new PathMapper(spaced)
    const spacedSes = spacedMapper.forSession("ses_spaced")
    spacedSes.ensure()
    const rewritten = spacedSes.rewriteCommand("cd /workspace && ls")
    expect(rewritten).toBe(`cd "${spacedSes.dir}" && ls`)
  })

  test("symlink 劫持 session 目录被拒绝（L2.2）", () => {
    mkdirSync(join(root, "sessions"), { recursive: true })
    symlinkSync("/etc", join(root, "sessions", "ses_hijack"))
    expect(() => mapper.forSession("ses_hijack")).toThrow(/escapes sandbox root/)
  })

  test("--cwd 自身是 symlink（如 macOS /tmp）时合法工作", () => {
    const root2 = mkdtempSync(join(tmpdir(), "agent-path-test2-"))
    mkdirSync(join(root2, "sessions"), { recursive: true })
    // 合法场景：用户通过 symlink 路径启动 --cwd，构造器 canonical 化后正常映射
    const mapper2 = new PathMapper(join(root2, "sessions"))
    const ses2 = mapper2.forSession("ses_ok")
    ses2.ensure()
    expect(ses2.toReal("/workspace")).toBe(ses2.dir)
    expect(() => ses2.toReal("/workspace/../ses_other/x")).toThrow()
  })

  test("session 内子目录 symlink 指向外部：toReal 拒绝", () => {
    symlinkSync(other, join(ses.dir, "escape"))
    expect(() => ses.toReal("/workspace/escape/secret.txt")).toThrow()
  })
})
