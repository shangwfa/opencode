import { describe, expect, test } from "bun:test"
import { emptyHarness, parseHarness, readHarness, sealHarness } from "./harness.js"

describe("应用 Harness", () => {
  test("未配置时使用内置 build", () => {
    expect(readHarness(null)).toEqual(emptyHarness())
    expect(parseHarness(emptyHarness()).agent).toBe("build")
  })
  test("加密保存并完整还原，不明文存储认证头", () => {
    const config = parseHarness({ ...emptyHarness(), mcps: [{ name: "docs", config: { type: "remote", url: "https://example.com/mcp", oauth: false, headers: { Authorization: "test-private-token" } } }] })
    const stored = sealHarness(config)
    expect(JSON.stringify(stored)).not.toContain("test-private-token")
    expect(readHarness({ harness: stored })).toEqual(config)
  })
  test("拒绝重复 Agent、子 Agent 默认与非法 URL", () => {
    const agent = { id: "reviewer", config: { mode: "subagent" } }
    expect(() => parseHarness({ ...emptyHarness(), agents: [agent, agent] })).toThrow()
    expect(() => parseHarness({ ...emptyHarness(), agent: "reviewer", agents: [agent] })).toThrow()
    expect(() => parseHarness({ ...emptyHarness(), mcps: [{ name: "docs", config: { type: "remote", url: "file:///etc/passwd", oauth: false } }] })).toThrow()
  })
  test("拒绝非法契约与超长正文", () => {
    expect(() => parseHarness({ agents: [] })).toThrow()
    expect(() => parseHarness({ ...emptyHarness(), agentsMd: "中".repeat(90000) })).toThrow()
  })
  test("拒绝所有定义中的空标识", () => {
    for (const id of ["", " ", "\n\t"]) {
      expect(() => parseHarness({ ...emptyHarness(), agents: [{ id, config: {} }] })).toThrow("不能为空")
      expect(() => parseHarness({ ...emptyHarness(), skills: [{ id, content: "指令" }] })).toThrow("不能为空")
      expect(() => parseHarness({ ...emptyHarness(), commands: [{ name: id, template: "指令" }] })).toThrow("不能为空")
    }
  })
  test("保存边界拒绝资源路径穿越、保留路径、重复和目录冲突", () => {
    const parse = (paths: string[]) => parseHarness({ ...emptyHarness(), skills: [{ id: "test", content: "指令", resources: paths.map((path) => ({ path, type: "doc", content: "" })) }] })
    for (const path of ["", "../private", "/etc/passwd", "a/../b", "a\\b", "a//b", "./a", "SKILL.md", "SKILL.md/a", "resources.json", "resources.json/a", "a\0b"]) expect(() => parse([path])).toThrow()
    expect(() => parse(["a.md", "a.md"])).toThrow("重复")
    expect(() => parse(["docs", "docs/guide.md"])).toThrow("冲突")
    expect(() => parse(["references/guide.md", "scripts/check.py"])).not.toThrow()
  })
  test("资源字节数、数量、总量与命令模板上限在保存时校验", () => {
    const skill = (resources: { path: string; type: "doc"; content: string }[]) => ({ ...emptyHarness(), skills: [{ id: "test", content: "指令", resources }] })
    expect(() => parseHarness(skill([{ path: "a", type: "doc", content: "中".repeat(90000) }]))).toThrow("256 KiB")
    expect(() => parseHarness(skill(Array.from({ length: 65 }, (_, i) => ({ path: `a${i}`, type: "doc", content: "" }))))).toThrow("64")
    expect(() => parseHarness(skill(Array.from({ length: 5 }, (_, i) => ({ path: `a${i}`, type: "doc", content: "a".repeat(256 * 1024) }))))).toThrow("1 MiB")
    expect(() => parseHarness(skill(Array.from({ length: 4 }, (_, i) => ({ path: `a${i}`, type: "doc", content: "a".repeat(256 * 1024) }))))).not.toThrow()
    expect(() => parseHarness({ ...emptyHarness(), commands: [{ name: "test", template: "中".repeat(90000) }] })).toThrow("256 KiB")
    expect(() => parseHarness({ ...emptyHarness(), commands: [{ name: "test", template: "a".repeat(256 * 1024) }] })).not.toThrow()
  })
})
