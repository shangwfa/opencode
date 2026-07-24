import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef } from "../../src/effect/instance-ref"
import { SystemPrompt } from "../../src/session/system"
import { Skill } from "../../src/skill"
import { testEffect } from "../lib/effect"

const mockSkillLayer = Layer.succeed(
  Skill.Service,
  Skill.Service.of({
    get: () => Effect.succeed(undefined),
    require: (name: string) => Effect.fail(new Skill.NotFoundError({ name, available: [] })),
    all: () => Effect.succeed([]),
    dirs: () => Effect.succeed([]),
    available: () => Effect.succeed([]),
    sessionList: () => Effect.succeed([]),
    sessionCreate: () => Effect.die("not implemented"),
    sessionLoad: () => Effect.succeed([]),
    sessionUnload: () => Effect.void,
    sessionClear: () => Effect.void,
  } as any),
)

const mockModel = {
  api: { id: "claude-sonnet-4-20250514", npm: "@ai-sdk/anthropic" },
  providerID: "anthropic",
  id: "model-1",
} as any

const it = testEffect(
  LayerNode.compile(SystemPrompt.node).pipe(
    Layer.provide(mockSkillLayer),
    Layer.merge(Layer.mergeAll(LayerNode.compile(CrossSpawnSpawner.node), NodeFileSystem.layer)),
  ) as any,
)

function makeInstanceCtx(directory: string, worktree: string, vcs: "git" | "none" = "git") {
  return {
    directory,
    worktree,
    project: { id: "test", name: "test", path: worktree, vcs },
  } as any
}

describe("SystemPrompt.environment - sandbox path mapping", () => {
  it.live("maps host directory to /workspace", () =>
    Effect.gen(function* () {
      const ctx = makeInstanceCtx("/home/opencode/project", "/home/opencode/project")
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(mockModel).pipe(Effect.provideService(InstanceRef, ctx))

      expect(result[0]).toContain("Working directory: /workspace")
      expect(result[0]).toContain("Workspace root folder: /workspace")
      expect(result[0]).not.toContain("/home/opencode")
    }),
  )

  it.live("maps subdirectory to /workspace subpath", () =>
    Effect.gen(function* () {
      const ctx = makeInstanceCtx("/home/opencode/project/packages/app", "/home/opencode/project")
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(mockModel).pipe(Effect.provideService(InstanceRef, ctx))

      expect(result[0]).toContain("Working directory: /workspace/packages/app")
      expect(result[0]).toContain("Workspace root folder: /workspace")
      expect(result[0]).not.toContain("/home/opencode")
    }),
  )

  it.live("maps /workspace identity", () =>
    Effect.gen(function* () {
      const ctx = makeInstanceCtx("/workspace", "/workspace")
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(mockModel).pipe(Effect.provideService(InstanceRef, ctx))

      expect(result[0]).toContain("Working directory: /workspace")
      expect(result[0]).toContain("Workspace root folder: /workspace")
    }),
  )

  it.live("never leaks host paths in env block", () =>
    Effect.gen(function* () {
      const ctx = makeInstanceCtx("/home/opencode/project", "/home/opencode/project")
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(mockModel).pipe(Effect.provideService(InstanceRef, ctx))

      const envBlock = result[0]
      const envStart = envBlock.indexOf("<env>")
      const envEnd = envBlock.indexOf("</env>")
      const envContent = envBlock.slice(envStart, envEnd)

      expect(envContent).not.toContain("/home/opencode")
      expect(envContent).not.toContain("/tmp/")
    }),
  )

  it.live("preserves git status regardless of path mapping", () =>
    Effect.gen(function* () {
      const ctx = makeInstanceCtx("/home/opencode/project", "/home/opencode/project", "git")
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(mockModel).pipe(Effect.provideService(InstanceRef, ctx))

      expect(result[0]).toContain("Is directory a git repo: yes")
    }),
  )

  it.live("preserves non-git status", () =>
    Effect.gen(function* () {
      const ctx = makeInstanceCtx("/home/opencode/project", "/home/opencode/project", "none")
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(mockModel).pipe(Effect.provideService(InstanceRef, ctx))

      expect(result[0]).toContain("Is directory a git repo: no")
    }),
  )

  it.live("maps deeply nested directory", () =>
    Effect.gen(function* () {
      const ctx = makeInstanceCtx("/home/opencode/project/a/b/c", "/home/opencode/project")
      const svc = yield* SystemPrompt.Service
      const result = yield* svc.environment(mockModel).pipe(Effect.provideService(InstanceRef, ctx))

      expect(result[0]).toContain("Working directory: /workspace/a/b/c")
      expect(result[0]).toContain("Workspace root folder: /workspace")
    }),
  )
})
