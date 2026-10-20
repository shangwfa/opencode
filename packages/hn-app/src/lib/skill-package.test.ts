import { expect, test } from "vitest"
import { decodeSkillFile, parseSkillPackage, resourceType, validateSkillPackage, type SkillDraft } from "./skill-package"

const valid = (): SkillDraft => ({ id: "review", name: "审查", description: "交付前使用", autoinvoke: true, content: "阅读 references/guide.md", resources: [{ path: "references/guide.md", type: "doc", content: "说明" }, { path: "scripts/check.py", type: "script", content: "print('ok')" }] })

test("复杂技能包完整 JSON 往返不丢资源或策略", () => {
  expect(parseSkillPackage(JSON.stringify(valid()))).toEqual(valid())
})
test("拒绝接口未支持的运行配置，避免假保存", () => {
  expect(() => parseSkillPackage(JSON.stringify({ ...valid(), "allowed-tools": ["read"] }))).toThrow("不支持字段")
})
test("拒绝路径穿越、绝对路径、保留名称和空目录段", () => {
  for (const path of ["../private", "/etc/passwd", "a/../b", "a\\b", "a//b", "./a", "SKILL.md", "resources.json", "SKILL.md/a", "a\0b"]) {
    expect(() => validateSkillPackage({ ...valid(), resources: [{ path, type: "doc", content: "" }] })).toThrow()
  }
})
test("拒绝重复路径及文件目录冲突", () => {
  expect(() => validateSkillPackage({ ...valid(), resources: [valid().resources[0], valid().resources[0]] })).toThrow("重复")
  expect(() => validateSkillPackage({ ...valid(), resources: [{ path: "docs", type: "doc", content: "" }, { path: "docs/a.md", type: "doc", content: "" }] })).toThrow("冲突")
})
test("按 UTF-8 字节校验正文、资源、总量和数量", () => {
  expect(() => validateSkillPackage({ ...valid(), content: "中".repeat(90000) })).toThrow("正文")
  expect(() => validateSkillPackage({ ...valid(), resources: [{ path: "a", type: "doc", content: "中".repeat(90000) }] })).toThrow("256 KiB")
  expect(() => validateSkillPackage({ ...valid(), resources: Array.from({ length: 5 }, (_, i) => ({ path: `a${i}`, type: "doc", content: "a".repeat(256 * 1024) })) })).toThrow("1 MiB")
  expect(() => validateSkillPackage({ ...valid(), resources: Array.from({ length: 65 }, (_, i) => ({ path: `a${i}`, type: "doc", content: "" })) })).toThrow("64")
})
test("拒绝非法 JSON、资源结构和策略类型", () => {
  for (const value of [null, [], { ...valid(), autoinvoke: "false" }, { ...valid(), resources: [null] }, { ...valid(), resources: [{ path: "a", type: "image", content: "x" }] }]) expect(() => parseSkillPackage(JSON.stringify(value))).toThrow()
})
test("类型按资源目录及扩展名推断，可在编辑器修改", () => {
  expect(resourceType("scripts/check.py")).toBe("script")
  expect(resourceType("templates/form.tsx")).toBe("template")
  expect(resourceType("templates/service.ts")).toBe("template")
  expect(resourceType("references/guide.md")).toBe("doc")
  expect(resourceType("assets/data.csv")).toBe("asset")
})
test("导入仅接受 UTF-8 文本，拒绝二进制及超长文件", () => {
  expect(decodeSkillFile(new TextEncoder().encode("中文脚本"), "a.md")).toBe("中文脚本")
  expect(() => decodeSkillFile(new Uint8Array([255, 254]), "a.png")).toThrow("UTF-8")
  expect(() => decodeSkillFile(new Uint8Array([0, 1]), "a.bin")).toThrow("UTF-8")
  expect(() => decodeSkillFile(new Uint8Array(256 * 1024 + 1), "a.txt")).toThrow("256 KiB")
})
