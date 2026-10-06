import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import {
  suites,
  casesFromDocument,
  bundle,
  assertSkillLoaded,
  assertPreparedSkill,
  assertParallelExecutions,
} from "./session-skills-specialized-v2.mjs"

const root = path.resolve(import.meta.dir, "../skills")
describe("专项技能验收计划", () => {
  test("PG时间线必须真实重叠，两个顺序子agent不能冒充并行", () => {
    const execution = (aggregate_id, created, type) => ({ aggregate_id, created, type: `session.execution.${type}` })
    expect(() =>
      assertParallelExecutions([
        execution("a", 1, "started"),
        execution("a", 3, "succeeded"),
        execution("b", 4, "started"),
        execution("b", 6, "succeeded"),
      ]),
    ).toThrow()
    expect(() =>
      assertParallelExecutions([
        execution("a", 1, "started"),
        execution("b", 2, "started"),
        execution("a", 3, "succeeded"),
        execution("b", 6, "succeeded"),
      ]),
    ).not.toThrow()
  })
  test("V2显式附件必须由PG完整正文证明，不能只凭模型回复", () => {
    expect(assertPreparedSkill({ skills: [{ id: "test", text: "完整正文" }] }, "test", "完整正文")).toBe("完整正文")
    expect(() => assertPreparedSkill({ skills: [{ id: "wrong", text: "完整正文" }] }, "test", "完整正文")).toThrow()
    expect(() => assertPreparedSkill({ skills: [{ id: "test", text: "摘要" }] }, "test", "完整正文")).toThrow()
  })
  test("humanize-ppt资源枚举与文档注册代码一致，SPEC不属于四类资源", () => {
    const b = bundle(path.join(root, "humanize-ppt"), "humanize-ppt")
    expect(b.resources.length).toBe(37)
    expect(b.resources.some((r) => r.path === "SPEC.md")).toBe(false)
  })
  test("9份文档102项用例均有唯一文档键和原始预期", () => {
    const entries = suites.flatMap(([doc, id]) =>
      casesFromDocument(readFileSync(path.join(root, doc), "utf8")).map((c) => ({ ...c, key: `${id}:${c.id}` })),
    )
    expect(entries.length).toBe(102)
    expect(new Set(entries.map((c) => c.key)).size).toBe(102)
    expect(entries.every((c) => c.original.includes(c.id))).toBe(true)
    // T51.4 是纯验收器步骤（分块上传固化源），不驱动模型，是唯一的无 prompt 例外。
    expect(
      entries.filter((c) => c.number >= 4 && c.key !== "answer-me-with-html:T51.4").every((c) => Boolean(c.prompt)),
    ).toBe(true)
  })
  test("answer-me-with-html固化源：bundle排除超限CLI，字节数与上限边界不变", () => {
    const b = bundle(path.join(root, "answer-me-with-html"), "answer-me-with-html")
    expect(b.resources).toEqual([])
    const am = readFileSync(path.join(root, "answer-me-with-html/scripts/am.mjs"))
    expect(am.length).toBe(306212)
    expect(am.length).toBeGreaterThan(256 * 1024)
    expect(readFileSync(path.join(root, "answer-me-with-html/SKILL.md")).length).toBeLessThanOrEqual(256 * 1024)
  })
  test("UI核心bundle按原文排除字体大文件并包含React数据", () => {
    const b = bundle(path.join(root, "ui-ux-pro-max"), "ui-ux-pro-max")
    expect(b.resources.some((r) => r.path === "data/stacks/react.csv")).toBe(true)
    expect(b.resources.some((r) => r.path.endsWith("google-fonts.csv"))).toBe(false)
    expect(b.resources.length).toBe(19)
  })
  test("加载断言按V2工具输入键id匹配，name键仅为兼容", () => {
    const events = [
      { type: "session.tool.input.started", data: { id: "a", name: "skill" } },
      { type: "session.tool.input.ended", data: { id: "a", text: JSON.stringify({ id: "grill-me" }) } },
      { type: "session.tool.success", data: { id: "a", content: [{ type: "text", text: "loaded" }] } },
    ]
    expect(assertSkillLoaded(events, "grill-me")).toBe("loaded")
    expect(() => assertSkillLoaded(events, "grilling")).toThrow()
  })
  test("加载断言根据工具call id关联，不把其他skill输出当成功", () => {
    const events = [
      { type: "session.tool.input.started", data: { id: "a", name: "skill" } },
      { type: "session.tool.input.ended", data: { id: "a", text: JSON.stringify({ name: "correct" }) } },
      { type: "session.tool.success", data: { id: "b", content: [{ type: "text", text: "wrong output" }] } },
    ]
    expect(() => assertSkillLoaded(events, "correct")).toThrow()
    events.push({
      type: "session.tool.success",
      data: { id: "a", content: [{ type: "text", text: "correct output" }] },
    })
    expect(assertSkillLoaded(events, "correct", true)).toBe("correct output")
  })
})
