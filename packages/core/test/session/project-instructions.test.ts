import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Instructions } from "@opencode/core/instructions/index"
import { SessionProjectInstructions } from "@opencode/core/session/project-instructions"

const succeed = <A>(value: A) => Effect.succeed(value) as Effect.Effect<A, Error>

const makeSandbox = (files: Record<string, string>) => ({
  enabled: true,
  fileRead: (_sessionID: string, path: string) =>
    path in files
      ? succeed(files[path])
      : (Effect.die(new Error(`missing: ${path}`)) as Effect.Effect<string | null, Error>),
})

const read = (list: Instructions.List) => Effect.runPromise(Instructions.read(list))

describe("SessionProjectInstructions", () => {
  test("reads the nearest-to-farthest AGENTS.md chain from the session sandbox", async () => {
    const list = SessionProjectInstructions.load({
      sessionID: "ses_test",
      directory: "/workspace",
      projectDirectory: "/",
      sandbox: makeSandbox({ "/workspace/AGENTS.md": "nearest", "/AGENTS.md": "root" }),
    })
    const entries = await read(list)
    expect(entries).toMatchObject([
      {
        key: SessionProjectInstructions.Key,
        value: [
          { path: "/workspace/AGENTS.md", content: "nearest" },
          { path: "/AGENTS.md", content: "root" },
        ],
      },
    ])
  })

  test("reports removed when the sandbox has no AGENTS.md", async () => {
    const list = SessionProjectInstructions.load({
      sessionID: "ses_test",
      directory: "/workspace",
      projectDirectory: "/",
      sandbox: makeSandbox({}),
    })
    const entries = await read(list)
    expect(entries).toMatchObject([{ key: SessionProjectInstructions.Key, value: Instructions.removed }])
  })

  test("a failing sandbox read skips that hop instead of failing the turn", async () => {
    const list = SessionProjectInstructions.load({
      sessionID: "ses_test",
      directory: "/workspace",
      projectDirectory: "/",
      sandbox: {
        enabled: true,
        fileRead: () => Effect.die(new Error("sandbox unreachable")) as Effect.Effect<string | null, Error>,
      },
    })
    const entries = await read(list)
    expect(entries).toMatchObject([{ key: SessionProjectInstructions.Key, value: Instructions.removed }])
  })

  test("a disabled provider contributes nothing", async () => {
    const list = SessionProjectInstructions.load({
      sessionID: "ses_test",
      directory: "/workspace",
      projectDirectory: "/",
      sandbox: { enabled: false, fileRead: () => Effect.die(new Error("disabled")) },
    })
    const entries = await read(list)
    expect(entries).toMatchObject([{ key: SessionProjectInstructions.Key, value: Instructions.removed }])
  })
})