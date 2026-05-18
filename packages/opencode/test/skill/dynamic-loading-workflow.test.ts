import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { SystemPrompt } from "../../src/session/system"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import path from "path"
import type { Agent } from "../../src/agent/agent"
import { Permission } from "../../src/permission"

const node = CrossSpawnSpawner.defaultLayer

// 提供 Skill + SystemPrompt 服务
const it = testEffect(Layer.mergeAll(Skill.defaultLayer, SystemPrompt.defaultLayer, node))

// 模拟一个允许所有技能的 Agent
const agent: Agent.Info = {
  name: "test-agent",
  mode: "primary",
  permission: [] as Permission.Ruleset,
} as Agent.Info

describe("动态加载技能并触发任务执行", () => {
  it.live("完整流程：加载技能 → 构建系统提示 → 模拟任务执行", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // ========== 步骤 1: 创建技能目录和 SKILL.md ==========
          const skillDir = path.join(dir, "my-skills", "code-reviewer")
          yield* Effect.promise(() =>
            Bun.write(
              path.join(skillDir, "SKILL.md"),
              `---
name: code-reviewer
description: 代码审查专家，擅长发现潜在问题和优化建议
---

# Code Reviewer Skill

你是代码审查专家。当你看到代码时：
1. 检查潜在的错误和边界情况
2. 提出性能优化建议
3. 关注安全漏洞
4. 建议更好的命名和结构

审查风格：直接、建设性、关注重点
`,
            ),
          )

          // ========== 步骤 2: 动态加载技能 ==========
          const skill = yield* Skill.Service
          const loaded = yield* skill.load(skillDir)

          // 验证技能已加载
          expect(loaded.length).toBe(1)
          expect(loaded[0].name).toBe("code-reviewer")
          expect(loaded[0].description).toBe("代码审查专家，擅长发现潜在问题和优化建议")

          // ========== 步骤 3: 验证技能在可用列表中 ==========
          const available = yield* skill.available()
          const found = available.find((s) => s.name === "code-reviewer")
          expect(found).toBeDefined()

          // ========== 步骤 4: 构建带预加载技能的系统提示 ==========
          const sys = yield* SystemPrompt.Service
          const systemPrompt = yield* sys.skills(agent, ["code-reviewer"])

          // 验证系统提示只包含轻量 manifest，完整内容由 skill tool 按需加载
          expect(systemPrompt).toBeDefined()
          expect(systemPrompt).toContain("<preloaded_skills>")
          expect(systemPrompt).toContain("<name>code-reviewer</name>")
          expect(systemPrompt).not.toContain("你是代码审查专家")
          expect(systemPrompt).not.toContain("审查风格：直接、建设性、关注重点")

          // ========== 步骤 5: 模拟任务执行 ==========
          // 在实际场景中，这个系统提示会发送给 LLM
          // 这里我们验证提示内容可以用于代码审查任务
          const mockCode = `
function divide(a, b) {
  return a / b
}
`

          // 验证系统提示包含足够信息引导模型调用 skill tool，而不是直接暴露完整内容
          const hasEnoughContext =
            systemPrompt!.includes("代码审查") &&
            systemPrompt!.includes("Use the skill tool") &&
            systemPrompt!.includes("<available_skills>")

          expect(hasEnoughContext).toBe(true)

          // ========== 步骤 6: 卸载技能 ==========
          yield* skill.unload("code-reviewer")

          // 验证已卸载
          const afterUnload = yield* skill.get("code-reviewer")
          expect(afterUnload).toBeUndefined()
        }),
      { git: true },
    ),
  )

  it.live("多技能加载：同时加载多个技能并选择使用", () =>
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          // 创建两个技能
          const reviewerDir = path.join(dir, "skills", "code-reviewer")
          const testDir = path.join(dir, "skills", "test-writer")

          yield* Effect.promise(() =>
            Bun.write(
              path.join(reviewerDir, "SKILL.md"),
              `---
name: code-reviewer
description: 代码审查专家
---
审查代码...
`,
            ),
          )

          yield* Effect.promise(() =>
            Bun.write(
              path.join(testDir, "SKILL.md"),
              `---
name: test-writer
description: 测试用例编写专家
---
编写测试...
`,
            ),
          )

          const skill = yield* Skill.Service

          // 加载技能目录（包含多个子技能）
          const loaded = yield* skill.load(path.join(dir, "skills"))

          // 验证两个技能都加载了
          expect(loaded.length).toBe(2)
          const names = loaded.map((s) => s.name).sort()
          expect(names).toEqual(["code-reviewer", "test-writer"])

          // 选择使用 code-reviewer 技能
          const sys = yield* SystemPrompt.Service
          const prompt = yield* sys.skills(agent, ["code-reviewer"])

          expect(prompt).toContain("<preloaded_skills>")
          expect(prompt).toContain("<name>code-reviewer</name>")
          expect(prompt).not.toContain("审查代码...")

          // 但可用列表中仍然有 test-writer
          expect(prompt).toContain("test-writer")
        }),
      { git: true },
    ),
  )

  it.live("技能不存在时优雅降级", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sys = yield* SystemPrompt.Service

          // 请求不存在的技能
          const prompt = yield* sys.skills(agent, ["non-existent-skill"])

          // 仍然返回有效的系统提示（不包含 skill_content）
          expect(prompt).toBeDefined()
          expect(prompt).not.toContain("<skill_content")
          expect(prompt).toContain("Skills provide specialized instructions")
        }),
      { git: true },
    ),
  )
})
