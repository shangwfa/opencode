import { describe, expect } from "bun:test"
import path from "path"
import { Effect, FileSystem, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { NodeFileSystem } from "@effect/platform-node"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppFileSystem } from "@opencode-ai/core/filesystem"
import { Instruction } from "../../src/session/instruction"
import { MessageID } from "../../src/session/schema"
import { Global } from "@opencode-ai/core/global"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { TestConfig } from "../fixture/config"
import { toSandboxPath } from "../../src/tool/sandbox-path"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, NodeFileSystem.layer))

const configLayer = TestConfig.layer()

const instructionLayer = (global: Partial<Global.Interface>, flags: Partial<RuntimeFlags.Info> = {}) =>
  Instruction.layer.pipe(
    Layer.provide(configLayer),
    Layer.provide(AppFileSystem.defaultLayer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Global.layerWith(global)),
    Layer.provide(RuntimeFlags.layer(flags)),
  )

const provideInstruction =
  (global: Partial<Global.Interface>, flags?: Partial<RuntimeFlags.Info>) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    self.pipe(Effect.provide(instructionLayer(global, flags)))

const write = (filepath: string, content: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(path.dirname(filepath), { recursive: true })
    yield* fs.writeFileString(filepath, content)
  })

const tmpWithFiles = (files: Record<string, string>, git = false) =>
  Effect.gen(function* () {
    const dir = yield* tmpdirScoped({ git })
    const fs = yield* FileSystem.FileSystem
    yield* Effect.all(
      Object.entries(files).map(([file, content]) =>
        write(path.join(dir, file), content),
      ),
      { discard: true },
    )
    return dir
  })

describe("Instruction.system - sandbox path mapping (non-git, worktree=/)", () => {
  it.live("skips mapping when worktree is / (non-git project)", () =>
    Effect.gen(function* () {
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" })

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        expect(rules).toHaveLength(1)
        expect(rules[0]).toContain(`Instructions from: ${path.join(projectTmp, "AGENTS.md")}`)
        expect(rules[0]).not.toContain("/workspace/")
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: projectTmp, config: projectTmp }))
    }),
  )
})

describe("Instruction.system - sandbox path mapping (git repo)", () => {
  it.live("maps project AGENTS.md path to /workspace when git repo", () =>
    Effect.gen(function* () {
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Project Instructions" }, true)

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        expect(rules).toHaveLength(1)
        expect(rules[0]).toContain("Instructions from: /workspace/AGENTS.md")
        expect(rules[0]).toContain("# Project Instructions")
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: projectTmp, config: projectTmp }))
    }),
  )

  it.live("never leaks host paths in system output for git repo", () =>
    Effect.gen(function* () {
      const projectTmp = yield* tmpWithFiles({ "AGENTS.md": "# Instructions" }, true)

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const rules = yield* svc.system()
        for (const rule of rules) {
          expect(rule).not.toContain(projectTmp)
        }
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: projectTmp, config: projectTmp }))
    }),
  )
})

describe("Instruction.resolve - sandbox path mapping", () => {
  it.live("maps subdir AGENTS.md to /workspace in git repo", () =>
    Effect.gen(function* () {
      const projectTmp = yield* tmpWithFiles(
        {
          "subdir/AGENTS.md": "# Subdir Instructions",
          "subdir/nested/file.ts": "const x = 1",
        },
        true,
      )

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const results = yield* svc.resolve(
          [],
          path.join(projectTmp, "subdir", "nested", "file.ts"),
          MessageID.make("msg_resolve-path-1"),
        )
        expect(results).toHaveLength(1)
        expect(results[0].filepath).toBe(path.join(projectTmp, "subdir", "AGENTS.md"))
        expect(results[0].content).toContain("Instructions from: /workspace/subdir/AGENTS.md")
        expect(results[0].content).not.toContain(projectTmp)
        expect(results[0].content).toContain("# Subdir Instructions")
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: projectTmp, config: projectTmp }))
    }),
  )

  it.live("resolve preserves raw filepath for internal tracking", () =>
    Effect.gen(function* () {
      const projectTmp = yield* tmpWithFiles(
        {
          "subdir/AGENTS.md": "# Subdir Instructions",
          "subdir/nested/file.ts": "const x = 1",
        },
        true,
      )

      yield* Effect.gen(function* () {
        const svc = yield* Instruction.Service
        const results = yield* svc.resolve(
          [],
          path.join(projectTmp, "subdir", "nested", "file.ts"),
          MessageID.make("msg_resolve-path-2"),
        )
        expect(results).toHaveLength(1)
        expect(results[0].filepath).toBe(path.join(projectTmp, "subdir", "AGENTS.md"))
      }).pipe(provideInstance(projectTmp), provideInstruction({ home: projectTmp, config: projectTmp }))
    }),
  )
})
